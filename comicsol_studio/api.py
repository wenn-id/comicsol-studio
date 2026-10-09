"""Studio's HTTP API. Every route is a thin translation onto `Studio` service calls."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Header, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from comicsol_studio import rasters
from comicsol_studio.errors import invalid
from comicsol_studio.security import CSRF_COOKIE, require_writer
from comicsol_studio.service import Studio

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
NO_STORE = {"cache-control": "no-store"}


def studio(request: Request) -> Studio:
    return request.app.state.studio


def revision_header(x_revision: str | None = Header(default=None)) -> int:
    try:
        value = int(x_revision or "")
    except ValueError:
        raise invalid("Send the project revision you loaded in the X-Revision header.") from None
    if value < 1:
        raise invalid("The project revision must be a positive integer.")
    return value


def _json(value: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(value, status_code=status, headers=NO_STORE)


async def _read_limited(upload: UploadFile, limit: int, what: str) -> bytes:
    payload = await upload.read(limit + 1)
    if len(payload) > limit:
        raise invalid(f"The {what} is larger than {limit // (1024 * 1024)} MB.")
    return payload


def _provider(body: dict[str, Any]) -> str:
    provider = body.get("provider")
    if not isinstance(provider, str) or not provider:
        raise invalid("Choose a provider.")
    return provider


def _file(
    path, *, media_type: str | None = None, filename: str | None = None, immutable: bool = False
) -> FileResponse:
    """Revision-pinned URLs (`?r=`) never change, so the browser may keep them forever."""
    response = FileResponse(path, media_type=media_type, filename=filename)
    if filename is not None:
        response.headers["cache-control"] = "no-store"
    else:
        response.headers["cache-control"] = (
            "private, max-age=31536000, immutable" if immutable else "no-cache"
        )
    return response


router = APIRouter(prefix="/api", dependencies=[Depends(require_writer)])


@router.get("/session")
def session(request: Request) -> JSONResponse:
    token = request.app.state.csrf.issue()
    response = _json({"csrfToken": token, **studio(request).capabilities()})
    response.set_cookie(
        CSRF_COOKIE, token, httponly=False, samesite="strict", path="/",
        secure=bool(request.app.state.config.public_origin),
    )
    return response


@router.get("/engine")
def engine_info(request: Request) -> JSONResponse:
    """Public engine facts (version, page size, layouts) for the landing page."""
    capabilities = studio(request).capabilities()
    return _json({key: capabilities[key] for key in ("engine", "page", "layouts")})


@router.get("/starters")
def starters(request: Request) -> JSONResponse:
    return _json(studio(request).starters())


@router.get("/projects")
def list_projects(request: Request) -> JSONResponse:
    return _json(studio(request).list_projects())


@router.post("/projects")
def create_project(
    request: Request,
    body: dict[str, Any],
    idempotency_key: str | None = Header(default=None),
) -> JSONResponse:
    return _json(studio(request).create_project(body, idempotency_key), 201)


@router.post("/projects/import")
async def import_project(
    request: Request,
    archive: UploadFile = File(...),
    idempotency_key: str | None = Header(default=None),
) -> JSONResponse:
    payload = await _read_limited(archive, MAX_ARCHIVE_BYTES, "archive")
    service = studio(request)
    from starlette.concurrency import run_in_threadpool

    project = await run_in_threadpool(
        service.import_project, archive.filename or "", payload, idempotency_key
    )
    return _json(project, 201)


@router.get("/projects/{project_id}")
def get_project(request: Request, project_id: str) -> JSONResponse:
    return _json(studio(request).project(project_id))


@router.patch("/projects/{project_id}")
def rename_project(
    request: Request, project_id: str, body: dict[str, Any], revision: int = Depends(revision_header)
) -> JSONResponse:
    return _json(studio(request).rename(project_id, revision, body.get("title")))


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(request: Request, project_id: str) -> Response:
    studio(request).delete(project_id)
    return Response(status_code=204)


# plan ----------------------------------------------------------------------


@router.post("/projects/{project_id}/plan/validate")
def validate_plan(request: Request, project_id: str, body: dict[str, Any]) -> JSONResponse:
    return _json({"issues": studio(request).validate_plan(project_id, body.get("plan") or {})})


@router.put("/projects/{project_id}/plan")
def save_plan(
    request: Request, project_id: str, body: dict[str, Any], revision: int = Depends(revision_header)
) -> JSONResponse:
    plan = body.get("plan")
    if not isinstance(plan, dict):
        raise invalid("Send the plan documents.")
    return _json(studio(request).save_plan(project_id, revision, plan))


@router.post("/projects/{project_id}/plan/draft", status_code=202)
def draft_plan(
    request: Request, project_id: str, body: dict[str, Any], revision: int = Depends(revision_header)
) -> JSONResponse:
    return _json(studio(request).start_plan_draft(project_id, revision, _provider(body)), 202)


# render --------------------------------------------------------------------


@router.post("/projects/{project_id}/render/prepare")
def prepare(request: Request, project_id: str, revision: int = Depends(revision_header)) -> JSONResponse:
    return _json(studio(request).prepare(project_id, revision))


@router.post("/projects/{project_id}/render/jobs/{job_id}/upload")
async def upload(
    request: Request,
    project_id: str,
    job_id: str,
    image: UploadFile = File(...),
    revision: int = Depends(revision_header),
) -> JSONResponse:
    payload = await _read_limited(image, rasters.MAX_UPLOAD_BYTES, "image")
    from starlette.concurrency import run_in_threadpool

    project = await run_in_threadpool(
        studio(request).upload_raster, project_id, revision, job_id, payload
    )
    return _json(project)


@router.post("/projects/{project_id}/render/jobs/{job_id}/render", status_code=202)
def render_job(
    request: Request,
    project_id: str,
    job_id: str,
    body: dict[str, Any],
    revision: int = Depends(revision_header),
) -> JSONResponse:
    return _json(studio(request).render_job(project_id, revision, job_id, _provider(body)), 202)


@router.post("/projects/{project_id}/render/ready", status_code=202)
def render_ready(
    request: Request, project_id: str, body: dict[str, Any], revision: int = Depends(revision_header)
) -> JSONResponse:
    return _json(studio(request).render_ready(project_id, revision, _provider(body)), 202)


@router.post("/projects/{project_id}/render/jobs/{job_id}/candidate/approve")
def approve_candidate(
    request: Request, project_id: str, job_id: str, revision: int = Depends(revision_header)
) -> JSONResponse:
    return _json(studio(request).approve_candidate(project_id, revision, job_id))


@router.delete("/projects/{project_id}/render/jobs/{job_id}/candidate")
def discard_candidate(request: Request, project_id: str, job_id: str) -> JSONResponse:
    return _json(studio(request).discard_candidate(project_id, job_id))


@router.get("/projects/{project_id}/render/jobs/{job_id}/candidate.png")
def candidate(request: Request, project_id: str, job_id: str) -> FileResponse:
    response = FileResponse(studio(request).candidate_file(project_id, job_id), media_type="image/png")
    response.headers["cache-control"] = "no-store"
    return response


# review --------------------------------------------------------------------


@router.get("/projects/{project_id}/panels/{panel_id}/review")
def panel_review_context(request: Request, project_id: str, panel_id: str) -> JSONResponse:
    return _json(studio(request).panel_review_context(project_id, panel_id))


@router.post("/projects/{project_id}/panels/{panel_id}/review")
def review_panel(
    request: Request,
    project_id: str,
    panel_id: str,
    body: dict[str, Any],
    revision: int = Depends(revision_header),
) -> JSONResponse:
    return _json(studio(request).review_panel(project_id, revision, panel_id, body))


@router.post("/projects/{project_id}/panels/{panel_id}/review/auto", status_code=202)
def auto_review_panel(
    request: Request,
    project_id: str,
    panel_id: str,
    body: dict[str, Any],
    revision: int = Depends(revision_header),
) -> JSONResponse:
    return _json(
        studio(request).auto_review_panel(project_id, revision, panel_id, _provider(body)), 202
    )


@router.post("/projects/{project_id}/pages/compose")
def compose(request: Request, project_id: str, revision: int = Depends(revision_header)) -> JSONResponse:
    return _json(studio(request).compose(project_id, revision))


@router.get("/projects/{project_id}/pages/{number}/review")
def page_review_context(request: Request, project_id: str, number: int) -> JSONResponse:
    return _json(studio(request).page_review_context(project_id, number))


@router.post("/projects/{project_id}/pages/{number}/review")
def review_page(
    request: Request,
    project_id: str,
    number: int,
    body: dict[str, Any],
    revision: int = Depends(revision_header),
) -> JSONResponse:
    return _json(studio(request).review_page(project_id, revision, number, body))


@router.post("/projects/{project_id}/pages/{number}/review/auto", status_code=202)
def auto_review_page(
    request: Request,
    project_id: str,
    number: int,
    body: dict[str, Any],
    revision: int = Depends(revision_header),
) -> JSONResponse:
    return _json(
        studio(request).auto_review_page(project_id, revision, number, _provider(body)), 202
    )


@router.post("/projects/{project_id}/finalize")
def finalize(request: Request, project_id: str, revision: int = Depends(revision_header)) -> JSONResponse:
    return _json(studio(request).finalize(project_id, revision))


@router.post("/projects/{project_id}/exports/archive")
def export_archive(request: Request, project_id: str) -> FileResponse:
    path = studio(request).export_archive(project_id)
    return _file(path, media_type="application/octet-stream", filename=path.name)


# files, runs, activity ----------------------------------------------------


@router.get("/projects/{project_id}/files/{relative:path}")
def project_file(
    request: Request, project_id: str, relative: str, download: int = 0, r: int | None = None
) -> FileResponse:
    path = studio(request).file(project_id, relative)
    media_type = {".png": "image/png", ".pdf": "application/pdf", ".md": "text/markdown"}[path.suffix]
    if download:
        return _file(path, media_type=media_type, filename=path.name)
    return _file(path, media_type=media_type, immutable=r is not None)


@router.get("/projects/{project_id}/thumb/{relative:path}")
def thumbnail(request: Request, project_id: str, relative: str, w: int = 480) -> FileResponse:
    return _file(studio(request).thumbnail(project_id, relative, w), media_type="image/webp")


@router.get("/projects/{project_id}/runs/{run_id}")
def run(request: Request, project_id: str, run_id: str) -> JSONResponse:
    return _json(studio(request).run(project_id, run_id))


@router.get("/projects/{project_id}/activity")
def activity(request: Request, project_id: str) -> JSONResponse:
    return _json(studio(request).activity(project_id))


@router.get("/projects/{project_id}/validation")
def validation(request: Request, project_id: str) -> JSONResponse:
    return _json({"issues": studio(request).validation(project_id)})
