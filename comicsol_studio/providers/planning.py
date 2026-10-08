"""Provider-neutral planning: what a text model is asked for, and how its draft becomes a plan.

A model writes only the creative content. Studio assigns everything the engine can derive
deterministically (IDs, reading order, panel rectangles from the engine's fixed layouts,
text IDs, reference paths), then the engine validates the result. Validation issues go back
to the model for a bounded number of repair rounds; nothing unvalidated is ever saved.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from comicsol_studio import engine

ANCHORS = (
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
)
MAX_PANELS = 12
REPAIR_ROUNDS = 2


class ProviderError(RuntimeError):
    """A provider call failed; `message` is safe to show the creator."""


@dataclass(frozen=True)
class PlanRequest:
    title: str
    source: str
    language: str
    page_count: int


def _string() -> dict[str, Any]:
    return {"type": "string"}


def _strings() -> dict[str, Any]:
    return {"type": "array", "items": {"type": "string"}}


def _nullable(schema: Mapping[str, Any]) -> dict[str, Any]:
    return {"anyOf": [dict(schema), {"type": "null"}]}


def _object(properties: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties),
        "properties": dict(properties),
    }


def draft_schema() -> dict[str, Any]:
    """Strict JSON schema for a plan draft (every key required, optional values nullable)."""
    layouts = list(engine.layouts())
    text_item = _object(
        {
            "kind": {"type": "string", "enum": ["dialogue", "caption", "sfx"]},
            "speaker": _nullable({"type": "string"}),
            "voice_source": _nullable({"type": "string", "enum": ["human", "device"]}),
            "speaker_anchor": _nullable({"type": "array", "items": {"type": "number"}}),
            "content": _string(),
            "anchor": {"type": "string", "enum": list(ANCHORS)},
            "render_mode": _nullable(
                {"type": "string", "enum": ["generated-visual", "deterministic-lettering"]}
            ),
        }
    )
    panel = _object(
        {
            "scene_id": _string(),
            "beat": _string(),
            "characters": _strings(),
            "shot": _string(),
            "composition": _string(),
            "action": _string(),
            "expression": _string(),
            "lighting": _string(),
            "continuity": _strings(),
            "negative": _strings(),
            "text": {"type": "array", "items": text_item},
        }
    )
    return _object(
        {
            "storyPlan": _object(
                {
                    "title": _string(),
                    "logline": _string(),
                    "theme": _string(),
                    "tone": _strings(),
                    "setting": _string(),
                    "beginning": _string(),
                    "turn": _string(),
                    "climax": _string(),
                    "ending": _string(),
                    "scenes": {
                        "type": "array",
                        "items": _object(
                            {
                                "id": _string(),
                                "purpose": _string(),
                                "location": _string(),
                                "time": _string(),
                                "characters": _strings(),
                                "continuity_anchor": _string(),
                            }
                        ),
                    },
                }
            ),
            "characters": {
                "type": "array",
                "items": _object(
                    {
                        "id": _string(),
                        "name": _string(),
                        "role": _string(),
                        "age_band": _string(),
                        "pronouns": _string(),
                        "personality": _strings(),
                        "motivation": _string(),
                        "speech": _string(),
                        "visual_fingerprint": _object(
                            {
                                "silhouette": _string(),
                                "face": _string(),
                                "hair": _string(),
                                "wardrobe": _string(),
                                "palette": _strings(),
                                "signature_props": _strings(),
                                "invariants": _strings(),
                                "avoid": _strings(),
                            }
                        ),
                    }
                ),
            },
            "pages": {
                "type": "array",
                "items": _object(
                    {
                        "layout": {"type": "string", "enum": layouts},
                        "panels": {"type": "array", "items": panel},
                    }
                ),
            },
        }
    )


SYSTEM_PROMPT = """\
You are the story and storyboard writer for Comic Sol, a deterministic comic production \
engine. You turn a creator's idea into a short comic plan that an image model will draw \
panel by panel and that the engine will letter and compose.

Write original work. Keep the rating teen: no explicit sexual content, no graphic gore, \
no real people, no apparent minors in mature situations. Do not imitate a living \
artist's style or reuse trademarked characters.

How the plan is used:
- Every visual description is pasted verbatim into image prompts, so describe concrete \
visible facts (shape, color, material, light direction), never feelings about the image.
- Dialogue, captions, and lettered sound effects are drawn later by the engine in \
balloons, so panels must leave space for them and the image model must not draw text.
- The engine checks continuity mechanically, so repeated facts must be repeated exactly.

