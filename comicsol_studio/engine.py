"""The single boundary between Studio and the Comic Sol engine.

Studio drives the engine the way the engine's own workflow documents an agent should
(`skill/references/workflow.md`): it writes the canonical artifacts described in
`references/schemas.md`, then calls the engine's public functions to validate, transition,
prepare handoff jobs, accept rasters, letter, compose, review, export, and finalize.

Rules kept here:

- Only public engine names are used (no leading underscore).
- Every write Studio authors goes through the engine's own `ProjectTransaction`, so the
  engine's lock and crash journal protect Studio writes exactly like engine writes.
- Studio never fabricates visual evidence. Review records carry the reviewer and method
  that produced them: the creator in the console, or a named vision model.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import stat
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from types import ModuleType
from typing import Any

ENGINE_PACKAGE = "comic_sol_product.engine"
PLAN_FILES = {
    "storyPlan": "plan/story-plan.json",
    "characterBible": "plan/character-bible.json",
    "storyboard": "plan/storyboard.json",
}
IDENTITY_PACK_FILE = "plan/character-identity-pack.json"
DEFAULT_STYLE = (
    "original high-contrast manga/anime with expressive ink-like linework "
    "and restrained color accents"
)
PANEL_REVIEW_METHOD = "creator-visual-review"
PAGE_REVIEW_METHOD = "creator-visual-review"
TERMINAL = frozenset({"COMPLETE", "COMPLETE_WITH_WARNINGS"})
# Files whose change does not mean the creator's project changed.
_FINGERPRINT_SKIP_PREFIXES = (".comic-sol.lock", "logs/transactions/")


class EngineInputError(ValueError):
    """The engine refused creator input; `issues` lists each reason."""

    def __init__(self, message: str, issues: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.issues = tuple(issues)


@cache
def module(name: str) -> ModuleType:
    """Import one engine module from the installed `comic-sol` wheel."""
    return importlib.import_module(f"{ENGINE_PACKAGE}.{name}")


def engine_version() -> str:
    return str(module("version").VERSION)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_bytes(document: object) -> bytes:
    return module("core_primitives").canonical_artifact_bytes(document)


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def read_json(root: Path, relative: str) -> Any:
    return module("project_io").read_contained_json(root, relative)


def read_bytes(root: Path, relative: str, *, max_bytes: int | None = None) -> bytes:
    project_io = module("project_io")
    if max_bytes is None:
        return project_io.read_contained_bytes(root, relative)
    return project_io.read_contained_bytes(root, relative, max_bytes=max_bytes)


def contained(root: Path, relative: str, *, must_exist: bool = False) -> Path:
    return module("project_io").contained_project_path(root, relative, must_exist=must_exist)


def exists(root: Path, relative: str) -> bool:
    try:
        return contained(root, relative).is_file()
    except (OSError, ValueError):
        return False


def manifest(root: Path) -> dict[str, Any]:
    return dict(module("schema").read_project_manifest(root / "project.json"))


def status_summary(root: Path) -> dict[str, Any]:
    return dict(module("comic_sol").summarize_project_status(root))


def plan_documents(root: Path) -> dict[str, Any]:
    """The three authored plan documents, or `None` for each one not written yet."""
    documents: dict[str, Any] = {}
    for key, relative in PLAN_FILES.items():
        documents[key] = read_json(root, relative) if exists(root, relative) else None
    return documents


def identity_pack(root: Path) -> Any:
    return read_json(root, IDENTITY_PACK_FILE) if exists(root, IDENTITY_PACK_FILE) else None


def storyboard_panels(storyboard: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(storyboard, Mapping):
        return []
    panels: list[dict[str, Any]] = []
    for page in storyboard.get("pages") or []:
        if isinstance(page, Mapping):
            panels.extend(
                panel
                for panel in page.get("panels") or []
                if isinstance(panel, dict) and isinstance(panel.get("id"), str)
            )
    return panels


def fingerprint(root: Path) -> str:
    """A cheap token for the project's current files: paths, sizes, and change times.

    A change made outside Studio (an agent session, the engine CLI) moves the token,
    which advances Studio's revision so a stale browser gets a conflict instead of
    overwriting newer work.
    """
    digest = hashlib.sha256()
    for directory, names, files in os.walk(root):
        names.sort()
        for name in sorted(files):
            path = Path(directory, name)
            relative = path.relative_to(root).as_posix()
            if relative.startswith(_FINGERPRINT_SKIP_PREFIXES):
                continue
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            digest.update(f"{relative}\0{info.st_size}\0{info.st_mtime_ns}\0".encode())
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# Catalogs
# --------------------------------------------------------------------------- #


def starters() -> list[dict[str, Any]]:
    starter_templates = module("starter_templates")
    comic_sol = module("comic_sol")
    catalog = []
    for starter_id in starter_templates.STARTER_IDS:
        starter = starter_templates.load_starter(comic_sol.TEMPLATES, starter_id)
        catalog.append(
            {
                "id": starter_id,
                "title": starter.story_plan.get("title"),
                "logline": starter.story_plan.get("logline"),
                "tone": list(starter.story_plan.get("tone") or []),
                "pages": starter.page_count,
                "panels": len(starter.panel_ids),
                "characters": [
                    character.get("name")
                    for character in starter.character_bible.get("characters", [])
                ],
                "layouts": [page.get("layout") for page in starter.storyboard.get("pages", [])],
            }
        )
    return catalog


def layouts() -> dict[str, list[dict[str, int]]]:
    layout_module = module("layouts")
    names = (
        "full-page",
        "two-horizontal",
        "three-horizontal",
        "hero-top-two-bottom",
        "two-top-hero-bottom",
    )
    return {name: layout_module.layout_rects(name) for name in names}


def page_size() -> tuple[int, int]:
    layout_module = module("layouts")
    return layout_module.PAGE_WIDTH, layout_module.PAGE_HEIGHT


def check_catalog() -> dict[str, Any]:
    core = module("core_primitives")
    page_quality = module("page_quality")
    return {
        "panel": list(core.PANEL_CHECK_IDS),
        "page": list(page_quality.SUBJECTIVE_PAGE_CHECK_IDS),
        "traits": list(module("character_quality").CHARACTER_TRAITS),
    }


# --------------------------------------------------------------------------- #
# Creation and archives
# --------------------------------------------------------------------------- #


def init_project(
    container: Path,
    *,
    title: str,
    source: str,
    language: str,
    mode: str,
    page_count: int,
) -> Path:
    try:
        return module("comic_sol").init_project(
            container,
            title,
            source.encode("utf-8"),
            {"language": language, "mode": mode},
            page_count=page_count,
        )
    except (TypeError, ValueError) as error:
        raise EngineInputError(str(error), (str(error),)) from error


def init_starter(container: Path, starter_id: str) -> Path:
    try:
        root = module("comic_sol").init_project(container, _starter_title(starter_id), starter=starter_id)
    except (TypeError, ValueError) as error:
        raise EngineInputError(str(error), (str(error),)) from error
    # A starter ships the plan; Studio adds the derived identity pack and the prompts
    # the handoff contract needs, exactly as it does after the creator saves a plan.
    documents = plan_documents(root)
    _publish_prompts_and_identity(root, documents)
    return root


def _starter_title(starter_id: str) -> str:
    for entry in starters():
        if entry["id"] == starter_id:
            return str(entry["title"])
    raise EngineInputError("That starter is not in the engine catalog.")


def import_archive(archive: Path, container: Path) -> Path:
    handoff_archive = module("handoff_archive")
    if archive.suffix != handoff_archive.ARCHIVE_SUFFIX:
        raise EngineInputError(f"Archives must use the {handoff_archive.ARCHIVE_SUFFIX} suffix.")
    try:
        result = handoff_archive.import_handoff_archive(archive, container)
    except (TypeError, ValueError) as error:
        raise EngineInputError("The engine refused this archive.", (str(error),)) from error
    return Path(result["project_dir"])


def archive_suffix() -> str:
    return str(module("handoff_archive").ARCHIVE_SUFFIX)


def export_archive(root: Path, destination: Path) -> Path:
    result = module("handoff_archive").export_handoff_archive(root, destination)
    return Path(result["archive_path"])


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #


def _issue_text(issue: object) -> str:
    path = getattr(issue, "path", "")
    field = getattr(issue, "field", "")
    message = getattr(issue, "message", str(issue))
    location = ".".join(part for part in (path, field) if part)
    return f"{location}: {message}" if location else str(message)


def validate_plan(documents: Mapping[str, Any], *, max_pages: int = 4) -> list[str]:
    """Run the engine's plan, storyboard, and identity validators on unsaved documents."""
    validation = module("validate_project")
    character_identity = module("character_identity")
    story = documents.get("storyPlan")
    bible = documents.get("characterBible")
    storyboard = documents.get("storyboard")
    issues: list[str] = []
    for key, value in (("storyPlan", story), ("characterBible", bible), ("storyboard", storyboard)):
        if not isinstance(value, dict):
            issues.append(f"{PLAN_FILES[key]}: must be a JSON object")
    if issues:
        return issues
    issues.extend(_issue_text(issue) for issue in validation.validate_story_plan(story))
    issues.extend(_issue_text(issue) for issue in validation.validate_character_bible(bible))
    issues.extend(
        _issue_text(issue) for issue in validation.validate_storyboard(storyboard, story, bible)
    )
    known = {
        character.get("id")
        for character in bible.get("characters") or []
        if isinstance(character, dict)
    }
    for scene in story.get("scenes") or []:
        if isinstance(scene, dict):
            for character_id in scene.get("characters") or []:
                if character_id not in known:
                    issues.append(
                        f"story-plan.scenes.{scene.get('id')}: unknown character {character_id!r}"
                    )
    pages = storyboard.get("pages")
    if isinstance(pages, list) and not 1 <= len(pages) <= max_pages:
        issues.append(f"storyboard.pages: a comic has 1 to {max_pages} pages")
    if not issues:
        try:
            pack = character_identity.derive_identity_pack(bible)
            issues.extend(character_identity.validate_identity_pack(pack, character_bible=bible))
        except ValueError as error:
            issues.append(f"character-identity-pack: {error}")
    return list(dict.fromkeys(issues))


