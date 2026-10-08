"""Build the Studio application: API, landing page, console, and static assets."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from comicsol_studio import __version__
from comicsol_studio.api import router
from comicsol_studio.config import StudioConfig
from comicsol_studio.errors import StudioError, error_response
from comicsol_studio.providers import Providers
from comicsol_studio.security import CsrfTokens, HostGuard
from comicsol_studio.service import Studio

WEB_DIR = Path(__file__).resolve().parent / "web"
CONSOLE_PATH = "/studio"


class RevalidatedStaticFiles(StaticFiles):
    """Serve assets so browsers revalidate every module (cheap ETag 304s after an upgrade)."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def _page(name: str) -> FileResponse:
    response = FileResponse(WEB_DIR / name, media_type="text/html")
    response.headers["Cache-Control"] = "no-cache"
    return response


def create_app(config: StudioConfig, *, providers: Providers | None = None) -> FastAPI:
    studio = Studio(config, providers=providers)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        studio.close()

    app = FastAPI(
        lifespan=lifespan,
        title="Comic Sol Studio",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = config
    app.state.studio = studio
    app.state.csrf = CsrfTokens(studio.store)

    @app.exception_handler(StudioError)
    async def studio_error(_: Request, error: StudioError) -> Response:
        return error_response(error.status, error.code, error.message, error.hint, error.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, error: RequestValidationError) -> Response:
        details = [
            ".".join(str(part) for part in item.get("loc", ())) + ": " + str(item.get("msg"))
            for item in error.errors()[:10]
        ]
        return error_response(422, "invalid_request", "Studio could not read that request.", None, details)

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(router)

    @app.get("/", include_in_schema=False)
    def landing() -> FileResponse:
        return _page("index.html")

    @app.get(CONSOLE_PATH, include_in_schema=False)
    def console_redirect() -> RedirectResponse:
        return RedirectResponse(f"{CONSOLE_PATH}/", status_code=307)

    @app.get(CONSOLE_PATH + "/{route:path}", include_in_schema=False)
    def console(route: str) -> FileResponse:
        del route  # client-side routes all load the same console shell
        return _page("studio.html")

    app.mount("/assets", RevalidatedStaticFiles(directory=str(WEB_DIR / "assets")), name="assets")
    app.add_middleware(HostGuard, allowed_hosts=config.allowed_hosts())
    return app