Rules the engine enforces:
1. IDs (scene ids, character ids) are lowercase: a letter, then letters, digits, or \
hyphens, at most 48 characters, e.g. "rooftop-chase", "mara".
2. Story: 2 to 5 scenes. Each scene lists the ids of characters in it; every one must \
exist in characters. continuity_anchor fixes visible architecture, palette, time, and \
light sources reused across that scene's panels.
3. Characters: every speaking or recurring character. visual_fingerprint.invariants has \
2 to 5 short, panel-checkable facts (e.g. "red scarf", "scar over left eye"). palette, \
signature_props, and avoid are lists of short strings (avoid always includes \
"generated text").
4. Pages: exactly the requested number of pages. Each page picks a layout, and its panel \
count must match the layout: full-page 1, two-horizontal 2, three-horizontal 3, \
hero-top-two-bottom 3, two-top-hero-bottom 3. At most 12 panels in the whole comic. \
Panels are listed in reading order.
5. Each panel: scene_id names a story scene; characters lists the ids visible in the \
panel (a subset of that scene's characters); shot names shot size and camera angle; \
composition places subjects and keeps text-safe space; action and expression are visible; \
lighting gives key and fill direction.
6. continuity entries are written "owner-id:fact", where owner-id is a character or the \
panel's scene and fact is copied EXACTLY from that character's invariants or that scene's \
continuity_anchor. Include each visible character's most visible invariant.
7. negative lists what must not appear: always "generated text", "speech bubbles", \
"watermark", plus panel-specific failures to avoid.
8. text: 0 to 3 items per panel, at most 45 words per panel in total. Dialogue at most \
32 words but size it to the panel: about 14 words fit a narrow panel, short lines read \
best. Captions at most 45 words, sound effects at most 3 words.
   - dialogue: speaker is a character id that is in the panel's characters; voice_source \
is "human" (or "device" for phones, radios, speakers); speaker_anchor is [x, y] in 0..1 \
panel coordinates on the speaker's mouth or the device. Two different speakers' anchors \
must be at least 0.1 apart; one speaker keeps one anchor per panel. render_mode null.
   - caption: speaker, voice_source, speaker_anchor, render_mode all null.
   - sfx: speaker, voice_source, speaker_anchor null; render_mode "generated-visual" when \
the artwork should paint it, "deterministic-lettering" when it must be exact.
   - anchor places the balloon: top-left, top-center, top-right, middle-left, \
middle-right, bottom-left, bottom-center, bottom-right. Put balloons where they do not \
cover the speaker's face.
9. Write all story text and lettering in the requested language. IDs stay in English.

Return only the JSON object the schema describes."""


def user_prompt(request: PlanRequest, issues: list[str] | None = None) -> str:
    lines = [
        f"Title: {request.title}",
        f"Language: {request.language}",
        f"Pages: {request.page_count}",
        "",
        "Creator's idea:",
        request.source.strip(),
    ]
    if issues:
        lines += [
            "",
            "Your previous plan failed the engine's validation. Fix every issue below and "
            "return the complete corrected plan:",
            *(f"- {issue}" for issue in issues[:40]),
        ]
    return "\n".join(lines)


def assemble(draft: Mapping[str, Any], *, language: str) -> dict[str, Any]:
    """Turn a model draft into the three canonical engine documents."""
    del language
    layout_rects = engine.layouts()
    story = dict(draft.get("storyPlan") or {})
    story["schema_version"] = "1.0"
    story["rating"] = "teen"
    characters = []
    for character in draft.get("characters") or []:
        entry = dict(character)
        entry["reference_path"] = f"references/characters/{entry.get('id')}.png"
        characters.append(entry)
    pages = []
    for page_index, page in enumerate(draft.get("pages") or [], start=1):
        layout = page.get("layout")
        rects = layout_rects.get(layout, [])
        panels = []
        for order, panel in enumerate(page.get("panels") or [], start=1):
            panel_id = f"p{page_index:02d}-{order:02d}"
            entry = {key: value for key, value in panel.items() if key != "text"}
            entry["id"] = panel_id
            entry["order"] = order
            if order <= len(rects):
                entry["rect"] = dict(rects[order - 1])
            texts = []
            for number, item in enumerate(panel.get("text") or [], start=1):
                text = {
                    key: value
                    for key, value in item.items()
                    if value is not None or key == "speaker"
                }
                text["id"] = f"{panel_id}-t{number:02d}"
                text["priority"] = number
                if text.get("kind") != "dialogue":
                    text["speaker"] = None
                    text.pop("voice_source", None)
                    text.pop("speaker_anchor", None)
                if text.get("kind") != "sfx":
                    text.pop("render_mode", None)
                texts.append(text)
            entry["text"] = texts
            panels.append(entry)
        pages.append({"number": page_index, "layout": layout, "panels": panels})
    return {
        "storyPlan": story,
        "characterBible": {"schema_version": "1.0", "characters": characters},
        "storyboard": {"schema_version": "1.0", "pages": pages},
    }


def draft_plan(
    request: PlanRequest,
    complete_json: Callable[[str, str, dict[str, Any]], Mapping[str, Any]],
    *,
    on_round: Callable[[int, list[str]], None] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Ask the model for a plan, repairing against engine validation.

    Returns the assembled documents and the issues that remain (empty when valid).
    """
    schema = draft_schema()
    issues: list[str] = []
    documents: dict[str, Any] = {}
    for round_number in range(REPAIR_ROUNDS + 1):
        draft = complete_json(SYSTEM_PROMPT, user_prompt(request, issues or None), schema)
        documents = assemble(draft, language=request.language)
        issues = engine.validate_plan(documents)
        pages = documents["storyboard"]["pages"]
        if len(pages) != request.page_count:
            issues.append(f"storyboard.pages: write exactly {request.page_count} pages")
        if sum(len(page["panels"]) for page in pages) > MAX_PANELS:
            issues.append(f"storyboard: at most {MAX_PANELS} panels in total")
        if on_round is not None:
            on_round(round_number, issues)
        if not issues:
            break
    return documents, issues


def parse_json_text(text: str) -> Mapping[str, Any]:
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as error:
        raise ProviderError("The model returned text that is not JSON.") from error
    if not isinstance(parsed, Mapping):
        raise ProviderError("The model returned JSON that is not an object.")
    return parsed


# --------------------------------------------------------------------------- #
# Visual review
# --------------------------------------------------------------------------- #

REVIEW_SYSTEM_PROMPT = """\
You are the visual QA reviewer for Comic Sol. You look at one generated comic panel or \
one composed page and judge it against the plan it was drawn from.

For every check, give a result (pass, warning, fail), a severity (error for a defect \
that must be redrawn, warning for something the creator can accept), and evidence: one \
specific sentence naming what you actually see in this image (where, what, which \
character). Never write generic verdicts such as "looks good" or "ok", and never repeat \
the same sentence for two checks. If the image does not let you judge a check, say \
exactly what is missing and use warning.

Return only the JSON object the schema describes."""

PANEL_CHECK_GUIDE = {
    "character-identity": "each character matches the identity expectations listed",
    "anatomy": "hands, limbs, faces, and proportions are anatomically coherent",
    "action": "the panel shows the scripted action and beat",
    "composition": "shot, framing, and subject placement follow the storyboard, with space left for lettering",
    "continuity": "the listed continuity facts and the scene anchor are visible and consistent",
    "text-free": "no generated letters, words, speech bubbles, captions, logos, or watermarks (except authored generated-visual sound effects)",
    "technical": "the image is clean: no artifacts, seams, blur, duplicated objects, or cropping errors",
}
PAGE_CHECK_GUIDE = {
    "face-action-obstruction": "no balloon or caption covers a face or the key action",
    "bubble-tail-direction": "every dialogue balloon's tail points at the character who speaks",
    "accidental-text-watermark": "the page has no stray generated text, signatures, or watermarks",
}


def review_schema(check_ids: list[str], kind: str) -> dict[str, Any]:
    check = _object(
        {
            "id": {"type": "string", "enum": check_ids},
            "result": {"type": "string", "enum": ["pass", "warning", "fail"]},
            "severity": {"type": "string", "enum": ["warning", "error"]},
            "evidence": _string(),
        }
    )
    properties: dict[str, Any] = {"checks": {"type": "array", "items": check}}
    if kind == "panel":
        properties["assessments"] = {
            "type": "array",
            "items": _object(
                {
                    "character_id": _string(),
                    "trait": {
                        "type": "string",
                        "enum": list(engine.check_catalog()["traits"]),
                    },
                    "result": {"type": "string", "enum": ["pass", "warning", "fail"]},
                    "severity": {"type": "string", "enum": ["warning", "error"]},
                    "evidence": _string(),
                }
            ),
        }
    else:
        properties["balloons"] = {
            "type": "array",
            "items": _object(
                {
                    "key": _string(),
                    "result": {"type": "string", "enum": ["pass", "fail"]},
                }
            ),
        }
    return _object(properties)


def panel_review_prompt(context: Mapping[str, Any]) -> str:
    panel = context["panel"]
    guide = "\n".join(f"- {check}: {PANEL_CHECK_GUIDE[check]}" for check in context["checks"])
    lines = [
        f"Review panel {panel['id']}. Return the checks in this order:",
        guide,
        "",
        "Storyboard entry for this panel:",
        json.dumps(panel, ensure_ascii=False, sort_keys=True),
    ]
    if context["characters"]:
        lines += [
            "",
            "Also return one assessment for every character and trait below, in this order. "
            "Compare what you see with the expected value:",
        ]
        for character in context["characters"]:
            for trait in character["traits"]:
                lines.append(
                    f"- {character['characterId']} / {trait['trait']}: expected "
                    f"{json.dumps(trait['expected'], ensure_ascii=False)}"
                )
    else:
        lines += ["", "This panel has no characters: return an empty assessments list."]
    return "\n".join(lines)


def page_review_prompt(context: Mapping[str, Any]) -> str:
    guide = "\n".join(f"- {check}: {PAGE_CHECK_GUIDE[check]}" for check in context["checks"])
    lines = [
        f"Review composed page {context['number']}. Return the checks in this order:",
        guide,
        "",
        "Then judge each dialogue balloon's tail: pass when it points at its speaker.",
    ]
    for balloon in context["balloons"]:
        lines.append(
            f"- key {balloon['panelId']}/{balloon['textId']}: {balloon['speaker']} says "
            f"{json.dumps(balloon['content'], ensure_ascii=False)} (panel {balloon['panelId']})"
        )
    if not context["balloons"]:
        lines.append("- This page has no dialogue: return an empty balloons list.")
    return "\n".join(lines)