def publish_plan(root: Path, documents: Mapping[str, Any]) -> None:
    """Make the creator's plan canonical and advance the project to `STORYBOARDED`.

    A project that already moved past planning is invalidated from planning first
    (the engine keeps artifacts and its cache decides what must be redone).
    """
    issues = validate_plan(documents)
    if issues:
        raise EngineInputError("The plan does not pass the engine's validation.", issues)
    comic_sol = module("comic_sol")
    project_io = module("project_io")
    story = documents["storyPlan"]
    bible = documents["characterBible"]
    storyboard = documents["storyboard"]
    current = manifest(root)
    status = current.get("status")
    if status == "BLOCKED":
        comic_sol.resume_project(root)
        status = manifest(root).get("status")
    if status != "INIT":
        comic_sol.invalidate_from(root, "planning")
    payloads = {key: canonical_bytes(documents[key]) for key in PLAN_FILES}
    panel_ids = [panel["id"] for panel in storyboard_panels(storyboard)]
    with project_io.ProjectTransaction(root, "studio-plan") as transaction:
        for key, relative in PLAN_FILES.items():
            transaction.stage_bytes(relative, payloads[key])
        updated = module("schema").read_project_manifest(root / "project.json", normalize_legacy=False)
        settings = updated["settings"]
        settings["page_count"] = len(storyboard["pages"])
        settings["panel_count"] = len(panel_ids)
        updated["panels"] = panel_ids
        artifacts = updated.setdefault("artifacts", {})
        for name, key in (
            ("story_plan", "storyPlan"),
            ("character_bible", "characterBible"),
            ("storyboard", "storyboard"),
        ):
            artifacts[name] = {
                "path": PLAN_FILES[key],
                "sha256": hashlib.sha256(payloads[key]).hexdigest(),
            }
        updated["updated_at"] = utc_now()
        transaction.stage_bytes("project.json", canonical_bytes(updated))
    _publish_prompts_and_identity(root, {"storyPlan": story, "characterBible": bible, "storyboard": storyboard})
    module("validate_project").require_valid_project(root, "plan")
    status = manifest(root)["status"]
    if status == "INIT":
        comic_sol.record_stage(root, "planning")
        comic_sol.transition(root, "PLANNED")
        status = "PLANNED"
    if status == "PLANNED":
        comic_sol.transition(root, "SCRIPTED")
        status = "SCRIPTED"
    module("validate_project").require_valid_project(root, "storyboard")
    comic_sol.record_stage(root, "storyboard")
    if status == "SCRIPTED":
        comic_sol.transition(root, "STORYBOARDED")


