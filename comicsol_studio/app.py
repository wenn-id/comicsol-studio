"""Build the Studio application: API, landing page, console, and static assets."""

from __future__ import annotations

import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response
from starlette.types import Scope

from comicsol_studio import __version__
from comicsol_studio.auth import AUTH_COOKIE, SESSION_SECONDS, Login, LoginGuard, LoginThrottled
from comicsol_studio.api import router
from comicsol_studio.config import ConfigError, StudioConfig
from comicsol_studio.errors import StudioError, error_response
from comicsol_studio.providers import Providers
from comicsol_studio.security import (
    CSRF_COOKIE, CsrfTokens, HostGuard, require_writer, same_origin,
)
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
    login = Login(config.data_root)
    if config.public_origin and not login.enabled:
        raise ConfigError("Set the Studio login with --set-login before enabling a public origin.")
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
    app.state.login = login

    def login_page(message: str = "", status: int = 200) -> HTMLResponse:
        token = app.state.csrf.issue()
        html = (WEB_DIR / "login.html").read_text(encoding="utf-8")
        html = html.replace("{{csrf}}", escape(token, quote=True)).replace("{{error}}", escape(message))
        response = HTMLResponse(html, status_code=status, headers={"Cache-Control": "no-store"})
        response.set_cookie(CSRF_COOKIE, token, httponly=True, samesite="strict",
                            secure=bool(config.public_origin), path="/")
        if status == 429:
            response.headers["Retry-After"] = "300"
        return response

    @app.get("/login", include_in_schema=False)
    def show_login(request: Request) -> Response:
        if not login.enabled or login.valid(request.cookies.get(AUTH_COOKIE, "")):
            return RedirectResponse("/studio/", status_code=303,
                                    headers={"Cache-Control": "no-store"})
        return login_page()

    @app.post("/login", include_in_schema=False)
    async def sign_in(request: Request) -> Response:
        if not login.enabled:
            return RedirectResponse("/studio/", status_code=303)
        if not same_origin(request, config):
            return login_page("Reload this page and try again.", 403)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 16 * 1024:
                return login_page("That sign-in request is too large.", 413)
        try:
            fields = parse_qs(body.decode("utf-8"), max_num_fields=4)
        except (UnicodeError, ValueError):
            return login_page("Reload this page and try again.", 400)
        csrf = fields.get("csrf", [""])[0]
        cookie = request.cookies.get(CSRF_COOKIE, "")
        if (not csrf or not hmac.compare_digest(csrf.encode(), cookie.encode())
                or not app.state.csrf.valid(csrf)):
            return login_page("Reload this page and try again.", 403)
        username = fields.get("username", [""])[0]
        password = fields.get("password", [""])[0]
        if len(username) > 80 or len(password) > 1024:
            return login_page("Username or password is incorrect.", 401)
        try:
            token = await run_in_threadpool(login.authenticate, username, password)
        except LoginThrottled:
            return login_page("Too many attempts. Try again in five minutes.", 429)
        if token is None:
            return login_page("Username or password is incorrect.", 401)
        response = RedirectResponse("/studio/", status_code=303,
                                    headers={"Cache-Control": "no-store"})
        response.set_cookie(AUTH_COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                            secure=bool(config.public_origin), samesite="strict", path="/")
        response.delete_cookie(CSRF_COOKIE, secure=bool(config.public_origin), samesite="strict")
        return response

    @app.post("/logout", include_in_schema=False)
    def sign_out(request: Request) -> Response:
        require_writer(request)
        login.revoke(request.cookies.get(AUTH_COOKIE, ""))
        response = RedirectResponse("/login", status_code=303,
                                    headers={"Cache-Control": "no-store"})
        response.delete_cookie(AUTH_COOKIE, secure=bool(config.public_origin),
                               httponly=True, samesite="strict")
        response.delete_cookie(CSRF_COOKIE, secure=bool(config.public_origin), samesite="strict")
        return response

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
        response = _page("studio.html")
        response.headers["Cache-Control"] = "no-store"
        return response

    app.mount("/assets", RevalidatedStaticFiles(directory=str(WEB_DIR / "assets")), name="assets")
    app.add_middleware(LoginGuard, login=login)
    app.add_middleware(HostGuard, allowed_hosts=config.allowed_hosts())
    return app
