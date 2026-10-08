"""Studio's application layer: projects, revisions, background runs, and every creator action.

Each project lives in its own container under `<data_root>/projects/<id>/`, where the engine
publishes its project directory. SQLite records Studio's view of it: a display title, a
revision counter, and a fingerprint of the files. Any change on disk (from Studio, the
engine CLI, or an agent) advances the revision, so every write is bound to the revision
the creator saw.
"""

from __future__ import annotations

import hashlib
import io
import secrets
import shutil
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from PIL import Image

from comicsol_studio import engine, rasters
from comicsol_studio.config import StudioConfig
from comicsol_studio.engine import EngineInputError
from comicsol_studio.errors import StudioError, conflict, invalid, not_found, stale_revision
from comicsol_studio.providers import Providers, ProviderError, review_page, review_panel
from comicsol_studio.providers.planning import PlanRequest, draft_plan
from comicsol_studio.store import Store

LANGUAGE_MAX = 35
TITLE_MAX = 120
SOURCE_MAX_BYTES = 200 * 1024
SERVABLE_PREFIXES = ("panels/", "references/", "pages/", "exports/", "qa/report.md")
SERVABLE_SUFFIXES = (".png", ".pdf", ".md")
THUMB_WIDTHS = (240, 480, 960)
CREATOR = "creator"
UPLOAD_EXECUTOR = "comicsol-studio-upload"


def _now() -> float:
    return time.time()