def _publish_prompts_and_identity(root: Path, documents: Mapping[str, Any]) -> None:
    character_identity = module("character_identity")
    project_io = module("project_io")
    story = documents["storyPlan"]
    bible = documents["characterBible"]
    storyboard = documents["storyboard"]
    existing = identity_pack(root)
    pack = character_identity.merge_authored_entries(
        character_identity.derive_identity_pack(bible), existing
    )
    issues = character_identity.validate_identity_pack(pack, character_bible=bible)
    if issues:
        raise EngineInputError("The engine could not derive the identity pack.", issues)
    prompts = authored_prompts(story, bible, storyboard, pack)
    with project_io.ProjectTransaction(root, "studio-prompts") as transaction:
        transaction.stage_bytes(IDENTITY_PACK_FILE, character_identity.identity_pack_bytes(pack))
        for relative, text in prompts.items():
            transaction.stage_bytes(relative, text.encode("utf-8"))


def authored_prompts(
    story: Mapping[str, Any],
    bible: Mapping[str, Any],
    storyboard: Mapping[str, Any],
    pack: Mapping[str, Any],
    *,
    style: str = DEFAULT_STYLE,
) -> dict[str, str]:
    """Write the reference and panel prompts the handoff contract requires.

    Each panel prompt embeds the engine's identity block verbatim, as the workflow asks,
    so a retry or a resume reuses the same identity context.
    """
    character_identity = module("character_identity")
    title = str(story.get("title") or "Untitled")
    scenes = {
        scene.get("id"): scene for scene in story.get("scenes") or [] if isinstance(scene, dict)
    }
    prompts: dict[str, str] = {}
    for character in bible.get("characters") or []:
        fingerprint_fields = character.get("visual_fingerprint") or {}
        lines = [
            f'Character reference for the comic "{title}".',
            f"Style: {style}.",
            f"Draw {character.get('name')} ({character.get('role')}, {character.get('age_band')}) "
            "as one clean, full-figure, front three-quarter canonical view on a plain light "
            "neutral background, evenly lit, nothing cropped.",
            f"Silhouette: {fingerprint_fields.get('silhouette')}.",
            f"Face: {fingerprint_fields.get('face')}.",
            f"Hair: {fingerprint_fields.get('hair')}.",
            f"Wardrobe: {fingerprint_fields.get('wardrobe')}.",
            "Palette: " + ", ".join(fingerprint_fields.get("palette") or []) + ".",
        ]
        props = fingerprint_fields.get("signature_props") or []
        if props:
            lines.append("Signature props: " + ", ".join(props) + ".")
        lines.append(
            "Always visible: " + "; ".join(fingerprint_fields.get("invariants") or []) + "."
        )
        avoid = [*(fingerprint_fields.get("avoid") or []), "text", "lettering", "logos", "watermarks"]
        lines.append("Do not draw: " + ", ".join(dict.fromkeys(avoid)) + ".")
        prompts[f"prompts/references/{character['id']}.txt"] = "\n".join(lines) + "\n"

    for page in storyboard.get("pages") or []:
        for panel in page.get("panels") or []:
            scene = scenes.get(panel.get("scene_id")) or {}
            character_ids = [c for c in panel.get("characters") or [] if isinstance(c, str)]
            texts = [item for item in panel.get("text") or [] if isinstance(item, dict)]
            generated_sfx = [
                item.get("content")
                for item in texts
                if item.get("kind") == "sfx"
                and item.get("render_mode", "generated-visual") == "generated-visual"
            ]
            lettering_anchors = sorted(
                {
                    str(item.get("anchor"))
                    for item in texts
                    if not (item.get("kind") == "sfx" and item.get("render_mode", "generated-visual") == "generated-visual")
                }
            )
            lines = [
                f'Comic panel {panel.get("id")} for "{title}", page {page.get("number")}, '
                f'panel {panel.get("order")}.',
                f"Style: {style}.",
                f"Scene: {scene.get('location')}, {scene.get('time')}. "
                f"Continuity anchor: {scene.get('continuity_anchor')}.",
                f"Beat: {panel.get('beat')}",
                f"Shot: {panel.get('shot')}.",
                f"Composition: {panel.get('composition')}.",
                f"Action: {panel.get('action')}",
                f"Expression: {panel.get('expression')}.",
                f"Lighting: {panel.get('lighting')}.",
            ]
            continuity = panel.get("continuity") or []
            if continuity:
                lines.append("Keep exactly: " + "; ".join(continuity) + ".")
            if character_ids:
                lines.append(character_identity.identity_prompt_block(pack, character_ids))
            if generated_sfx:
                lines.append(
                    "Integrate each of these sound effects exactly once, spelled exactly: "
                    + ", ".join(f'"{content}"' for content in generated_sfx)
                    + "."
                )
            else:
                lines.append("Draw no sound effects.")
            if lettering_anchors:
                lines.append(
                    "Keep calm, uncluttered space for lettering near: "
                    + ", ".join(lettering_anchors)
                    + "."
                )
            negative = [
                "speech bubbles",
                "dialogue",
                "captions",
                "lettering",
                "logos",
                "signatures",
                "watermarks",
                *(panel.get("negative") or []),
            ]
            lines.append("Do not draw: " + ", ".join(dict.fromkeys(negative)) + ".")
            prompts[f"prompts/panels/{panel['id']}.txt"] = "\n".join(lines) + "\n"
    return prompts


