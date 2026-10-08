"""Optional model providers. Studio is fully usable without any of them.

A provider is offered only when its key is present in the environment that launched
Studio. Keys stay in this process; the page only learns which routes exist.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from comicsol_studio.config import ProviderKeys
from comicsol_studio.providers.planning import (
    REVIEW_SYSTEM_PROMPT,
    ProviderError,
    page_review_prompt,
    panel_review_prompt,
    review_schema,
)

__all__ = ["ProviderError", "Providers", "TextModel", "ImageModel"]


class TextModel(Protocol):
    provider_id: str

    def complete_json(
        self,
        system: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        image_png: bytes | None = None,
        effort: str = "high",
    ) -> Mapping[str, Any]: ...


class ImageModel(Protocol):
    provider_id: str
    image_model: str

    def render(
        self, prompt: str, *, width: int, height: int, references: tuple[bytes, ...] = ()
    ) -> bytes: ...


@dataclass
class Providers:
    text: dict[str, TextModel] = field(default_factory=dict)
    text_models: dict[str, str] = field(default_factory=dict)
    images: dict[str, ImageModel] = field(default_factory=dict)

    @classmethod
    def from_keys(cls, keys: ProviderKeys) -> Providers:
        providers = cls()
        if keys.anthropic:
            from comicsol_studio.providers.anthropic_text import AnthropicText

            providers.text["anthropic"] = AnthropicText(keys.anthropic, keys.anthropic_text_model)
            providers.text_models["anthropic"] = keys.anthropic_text_model
        if keys.openai:
            from comicsol_studio.providers.openai_api import OpenAIClient

            client = OpenAIClient(
                keys.openai,
                text_model=keys.openai_text_model,
                image_model=keys.openai_image_model,
            )
            providers.text["openai"] = client
            providers.text_models["openai"] = keys.openai_text_model
            providers.images["openai"] = client
        return providers

    def describe(self) -> dict[str, Any]:
        return {
            "planners": [
                {"id": provider_id, "model": self.text_models[provider_id]}
                for provider_id in self.text
            ],
            "reviewers": [
                {"id": provider_id, "model": self.text_models[provider_id]}
                for provider_id in self.text
            ],
            "renderers": [
                {"id": provider_id, "model": model.image_model}
                for provider_id, model in self.images.items()
            ],
        }

    def text_model(self, provider_id: str) -> TextModel:
        try:
            return self.text[provider_id]
        except KeyError:
            raise ProviderError(f"No {provider_id} key was set when Studio started.") from None

    def image_model(self, provider_id: str) -> ImageModel:
        try:
            return self.images[provider_id]
        except KeyError:
            raise ProviderError(f"No {provider_id} image route was set when Studio started.") from None

    def reviewer_name(self, provider_id: str) -> str:
        return f"{provider_id}:{self.text_models[provider_id]}"


def review_panel(
    model: TextModel, context: Mapping[str, Any], raster_png: bytes
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    result = model.complete_json(
        REVIEW_SYSTEM_PROMPT,
        panel_review_prompt(context),
        review_schema(list(context["checks"]), "panel"),
        image_png=raster_png,
        effort="medium",
    )
    checks = [dict(check, regions=[]) for check in result.get("checks") or []]
    if [check.get("id") for check in checks] != list(context["checks"]):
        raise ProviderError("The reviewer did not return every check in order.")
    return checks, [dict(item) for item in result.get("assessments") or []]


def review_page(
    model: TextModel, context: Mapping[str, Any], page_png: bytes
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    result = model.complete_json(
        REVIEW_SYSTEM_PROMPT,
        page_review_prompt(context),
        review_schema(list(context["checks"]), "page"),
        image_png=page_png,
        effort="medium",
    )
    checks = [dict(check) for check in result.get("checks") or []]
    if [check.get("id") for check in checks] != list(context["checks"]):
        raise ProviderError("The reviewer did not return every check in order.")
    balloons = {
        str(item.get("key")): str(item.get("result")) for item in result.get("balloons") or []
    }
    return checks, balloons