class Studio:
    def __init__(
        self,
        config: StudioConfig,
        *,
        store: Store | None = None,
        providers: Providers | None = None,
        workers: int = 2,
    ) -> None:
        self.config = config
        for directory in (
            config.data_root,
            config.projects_root,
            config.staging_root,
            config.exports_root,
            config.trash_root,
            config.data_root / "cache",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self.store = store or Store(config.database_path)
        self.providers = providers if providers is not None else Providers.from_keys(config.keys)
        self._locks: dict[str, threading.RLock] = {}
        self._snapshots: dict[str, tuple[tuple[Any, ...], dict[str, Any]]] = {}
        self._locks_guard = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="studio-run")

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ #
    # Registry and revisions
    # ------------------------------------------------------------------ #

    def _lock(self, project_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(project_id, threading.RLock())

    def _row(self, project_id: str) -> Mapping[str, Any]:
        if not isinstance(project_id, str) or len(project_id) != 24 or not project_id.isalnum():
            raise not_found()
        with self.store.read() as db:
            row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise not_found()
        return dict(row)

    def _root(self, row: Mapping[str, Any]) -> Path:
        root = self.config.projects_root / row["storage_name"]
        if not (root / "project.json").is_file():
            raise StudioError(
                410, "project_missing", "This project's files are no longer on disk."
            )
        return root

    def _sync(self, project_id: str, root: Path) -> int:
        token = engine.fingerprint(root)
        with self.store.transaction() as db:
            row = db.execute(
                "SELECT revision, fingerprint FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if row is None:
                raise not_found()
            if row["fingerprint"] == token:
                return int(row["revision"])
            revision = int(row["revision"]) + 1
            db.execute(
                "UPDATE projects SET revision = ?, fingerprint = ?, updated_at = ? WHERE id = ?",
                (revision, token, _now(), project_id),
            )
            return revision

    @contextmanager
    def _project(self, project_id: str, expected: int | None) -> Iterator[Path]:
        """Serialize one creator action on a project and bind it to a revision."""
        row = self._row(project_id)
        with self._lock(project_id):
            root = self._root(row)
            revision = self._sync(project_id, root)
            if expected is not None and expected != revision:
                raise stale_revision(expected, revision)
            try:
                yield root
            except EngineInputError as error:
                raise invalid(str(error), error.issues) from error
            except TimeoutError as error:
                raise conflict(
                    "project_busy",
                    "Another program is working on this project right now.",
                    "Try again in a moment.",
                ) from error
            except (ValueError, TypeError) as error:
                raise invalid("The engine refused this action.", (str(error),)) from error
            finally:
                self._sync(project_id, root)

    def _register(self, root: Path, title: str, project_id: str, key: str | None) -> str:
        storage_name = root.relative_to(self.config.projects_root).as_posix()
        now = _now()
        with self.store.transaction() as db:
            if key is not None:
                existing = db.execute(
                    "SELECT project_id FROM creations WHERE idempotency_key = ?", (key,)
                ).fetchone()
                if existing is not None:
                    return str(existing["project_id"])
            db.execute(
                "INSERT INTO projects (id, storage_name, title, created_at, updated_at, "
                "revision, fingerprint) VALUES (?, ?, ?, ?, ?, 1, ?)",
                (project_id, storage_name, title, now, now, engine.fingerprint(root)),
            )
            if key is not None:
                db.execute(
                    "INSERT INTO creations (idempotency_key, project_id) VALUES (?, ?)",
                    (key, project_id),
                )
        return project_id

    def _existing_creation(self, key: str | None) -> str | None:
        if key is None:
            return None
        with self.store.read() as db:
            row = db.execute(
                "SELECT project_id FROM creations WHERE idempotency_key = ?", (key,)
            ).fetchone()
        return None if row is None else str(row["project_id"])

    @staticmethod
    def _idempotency_key(value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return str(uuid.UUID(value))
        except ValueError:
            raise invalid("The Idempotency-Key header must be a UUID.") from None

    def _create(
        self,
        key: str | None,
        title: str,
        build: Callable[[Path], Path],
        event: str,
    ) -> dict[str, Any]:
        key = self._idempotency_key(key)
        existing = self._existing_creation(key)
        if existing is not None:
            return self.project(existing)
        project_id = secrets.token_hex(12)
        container = self.config.projects_root / project_id
        container.mkdir()
        try:
            root = build(container)
            winner = self._register(root, title, project_id, key)
        except EngineInputError as error:
            shutil.rmtree(container, ignore_errors=True)
            raise invalid(str(error), error.issues) from error
        except (ValueError, TypeError) as error:
            shutil.rmtree(container, ignore_errors=True)
            raise invalid("The engine refused this project.", (str(error),)) from error
        except BaseException:
            shutil.rmtree(container, ignore_errors=True)
            raise
        if winner != project_id:
            shutil.rmtree(container, ignore_errors=True)
            return self.project(winner)
        self.store.add_event(project_id, "project.created", event)
        return self.project(project_id)

    # ------------------------------------------------------------------ #
    # Session-level information
    # ------------------------------------------------------------------ #

    def capabilities(self) -> dict[str, Any]:
        width, height = engine.page_size()
        return {
            "engine": {"name": "comic-sol", "version": engine.engine_version()},
            "providers": self.providers.describe(),
            "upload": {"maxBytes": rasters.MAX_UPLOAD_BYTES, "formats": ["png", "jpeg", "webp"]},
            "page": {"width": width, "height": height},
            "layouts": engine.layouts(),
            "checks": engine.check_catalog(),
            "archiveSuffix": engine.archive_suffix(),
            "limits": {"pages": [1, 4], "panels": 12, "sourceBytes": SOURCE_MAX_BYTES},
        }

    def starters(self) -> list[dict[str, Any]]:
        return engine.starters()

    # ------------------------------------------------------------------ #
    # Projects
    # ------------------------------------------------------------------ #

    def create_project(self, payload: Mapping[str, Any], key: str | None) -> dict[str, Any]:
        starter = payload.get("starter")
        if starter is not None:
            if set(payload) - {"starter"}:
                raise invalid("A starter project takes no other fields.")
            ids = {entry["id"] for entry in engine.starters()}
            if starter not in ids:
                raise invalid("That starter is not in the engine catalog.")
            title = next(entry["title"] for entry in engine.starters() if entry["id"] == starter)
            return self._create(
                key,
                str(title),
                lambda container: engine.init_starter(container, str(starter)),
                f"Started from the engine's {starter} starter.",
            )
        allowed = {"title", "prompt", "language", "mode", "pageCount"}
        if set(payload) - allowed:
            raise invalid("The request has fields Studio does not accept.")
        title = payload.get("title")
        prompt = payload.get("prompt")
        language = payload.get("language", "en")
        mode = payload.get("mode", "short_prompt")
        page_count = payload.get("pageCount", 2)
        if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX:
            raise invalid(f"Give the comic a title of at most {TITLE_MAX} characters.")
        if not isinstance(prompt, str) or not prompt.strip():
            raise invalid("Describe the comic you want to make.")
        if len(prompt.encode("utf-8")) > SOURCE_MAX_BYTES:
            raise invalid("The story is longer than the engine's 200 KB source limit.")
        if not isinstance(language, str) or not language.strip() or len(language) > LANGUAGE_MAX:
            raise invalid("Choose a language tag such as en or id.")
        if mode not in {"short_prompt", "pasted_story"}:
            raise invalid("Mode must be a short prompt or a pasted story.")
        if isinstance(page_count, bool) or not isinstance(page_count, int) or not 1 <= page_count <= 4:
            raise invalid("A comic has 1 to 4 pages.")
        return self._create(
            key,
            title.strip(),
            lambda container: engine.init_project(
                container,
                title=title.strip(),
                source=prompt,
                language=language.strip(),
                mode=mode,
                page_count=page_count,
            ),
            "Created from a prompt." if mode == "short_prompt" else "Created from a pasted story.",
        )

    def import_project(self, filename: str, payload: bytes, key: str | None) -> dict[str, Any]:
        suffix = engine.archive_suffix()
        if not filename.endswith(suffix):
            raise invalid(f"Choose a Comic Sol archive ending in {suffix}.")
        staging = self.config.staging_root / f"import-{secrets.token_hex(8)}{suffix}"
        staging.write_bytes(payload)
        try:
            return self._create(
                key,
                Path(filename).name[: -len(suffix)][:TITLE_MAX] or "Imported comic",
                lambda container: engine.import_archive(staging, container),
                f"Imported from {Path(filename).name}.",
            )
        finally:
            staging.unlink(missing_ok=True)

    def list_projects(self) -> list[dict[str, Any]]:
        with self.store.read() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY updated_at DESC")]
        projects = []
        for row in rows:
            try:
                root = self._root(row)
                revision = self._sync(row["id"], root)
                manifest = engine.manifest(root)
                summary = engine.status_summary(root)
            except (StudioError, OSError, ValueError):
                projects.append(
                    {"id": row["id"], "title": row["title"], "status": "UNREADABLE", "revision": row["revision"]}
                )
                continue
            settings = manifest.get("settings") or {}
            projects.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "status": manifest.get("status"),
                    "revision": revision,
                    "createdAt": row["created_at"],
                    "updatedAt": self._row(row["id"])["updated_at"],
                    "pageCount": settings.get("page_count"),
                    "panelCount": settings.get("panel_count"),
                    "panels": summary.get("panels"),
                    "thumbnail": self._thumbnail(root),
                }
            )
        return projects

    def project(self, project_id: str) -> dict[str, Any]:
        row = self._row(project_id)
        with self._lock(project_id):
            root = self._root(row)
            revision = self._sync(project_id, root)
            row = self._row(project_id)
            key = (revision, row["title"], row["updated_at"])
            cached = self._snapshots.get(project_id)
            if cached is None or cached[0] != key:
                cached = (key, self._snapshot(row, root, revision))
                self._snapshots[project_id] = cached
        # Runs and reference candidates live outside the project files, so they are read fresh.
        snapshot = cached[1]
        generation = {
            **snapshot["generation"],
            "jobs": [
                {**job, "candidate": self._candidate_path(project_id, job["jobId"]).is_file()}
                for job in snapshot["generation"]["jobs"]
            ],
        }
        return {**snapshot, "generation": generation, "runs": self.store.runs(project_id, limit=40)}

    def rename(self, project_id: str, revision: int, title: str) -> dict[str, Any]:
        if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX:
            raise invalid(f"Give the comic a title of at most {TITLE_MAX} characters.")
        with self._project(project_id, revision):
            with self.store.transaction() as db:
                db.execute(
                    "UPDATE projects SET title = ?, updated_at = ? WHERE id = ?",
                    (title.strip(), _now(), project_id),
                )
        return self.project(project_id)

    def delete(self, project_id: str) -> None:
        row = self._row(project_id)
        with self._lock(project_id):
            container = self.config.projects_root / project_id
            if container.exists():
                destination = self.config.trash_root / f"{project_id}-{int(_now())}"
                shutil.move(str(container), str(destination))
            with self.store.transaction() as db:
                db.execute("DELETE FROM projects WHERE id = ?", (row["id"],))

    # ------------------------------------------------------------------ #
    # Snapshot
    # ------------------------------------------------------------------ #

    def _file_url(self, project_id: str, revision: int, relative: str) -> str:
        return f"/api/projects/{project_id}/files/{relative}?r={revision}"

    def _thumbnail(self, root: Path) -> str | None:
        project_id = root.parent.name
        for candidate in ("pages/page-001.png",):
            if engine.exists(root, candidate):
                return f"/api/projects/{project_id}/thumb/{candidate}?w=480"
        panels = sorted((root / "panels" / "raw").glob("*.png")) if (root / "panels/raw").is_dir() else []
        if panels:
            return f"/api/projects/{project_id}/thumb/panels/raw/{panels[0].name}?w=480"
        return None

    def _snapshot(self, row: Mapping[str, Any], root: Path, revision: int) -> dict[str, Any]:
        project_id = row["id"]
        manifest = engine.manifest(root)
        summary = engine.status_summary(root)
        plan = engine.plan_documents(root)
        storyboard = plan.get("storyboard")
        request = engine.read_json(root, "source/request.json") if engine.exists(root, "source/request.json") else {}
        source = engine.read_bytes(root, "source/input.txt").decode("utf-8") if engine.exists(root, "source/input.txt") else ""
        url = lambda relative: self._file_url(project_id, revision, relative)  # noqa: E731

        inspection = engine.inspect_generation(root)
        jobs = []
        if inspection.get("prepared"):
            states = {state["job_id"]: state for state in inspection.get("jobs", [])}
            for brief in engine.job_briefs(root, inspection):
                state = states.get(brief.job_id, {})
                jobs.append(
                    {
                        "jobId": brief.job_id,
                        "kind": brief.subject_kind,
                        "subjectId": brief.subject_id,
                        "status": brief.status,
                        "attempt": brief.attempt,
                        "attemptsUsed": state.get("attempts_used"),
                        "attemptsRemaining": state.get("attempts_remaining"),
                        "width": brief.width,
                        "height": brief.height,
                        "exactSize": brief.exact_dimensions,
                        "prompt": brief.prompt,
                        "references": [url(path) for path in brief.references],
                    }
                )

        panels = []
        for page in (storyboard or {}).get("pages") or []:
            for panel in page.get("panels") or []:
                panel_id = panel["id"]
                raw = f"panels/raw/{panel_id}.png"
                lettered = f"panels/{panel_id}/lettered.png"
                panels.append(
                    {
                        "id": panel_id,
                        "page": page.get("number"),
                        "order": panel.get("order"),
                        "rect": panel.get("rect"),
                        "image": url(raw) if engine.exists(root, raw) else None,
                        "lettered": url(lettered) if engine.exists(root, lettered) else None,
                        "decision": engine.panel_decision(root, panel_id)
                        if engine.exists(root, raw)
                        else None,
                    }
                )

        references = []
        for character in (plan.get("characterBible") or {}).get("characters") or []:
            path = f"references/characters/{character.get('id')}.png"
            references.append(
                {
                    "characterId": character.get("id"),
                    "name": character.get("name"),
                    "image": url(path) if engine.exists(root, path) else None,
                }
            )

        page_count = (manifest.get("settings") or {}).get("page_count") or 0
        pages = []
        for number in range(1, page_count + 1):
            image = f"pages/page-{number:03d}.png"
            record_path = f"qa/pages/page-{number:03d}.json"
            record = engine.read_json(root, record_path) if engine.exists(root, record_path) else None
            pages.append(
                {
                    "number": number,
                    "image": url(image) if engine.exists(root, image) else None,
                    "decision": None if record is None else record.get("decision"),
                }
            )

        pdf = f"exports/{manifest.get('project_id')}.pdf"
        return {
            "id": project_id,
            "title": row["title"],
            "revision": revision,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "status": manifest.get("status"),
            "engineProjectId": manifest.get("project_id"),
            "engineTitle": manifest.get("title"),
            "settings": manifest.get("settings"),
            "warnings": manifest.get("warnings") or [],
            "blockedReason": manifest.get("blocked_reason"),
            "summary": summary,
            "source": {
                "text": source,
                "mode": request.get("mode"),
                "language": request.get("language"),
            },
            "plan": plan,
            "generation": {
                "prepared": bool(inspection.get("prepared")),
                "phase": inspection.get("phase"),
                "nextAction": inspection.get("next_action"),
                "scopeState": inspection.get("scope_state"),
                "jobs": jobs,
            },
            "panels": panels,
            "references": references,
            "pages": pages,
            "pagesReviewed": bool(pages) and all(page["decision"] in {"accept", "accept-warning"} for page in pages),
            "exports": {
                "pdf": url(pdf) if engine.exists(root, pdf) else None,
                "report": url("qa/report.md") if engine.exists(root, "qa/report.md") else None,
            },
            "thumbnail": self._thumbnail(root),
        }

    # ------------------------------------------------------------------ #
    # Files
    # ------------------------------------------------------------------ #

    def file(self, project_id: str, relative: str) -> Path:
        row = self._row(project_id)
        root = self._root(row)
        if not relative.startswith(SERVABLE_PREFIXES) or not relative.endswith(SERVABLE_SUFFIXES):
            raise not_found("file")
        try:
            path = engine.contained(root, relative, must_exist=True)
        except (OSError, ValueError):
            raise not_found("file") from None
        if not path.is_file():
            raise not_found("file")
        return path

    def thumbnail(self, project_id: str, relative: str, width: int) -> Path:
        if width not in THUMB_WIDTHS:
            raise invalid("Thumbnail width must be 240, 480, or 960.")
        source = self.file(project_id, relative)
        if source.suffix != ".png":
            raise not_found("file")
        info = source.stat()
        key = hashlib.sha256(f"{source}\0{info.st_size}\0{info.st_mtime_ns}\0{width}".encode()).hexdigest()
        target = self.config.data_root / "cache" / f"{key}.webp"
        if not target.is_file():
            with Image.open(source) as image:
                image = image.convert("RGB")
                ratio = width / image.width
                image = image.resize((width, max(1, round(image.height * ratio))), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, format="WEBP", quality=82, method=4)
            temporary = target.with_suffix(".tmp")
            temporary.write_bytes(buffer.getvalue())
            temporary.replace(target)
        return target

    # ------------------------------------------------------------------ #
    # Plan
    # ------------------------------------------------------------------ #

    def validate_plan(self, project_id: str, documents: Mapping[str, Any]) -> list[str]:
        self._row(project_id)
        return engine.validate_plan(documents)

    def save_plan(self, project_id: str, revision: int, documents: Mapping[str, Any]) -> dict[str, Any]:
        with self._project(project_id, revision) as root:
            engine.publish_plan(root, documents)
        self.store.add_event(project_id, "plan.saved", "Saved the plan; the engine validated it.")
        return self.project(project_id)

    def start_plan_draft(self, project_id: str, revision: int, provider_id: str) -> dict[str, Any]:
        model = self._text_model(provider_id)
        with self._project(project_id, revision) as root:
            manifest = engine.manifest(root)
            request_doc = engine.read_json(root, "source/request.json")
            request = PlanRequest(
                title=self._row(project_id)["title"],
                source=engine.read_bytes(root, "source/input.txt").decode("utf-8"),
                language=str(request_doc.get("language") or "en"),
                page_count=int((manifest.get("settings") or {}).get("page_count") or 2),
            )

        def work(run_id: str) -> dict[str, Any]:
            def progress(round_number: int, issues: list[str]) -> None:
                if issues and round_number < 2:
                    self.store.update_run(
                        run_id, "running", f"Repairing {len(issues)} validation issues (round {round_number + 1})."
                    )

            documents, issues = draft_plan(request, model.complete_json, on_round=progress)
            if issues:
                raise ProviderError(
                    f"The draft still had {len(issues)} validation issues after repair. "
                    "Open it to fix them by hand."
                )
            self.store.add_event(project_id, "plan.drafted", f"{provider_id} drafted a plan for review.")
            return {"documents": documents, "issues": issues}

        return self._submit(project_id, "plan-draft", "plan", provider_id, work)

    # ------------------------------------------------------------------ #
    # Rendering
    # ------------------------------------------------------------------ #

    def prepare(self, project_id: str, revision: int) -> dict[str, Any]:
        with self._project(project_id, revision) as root:
            result = engine.prepare_generation(root)
        phase = result.get("phase")
        self.store.add_event(
            project_id,
            "render.prepared",
            f"The engine prepared {result.get('job_counts', {}).get('ready', 0)} {phase} jobs.",
        )
        return self.project(project_id)

    def _candidate_path(self, project_id: str, job_id: str) -> Path:
        return self.config.staging_root / project_id / f"{job_id}.png"

    def _accept(
        self,
        project_id: str,
        root: Path,
        job_id: str,
        png: bytes,
        *,
        executor_id: str,
        provider: str | None,
        model: str | None,
        used_references: bool,
    ) -> dict[str, Any]:
        staging = self.config.staging_root / project_id
        staging.mkdir(parents=True, exist_ok=True)
        raster = staging / f"accept-{secrets.token_hex(8)}.png"
        raster.write_bytes(png)
        try:
            return engine.accept_raster(
                root,
                job_id,
                raster,
                executor_id=executor_id,
                provider=provider,
                model=model,
                used_references=used_references,
            )
        finally:
            raster.unlink(missing_ok=True)

    def upload_raster(self, project_id: str, revision: int, job_id: str, payload: bytes) -> dict[str, Any]:
        with self._project(project_id, revision) as root:
            brief = engine.job_brief(root, job_id)
            try:
                conformed = rasters.conform(
                    payload, width=brief.width, height=brief.height, exact=brief.exact_dimensions
                )
            except rasters.RasterError as error:
                raise invalid(str(error)) from error
            self._accept(
                project_id,
                root,
                job_id,
                conformed.png,
                executor_id=UPLOAD_EXECUTOR,
                provider=None,
                model=None,
                used_references=False,
            )
            self._candidate_path(project_id, job_id).unlink(missing_ok=True)
        what = "reference" if brief.subject_kind == "reference" else "panel"
        note = " (center-cropped to the panel's shape)" if conformed.cropped else ""
        self.store.add_event(
            project_id, "render.uploaded", f"Uploaded the {what} image for {brief.subject_id}{note}."
        )
        return self.project(project_id)

    def approve_candidate(self, project_id: str, revision: int, job_id: str) -> dict[str, Any]:
        candidate = self._candidate_path(project_id, job_id)
        if not candidate.is_file():
            raise not_found("candidate")
        run = next(
            (
                item
                for item in self.store.runs(project_id)
                if item["kind"] == "render" and item["subject"] == job_id and item["status"] == "succeeded"
            ),
            None,
        )
        result = (run or {}).get("result") or {}
        with self._project(project_id, revision) as root:
            brief = engine.job_brief(root, job_id)
            self._accept(
                project_id,
                root,
                job_id,
                candidate.read_bytes(),
                executor_id=f"comicsol-studio-{result.get('provider', 'model')}",
                provider=result.get("provider"),
                model=result.get("model"),
                used_references=bool(result.get("usedReferences")),
            )
            candidate.unlink(missing_ok=True)
        self.store.add_event(project_id, "render.approved", f"Approved the reference for {brief.subject_id}.")
        return self.project(project_id)

    def discard_candidate(self, project_id: str, job_id: str) -> dict[str, Any]:
        self._row(project_id)
        self._candidate_path(project_id, job_id).unlink(missing_ok=True)
        return self.project(project_id)

    def candidate_file(self, project_id: str, job_id: str) -> Path:
        self._row(project_id)
        path = self._candidate_path(project_id, job_id)
        if len(job_id) != 64 or not path.is_file():
            raise not_found("candidate")
        return path

    def _render_one(self, project_id: str, job_id: str, provider_id: str) -> dict[str, Any]:
        """Render one job with a provider. Panels are accepted; references wait for approval."""
        model = self.providers.image_model(provider_id)
        row = self._row(project_id)
        with self._lock(project_id):
            root = self._root(row)
            brief = engine.job_brief(root, job_id)
            if brief.status != "ready":
                raise ProviderError(f"This job is {brief.status}; nothing to render.")
            references = tuple(engine.read_bytes(root, path) for path in brief.references)
        payload = model.render(
            brief.prompt, width=brief.width, height=brief.height, references=references
        )
        try:
            conformed = rasters.conform(
                payload, width=brief.width, height=brief.height, exact=brief.exact_dimensions
            )
        except rasters.RasterError as error:
            raise ProviderError(f"The provider's image could not be used: {error}") from error
        result = {
            "provider": provider_id,
            "model": model.image_model,
            "usedReferences": bool(references),
            "subjectKind": brief.subject_kind,
            "subjectId": brief.subject_id,
        }
        if brief.subject_kind == "reference":
            candidate = self._candidate_path(project_id, job_id)
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_bytes(conformed.png)
            self.store.add_event(
                project_id,
                "render.candidate",
                f"{provider_id} drew a reference for {brief.subject_id}; it waits for your approval.",
            )
            return {**result, "candidate": True}
        with self._project(project_id, None) as root:
            current = engine.job_brief(root, job_id)
            if current.status != "ready" or current.attempt != brief.attempt:
                raise ProviderError("The job changed while it was rendering; nothing was accepted.")
            self._accept(
                project_id,
                root,
                job_id,
                conformed.png,
                executor_id=f"comicsol-studio-{provider_id}",
                provider=provider_id,
                model=model.image_model,
                used_references=bool(references),
            )
        self.store.add_event(
            project_id, "render.accepted", f"{provider_id} rendered panel {brief.subject_id}."
        )
        return {**result, "candidate": False}

    def render_job(self, project_id: str, revision: int, job_id: str, provider_id: str) -> dict[str, Any]:
        if provider_id not in self.providers.images:
            self._missing(provider_id)
        with self._project(project_id, revision) as root:
            brief = engine.job_brief(root, job_id)
            if brief.status != "ready":
                raise invalid(f"This job is {brief.status}; nothing to render.")
        return self._submit(
            project_id, "render", job_id, provider_id, lambda run_id: self._render_one(project_id, job_id, provider_id)
        )

    def render_ready(self, project_id: str, revision: int, provider_id: str) -> dict[str, Any]:
        """Render every ready job of the current phase, one after another, in one run."""
        if provider_id not in self.providers.images:
            self._missing(provider_id)
        with self._project(project_id, revision) as root:
            ready = [
                brief.job_id
                for brief in engine.job_briefs(root)
                if brief.status == "ready" and not self._candidate_path(project_id, brief.job_id).is_file()
            ]
        if not ready:
            raise invalid("No render job is ready. Prepare jobs first.")

        def work(run_id: str) -> dict[str, Any]:
            done, failed = 0, []
            for index, job_id in enumerate(ready, start=1):
                self.store.update_run(run_id, "running", f"Rendering {index} of {len(ready)}.")
                try:
                    self._render_one(project_id, job_id, provider_id)
                    done += 1
                except (ProviderError, StudioError) as error:
                    failed.append(getattr(error, "message", str(error)))
            if failed and not done:
                raise ProviderError(failed[0])
            return {"rendered": done, "failed": len(failed), "messages": failed[:5]}

        return self._submit(project_id, "render-batch", "ready", provider_id, work)

    # ------------------------------------------------------------------ #
    # Review
    # ------------------------------------------------------------------ #

    def panel_review_context(self, project_id: str, panel_id: str) -> dict[str, Any]:
        with self._project(project_id, None) as root:
            return engine.panel_review_context(root, panel_id)

    def review_panel(self, project_id: str, revision: int, panel_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        checks = payload.get("checks")
        assessments = payload.get("assessments", [])
        if not isinstance(checks, list) or not isinstance(assessments, list):
            raise invalid("A panel review needs checks and character assessments.")
        with self._project(project_id, revision) as root:
            record = engine.publish_panel_review(
                root, panel_id, checks, assessments, method=engine.PANEL_REVIEW_METHOD, reviewer=CREATOR
            )
        self._review_event(project_id, panel_id, record["decision"], CREATOR)
        return self.project(project_id)

    def _review_event(self, project_id: str, subject: str, decision: str, reviewer: str) -> None:
        words = {
            "accept": "accepted",
            "accept-warning": "accepted with warnings",
            "regenerate": "sent back to render",
        }
        self.store.add_event(
            project_id, "review.recorded", f"{subject} {words.get(decision, decision)} by {reviewer}."
        )

    def auto_review_panel(self, project_id: str, revision: int, panel_id: str, provider_id: str) -> dict[str, Any]:
        model = self._text_model(provider_id)
        with self._project(project_id, revision) as root:
            context = engine.panel_review_context(root, panel_id)
            raster = engine.read_bytes(root, f"panels/raw/{panel_id}.png")
        reviewer = self.providers.reviewer_name(provider_id)

        def work(run_id: str) -> dict[str, Any]:
            checks, assessments = review_panel(model, context, raster)
            with self._project(project_id, None) as root:
                if engine.panel_review_context(root, panel_id)["rawSha256"] != context["rawSha256"]:
                    raise ProviderError("The panel image changed during review; nothing was recorded.")
                record = engine.publish_panel_review(
                    root, panel_id, checks, assessments, method="vision-model-review", reviewer=reviewer
                )
            self._review_event(project_id, panel_id, record["decision"], reviewer)
            return {"decision": record["decision"]}

        return self._submit(project_id, "panel-review", panel_id, provider_id, work)

    def compose(self, project_id: str, revision: int) -> dict[str, Any]:
        with self._project(project_id, revision) as root:
            pages = engine.compose_pages(root)
        self.store.add_event(project_id, "pages.composed", f"Lettered panels and composed {len(pages)} pages.")
        return self.project(project_id)

    def page_review_context(self, project_id: str, number: int) -> dict[str, Any]:
        with self._project(project_id, None) as root:
            return engine.page_review_context(root, number)

    def review_page(self, project_id: str, revision: int, number: int, payload: Mapping[str, Any]) -> dict[str, Any]:
        checks = payload.get("checks")
        balloons = payload.get("balloons", {})
        if not isinstance(checks, list) or not isinstance(balloons, dict):
            raise invalid("A page review needs checks and a result for every balloon tail.")
        with self._project(project_id, revision) as root:
            record = engine.publish_page_review(
                root, number, checks, balloons, method=engine.PAGE_REVIEW_METHOD, reviewer=CREATOR
            )
        self._review_event(project_id, f"Page {number}", record["decision"], CREATOR)
        return self.project(project_id)

    def auto_review_page(self, project_id: str, revision: int, number: int, provider_id: str) -> dict[str, Any]:
        model = self._text_model(provider_id)
        with self._project(project_id, revision) as root:
            context = engine.page_review_context(root, number)
            page = engine.read_bytes(root, f"pages/page-{number:03d}.png")
        reviewer = self.providers.reviewer_name(provider_id)

        def work(run_id: str) -> dict[str, Any]:
            checks, balloons = review_page(model, context, page)
            with self._project(project_id, None) as root:
                if engine.read_bytes(root, f"pages/page-{number:03d}.png") != page:
                    raise ProviderError("The page changed during review; nothing was recorded.")
                record = engine.publish_page_review(
                    root, number, checks, balloons, method="vision-model-review", reviewer=reviewer
                )
            self._review_event(project_id, f"Page {number}", record["decision"], reviewer)
            return {"decision": record["decision"]}

        return self._submit(project_id, "page-review", str(number), provider_id, work)

    def finalize(self, project_id: str, revision: int) -> dict[str, Any]:
        with self._project(project_id, revision) as root:
            result = engine.finalize(root)
        status = "with warnings" if result.get("status") == "COMPLETE_WITH_WARNINGS" else ""
        self.store.add_event(
            project_id, "project.finished", f"The engine exported the verified PDF {status}".strip() + "."
        )
        return self.project(project_id)

    def export_archive(self, project_id: str) -> Path:
        row = self._row(project_id)
        with self._project(project_id, None) as root:
            directory = self.config.exports_root / project_id
            directory.mkdir(parents=True, exist_ok=True)
            stem = f"{root.name}-r{self._row(project_id)['revision']}"
            destination = directory / f"{stem}{engine.archive_suffix()}"
            if destination.exists():
                destination.unlink()
            path = engine.export_archive(root, destination)
        self.store.add_event(project_id, "export.archive", f"Exported a portable archive of {row['title']}.")
        return path

    def validation(self, project_id: str) -> list[str]:
        with self._project(project_id, None) as root:
            return engine.validate(root, "all")

    def activity(self, project_id: str) -> dict[str, Any]:
        with self._project(project_id, None) as root:
            return {
                "studio": self.store.events(project_id),
                "engine": list(reversed(engine.engine_events(root, 100))),
            }

    # ------------------------------------------------------------------ #
    # Background runs
    # ------------------------------------------------------------------ #

    def _missing(self, provider_id: str) -> None:
        raise invalid(f"No {provider_id} route is configured. Set its API key and restart Studio.")

    def _text_model(self, provider_id: str):
        if provider_id not in self.providers.text:
            self._missing(provider_id)
        return self.providers.text_model(provider_id)

    def _submit(
        self,
        project_id: str,
        kind: str,
        subject: str,
        provider_id: str,
        work: Callable[[str], dict[str, Any]],
    ) -> dict[str, Any]:
        run_id = secrets.token_hex(12)
        run = self.store.create_run(run_id, project_id, kind, subject, provider_id)
        if run is None or run["id"] != run_id:
            return run or {}

        def execute() -> None:
            self.store.update_run(run_id, "running", "Working.")
            try:
                result = work(run_id)
            except ProviderError as error:
                self.store.update_run(run_id, "failed", str(error))
            except StudioError as error:
                detail = f"{error.message} {' '.join(error.details[:2])}".strip()
                self.store.update_run(run_id, "failed", detail)
            except Exception as error:  # a run must always end in a recorded state
                self.store.update_run(run_id, "failed", f"Unexpected error: {type(error).__name__}.")
            else:
                self.store.update_run(run_id, "succeeded", "Done.", result)

        self._executor.submit(execute)
        return self.store.run(run_id) or {}

    def run(self, project_id: str, run_id: str) -> dict[str, Any]:
        run = self.store.run(run_id)
        if run is None or run["projectId"] != project_id:
            raise not_found("run")
        return run