# --------------------------------------------------------------------------- #
# Generation handoff
# --------------------------------------------------------------------------- #


def prepare_generation(root: Path) -> dict[str, Any]:
    status = manifest(root).get("status")
    if status in {"INIT", "PLANNED", "SCRIPTED"}:
        raise EngineInputError("Save a complete plan before rendering.")
    try:
        return dict(module("comic_sol").prepare_handoff(root))
    except (TypeError, ValueError) as error:
        raise EngineInputError("The engine could not prepare render jobs.", (str(error),)) from error


def inspect_generation(root: Path) -> dict[str, Any]:
    if not exists(root, "handoff/manifest.json"):
        return {"prepared": False, "jobs": [], "phase": None, "next_action": None}
    return dict(module("comic_sol").inspect_handoff(root))


@dataclass(frozen=True)
class JobBrief:
    job_id: str
    subject_kind: str
    subject_id: str
    status: str
    attempt: int
    prompt: str
    width: int
    height: int
    exact_dimensions: bool
    aspect_ratio: str | None
    references: tuple[str, ...]


def job_briefs(root: Path, inspection: Mapping[str, Any] | None = None) -> list[JobBrief]:
    if inspection is None:
        inspection = inspect_generation(root)
    briefs = []
    for state in inspection.get("jobs", []):
        job = read_json(root, state["path"])
        dimensions = job.get("requested_dimensions")
        exact = isinstance(dimensions, Mapping)
        width = int(dimensions["width"]) if exact else 1024
        height = int(dimensions["height"]) if exact else 1024
        attempt = state.get("next_attempt")
        if not isinstance(attempt, int) or isinstance(attempt, bool):
            attempt = max(1, int(state.get("attempts_used") or 1))
        briefs.append(
            JobBrief(
                job_id=state["job_id"],
                subject_kind=state["subject_kind"],
                subject_id=state["subject_id"],
                status=state["status"],
                attempt=attempt,
                prompt=read_bytes(root, job["prompt_path"]).decode("utf-8"),
                width=width,
                height=height,
                exact_dimensions=exact,
                aspect_ratio=job.get("requested_aspect_ratio"),
                references=tuple(item["path"] for item in job.get("references") or []),
            )
        )
    return briefs


