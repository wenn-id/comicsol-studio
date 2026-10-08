"""Compose the comicsol-studio interface on top of the comic-sol-web application.

The interface owns no API, session, or project logic. It is mounted beside the
unchanged comic-sol-web routes on the same origin, so the browser keeps using
the backend's CSRF cookie, revision guards, and its published `/static` browser
client (`api.js`, `state.js`, `webmcp.js`).
"""

from __future__ import annotations

from pathlib import Path

from comic_sol_web.app import STATIC_DIR, create_app
from comic_sol_web.config import WebConfig
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

UI_DIR = Path(__file__).resolve().parent / "ui"
UI_PATH = "/studio"

# Browser modules the interface imports from the backend's static mount. The
# launcher refuses to start when the installed comic-sol-web lacks one of them.
BACKEND_MODULES = ("api.js", "state.js", "webmcp.js")


class MissingBackendModuleError(RuntimeError):
    """The installed comic-sol-web does not publish a required browser module."""


class RevalidatedStaticFiles(StaticFiles):
    """Serve the interface so browsers revalidate every module.

    Without an explicit policy a browser may run a heuristically cached older
    module beside newer ones after an upgrade. `no-cache` keeps ETag 304s cheap.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def missing_backend_modules(static_dir: Path = STATIC_DIR) -> tuple[str, ...]:
    return tuple(name for name in BACKEND_MODULES if not (static_dir / name).is_file())


def create_studio_app(
    config: WebConfig,
    *,
    active_agent_image_capabilities: frozenset[str] = frozenset(),
) -> FastAPI:
    missing = missing_backend_modules()
    if missing:
        raise MissingBackendModuleError(
            "comic-sol-web is missing browser modules: " + ", ".join(missing)
        )
    app = create_app(config, active_agent_image_capabilities=active_agent_image_capabilities)

    @app.get("/", include_in_schema=False)
    def studio_root() -> RedirectResponse:
        return RedirectResponse(f"{UI_PATH}/", status_code=307)

    app.mount(UI_PATH, RevalidatedStaticFiles(directory=str(UI_DIR), html=True), name="comicsol-studio")
    return app