def job_brief(root: Path, job_id: str) -> JobBrief:
    for brief in job_briefs(root):
        if brief.job_id == job_id:
            return brief
    raise EngineInputError("That render job is not part of the current handoff.")


def accept_raster(
    root: Path,
    job_id: str,
    raster: Path,
    *,
    executor_id: str,
    provider: str | None,
    model: str | None,
    used_references: bool,
) -> dict[str, Any]:
    """Hand one PNG to the engine's result intake; promote it when it is a panel."""
    comic_sol = module("comic_sol")
    brief = job_brief(root, job_id)
    if brief.status != "ready":
        raise EngineInputError(f"This job is {brief.status}, not ready for a new image.")
    try:
        result = comic_sol.accept_handoff_result(
            root,
            job_id=job_id,
            attempt=brief.attempt,
            raster_path=raster,
            executor_kind="external-tool",
            executor_id=executor_id,
            provider=provider,
            model=model,
            capabilities_used={
                "dimensions": True,
                "localized_edit": False,
                "reference_images": used_references,
            },
            approve_reference=brief.subject_kind == "reference",
        )
    except (TypeError, ValueError) as error:
        issues = getattr(error, "issues", None) or getattr(error, "errors", None) or (str(error),)
        raise EngineInputError("The engine refused this image.", [str(item) for item in issues]) from error
    if brief.subject_kind == "panel" and result.get("duplicate") is not True:
        comic_sol.promote_attempt(root, brief.subject_id, Path(result["raster_path"]))
    return dict(result)


# --------------------------------------------------------------------------- #
# Panel review
# --------------------------------------------------------------------------- #


def _panel(root: Path, panel_id: str) -> dict[str, Any]:
    if module("core_primitives").PANEL_ID_PATTERN.fullmatch(str(panel_id)) is None:
        raise EngineInputError("That panel ID is not valid.")
    for panel in storyboard_panels(read_json(root, PLAN_FILES["storyboard"])):
        if panel["id"] == panel_id:
            return panel
    raise EngineInputError("That panel is not in the current storyboard.")


def character_context(root: Path, panel_id: str) -> dict[str, Any]:
    character_quality = module("character_quality")
    return dict(
        character_quality.character_consistency_context(
            read_json(root, IDENTITY_PACK_FILE),
            read_json(root, PLAN_FILES["characterBible"]),
            read_json(root, character_quality.REFERENCE_PLAN_PATH),
            panel_id,
            storyboard=read_json(root, PLAN_FILES["storyboard"]),
        )
    )


def panel_review_context(root: Path, panel_id: str) -> dict[str, Any]:
    panel = _panel(root, panel_id)
    if not exists(root, f"panels/raw/{panel_id}.png"):
        raise EngineInputError("This panel has no accepted image to review yet.")
    context = character_context(root, panel_id)
    raw = read_bytes(root, f"panels/raw/{panel_id}.png")
    record = read_json(root, f"qa/panels/{panel_id}.json") if exists(root, f"qa/panels/{panel_id}.json") else None
    return {
        "panel": panel,
        "rawSha256": hashlib.sha256(raw).hexdigest(),
        "checks": list(module("core_primitives").PANEL_CHECK_IDS),
        "characters": [
            {
                "characterId": character["character_id"],
                "traits": [
                    {"trait": trait["trait"], "expected": trait["expected"]}
                    for trait in character["traits"]
                ],
            }
            for character in context["characters"]
        ],
        "record": record,
    }


def _panel_bindings(root: Path, panel_id: str) -> dict[str, Any]:
    relative = f"panels/{panel_id}/normalization.json"
    payload = read_bytes(root, relative)
    normalization = json.loads(payload)
    source, clean = normalization["source"], normalization["clean"]
    return {
        "raw_path": source["path"],
        "raw_sha256": source["sha256"],
        "raw_width": source["size"][0],
        "raw_height": source["size"][1],
        "clean_path": clean["path"],
        "clean_sha256": clean["sha256"],
        "clean_width": clean["size"][0],
        "clean_height": clean["size"][1],
        "normalization_path": relative,
        "normalization_sha256": hashlib.sha256(payload).hexdigest(),
    }


def _current_bindings(root: Path, panel: Mapping[str, Any]) -> dict[str, Any]:
    validation = module("validate_project")
    panel_id = panel["id"]
    dimensions = (panel["rect"]["width"], panel["rect"]["height"])
    try:
        bindings = _panel_bindings(root, panel_id)
        current = not validation.validate_panel_provenance(
            root, {"subject_id": panel_id, "bindings": bindings}
        ) and (bindings["clean_width"], bindings["clean_height"]) == dimensions
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        current = False
    if not current:
        module("normalize_panels").normalize_panel(
            root, panel_id, f"panels/raw/{panel_id}.png", dimensions, "exact"
        )
        bindings = _panel_bindings(root, panel_id)
    return bindings


def panel_decision(root: Path, panel_id: str) -> str | None:
    """`accept`, `accept-warning`, `regenerate`, `stale` (review no longer current), or None."""
    relative = f"qa/panels/{panel_id}.json"
    if not exists(root, relative):
        return None
    record = read_json(root, relative)
    if record_is_stale(root, record):
        return "stale"
    decision = record.get("decision")
    return decision if isinstance(decision, str) else None


def panels_accepted(root: Path) -> bool:
    panels = storyboard_panels(read_json(root, PLAN_FILES["storyboard"]))
    return bool(panels) and all(
        panel_decision(root, panel["id"]) in {"accept", "accept-warning"} for panel in panels
    )


def record_is_stale(root: Path, record: Mapping[str, Any]) -> bool:
    """The engine's own record, provenance, and character-provenance validators."""
    validation = module("validate_project")
    character_quality = module("character_quality")
    payload = dict(record)
    try:
        return bool(
            validation.validate_panel_record(payload)
            or validation.validate_panel_provenance(root, payload)
            or character_quality.validate_character_quality_provenance(root, payload)
        )
    except (OSError, KeyError, TypeError, ValueError):
        return True


def publish_panel_review(
    root: Path,
    panel_id: str,
    checks: Sequence[Mapping[str, Any]],
    assessments: Sequence[Mapping[str, Any]],
    *,
    method: str,
    reviewer: str,
) -> dict[str, Any]:
    """Publish one panel-QA record (schema 2.0) and advance the project when all pass."""
    comic_sol = module("comic_sol")
    character_quality = module("character_quality")
    quality_records = module("quality_records")
    core = module("core_primitives")
    repair_strategy = module("repair_strategy")
    validation = module("validate_project")
    project_io = module("project_io")

    panel = _panel(root, panel_id)
    if not exists(root, f"panels/raw/{panel_id}.png"):
        raise EngineInputError("This panel has no accepted image to review yet.")
    expected_ids = list(core.PANEL_CHECK_IDS)
    if [check.get("id") if isinstance(check, Mapping) else None for check in checks] != expected_ids:
        raise EngineInputError("A panel review lists these checks in order: " + ", ".join(expected_ids) + ".")
    if not all(isinstance(item, Mapping) for item in assessments):
        raise EngineInputError("Character assessments must be objects.")
    checks = [
        {
            "id": check.get("id"),
            "result": check.get("result"),
            "severity": check.get("severity"),
            "evidence": " ".join(str(check.get("evidence") or "").split()),
            "method": method,
            "reviewer": reviewer,
            "regions": list(check.get("regions") or []),
        }
        for check in checks
    ]
    context = character_context(root, panel_id)
    if context["characters"]:
        try:
            checks[0] = character_quality.build_character_identity_check(
                context, [dict(item) for item in assessments], method=method, reviewer=reviewer
            )
        except ValueError as error:
            raise EngineInputError("The character review is incomplete.", (str(error),)) from error
    elif assessments:
        raise EngineInputError("This panel has no characters to assess.")
    categories = quality_records.validate_quality_checks(checks, core.PANEL_CHECK_IDS)
    if categories:
        raise EngineInputError(
            "Every check needs a result, a severity, and specific evidence.",
            [f"quality: {category}" for category in categories],
        )
    for check in checks:
        if repair_strategy.validate_defect_regions(check):
            raise EngineInputError("A marked defect region is not valid.")
    failures = [c for c in checks if c["result"] == "fail" and c["severity"] == "error"]
    warnings = [
        c["evidence"] for c in checks if c["result"] == "warning" or c["severity"] == "warning"
    ]
    record = {
        "schema_version": "2.0",
        "kind": "panel-qa",
        "subject_id": panel_id,
        "bindings": _current_bindings(root, panel),
        "checks": checks,
        "decision": "regenerate" if failures else "accept-warning" if warnings else "accept",
        "review": {"method": method, "reviewer": reviewer, "reviewed_at": utc_now()},
        "unresolved_warnings": warnings,
    }
    issues = [*validation.validate_panel_record(record), *validation.validate_panel_provenance(root, record)]
    issues.extend(character_quality.validate_character_quality_provenance(root, record))
    if issues:
        raise EngineInputError("The engine refused this review.", [_issue_text(item) for item in issues])
    with project_io.ProjectTransaction(root, "studio-panel-review") as transaction:
        transaction.stage_bytes(f"qa/panels/{panel_id}.json", canonical_bytes(record))
        if warnings:
            updated = module("schema").read_project_manifest(root / "project.json", normalize_legacy=False)
            updated["warnings"] = list(dict.fromkeys([*updated["warnings"], *warnings]))
            transaction.stage_bytes("project.json", canonical_bytes(updated))
    if failures or exists(root, "logs/repair-plan.json"):
        repair_strategy.plan_and_write_repair_plan(root, localized_edit_supported=False)
    if failures:
        comic_sol.invalidate_from(root, "generation")
    elif panels_accepted(root):
        _advance_to_qa_ready(root)
    return record


def _advance_to_qa_ready(root: Path) -> None:
    comic_sol = module("comic_sol")
    status = manifest(root)["status"]
    if status == "STORYBOARDED":
        comic_sol.transition(root, "REFERENCES_READY")
        status = "REFERENCES_READY"
    if status == "REFERENCES_READY":
        comic_sol.transition(root, "PANELS_READY")
        status = "PANELS_READY"
    if status == "PANELS_READY":
        comic_sol.transition(root, "QA_READY")
    comic_sol.record_stage(root, "generation")


# --------------------------------------------------------------------------- #
# Pages: letter, compose, review, finalize
# --------------------------------------------------------------------------- #


def compose_pages(root: Path) -> list[str]:
    comic_sol = module("comic_sol")
    if not panels_accepted(root):
        raise EngineInputError("Accept every panel before composing pages.")
    status = manifest(root)["status"]
    if status not in {"QA_READY", "LETTERED", "COMPOSED"}:
        raise EngineInputError("This project is not ready to compose pages.")
    stale = {
        action.stage
        for action in comic_sol.build_resume_plan(root)
        if action.artifact == "stage" and action.action in {"regenerate", "rerun"}
    }
    try:
        if "lettering" in stale or status == "QA_READY":
            module("letter_panels").letter_project(root)
            comic_sol.record_stage(root, "lettering")
        if status == "QA_READY":
            comic_sol.transition(root, "LETTERED")
        if "composition" in stale or status != "COMPOSED":
            module("compose_pages").compose_project(root)
            comic_sol.record_stage(root, "composition")
        if manifest(root)["status"] == "LETTERED":
            comic_sol.transition(root, "COMPOSED")
    except (TypeError, ValueError) as error:
        raise EngineInputError("Lettering or composition failed.", (str(error),)) from error
    page_count = manifest(root)["settings"]["page_count"]
    return [f"pages/page-{number:03d}.png" for number in range(1, page_count + 1)]


def _page(root: Path, number: int) -> dict[str, Any]:
    storyboard = read_json(root, PLAN_FILES["storyboard"])
    for page in storyboard.get("pages") or []:
        if page.get("number") == number:
            return page
    raise EngineInputError("That page is not in the current storyboard.")


def page_review_context(root: Path, number: int) -> dict[str, Any]:
    page = _page(root, number)
    if manifest(root)["status"] not in {"COMPOSED", "EXPORTED", *TERMINAL}:
        raise EngineInputError("Compose the pages before reviewing them.")
    balloons = []
    for panel in page["panels"]:
        geometry = read_json(root, f"panels/{panel['id']}/lettering.json")
        placed = {item.get("id"): item for item in geometry.get("items") or [] if isinstance(item, dict)}
        for item in panel.get("text") or []:
            if item.get("kind") != "dialogue":
                continue
            tail = (placed.get(item["id"]) or {}).get("tail") or {}
            balloons.append(
                {
                    "panelId": panel["id"],
                    "textId": item["id"],
                    "speaker": item.get("speaker"),
                    "content": item.get("content"),
                    "voiceSource": item.get("voice_source"),
                    "speakerAnchor": item.get("speaker_anchor"),
                    "tip": tail.get("tip"),
                }
            )
    relative = f"qa/pages/page-{number:03d}.json"
    record = read_json(root, relative) if exists(root, relative) else None
    stale = bool(module("page_quality").validate_page_quality(root, number)) if record else None
    page_png = f"pages/page-{number:03d}.png"
    return {
        "number": number,
        "pageSha256": hashlib.sha256(read_bytes(root, page_png)).hexdigest() if exists(root, page_png) else None,
        "page": page,
        "checks": list(module("page_quality").SUBJECTIVE_PAGE_CHECK_IDS),
        "balloons": balloons,
        "record": record,
        "recordStale": stale,
    }


def publish_page_review(
    root: Path,
    number: int,
    checks: Sequence[Mapping[str, Any]],
    balloon_results: Mapping[str, str],
    *,
    method: str,
    reviewer: str,
) -> dict[str, Any]:
    """Publish one page-QA record: engine geometry checks plus the reviewer's checks."""
    context = page_review_context(root, number)
    regions = []
    for balloon in context["balloons"]:
        key = f"{balloon['panelId']}/{balloon['textId']}"
        result = balloon_results.get(key)
        if result not in {"pass", "fail"}:
            raise EngineInputError("Mark every balloon tail as pass or fail.", (key,))
        regions.append(
            {
                "panel_id": balloon["panelId"],
                "text_id": balloon["textId"],
                "speaker": balloon["speaker"],
                "voice_source": balloon["voiceSource"],
                "speaker_anchor": balloon["speakerAnchor"],
                "tip": balloon["tip"],
                "result": result,
            }
        )
    visual = []
    for check in checks:
        entry = {
            "id": check.get("id"),
            "result": check.get("result"),
            "severity": check.get("severity"),
            "evidence": " ".join(str(check.get("evidence") or "").split()),
            "method": method,
            "reviewer": reviewer,
            "regions": regions if check.get("id") == "bubble-tail-direction" else [],
        }
        visual.append(entry)
    try:
        module("page_quality").publish_page_quality_record(
            root, number, visual, reviewer=reviewer, reviewed_at=utc_now()
        )
    except (TypeError, ValueError) as error:
        raise EngineInputError("The engine refused this page review.", (str(error),)) from error
    record = read_json(root, f"qa/pages/page-{number:03d}.json")
    if record.get("unresolved_warnings"):
        project_io = module("project_io")
        with project_io.ProjectTransaction(root, "studio-page-review") as transaction:
            updated = module("schema").read_project_manifest(root / "project.json", normalize_legacy=False)
            updated["warnings"] = list(dict.fromkeys([*updated["warnings"], *record["unresolved_warnings"]]))
            transaction.stage_bytes("project.json", canonical_bytes(updated))
    return record


def pages_reviewed(root: Path) -> bool:
    page_quality = module("page_quality")
    page_count = manifest(root)["settings"]["page_count"]
    for number in range(1, page_count + 1):
        relative = f"qa/pages/page-{number:03d}.json"
        if not exists(root, relative) or page_quality.validate_page_quality(root, number):
            return False
        if read_json(root, relative).get("decision") not in {"accept", "accept-warning"}:
            return False
    return True


def finalize(root: Path) -> dict[str, Any]:
    if not panels_accepted(root):
        raise EngineInputError("Accept every panel before finishing the comic.")
    if not pages_reviewed(root):
        raise EngineInputError("Review and accept every composed page before finishing.")
    try:
        return dict(module("comic_sol").finalize_project(root))
    except (TypeError, ValueError) as error:
        raise EngineInputError("The engine could not finish the comic.", (str(error),)) from error


def validate(root: Path, stage: str = "all") -> list[str]:
    return [_issue_text(issue) for issue in module("validate_project").validate_project(root, stage)]


def engine_events(root: Path, limit: int = 200) -> list[dict[str, Any]]:
    if not exists(root, "logs/events.jsonl"):
        return []
    lines = read_bytes(root, "logs/events.jsonl").decode("utf-8").splitlines()
    events = []
    for line in lines[-limit:]:
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def project_files(root: Path, prefixes: Iterable[str]) -> list[str]:
    found = []
    for prefix in prefixes:
        base = root / prefix
        if base.is_dir():
            found.extend(
                path.relative_to(root).as_posix() for path in sorted(base.rglob("*")) if path.is_file()
            )
    return found
