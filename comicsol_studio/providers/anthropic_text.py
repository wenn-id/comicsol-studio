"""Claude as planner and visual reviewer, through the official Anthropic SDK."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from typing import Any

import anthropic

from comicsol_studio.providers.planning import ProviderError, parse_json_text

PROVIDER_ID = "anthropic"
# Server-side fallback: a request declined by a safety classifier is re-run on the model
# Anthropic recommends for that refusal category, inside the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AnthropicText:
    provider_id = PROVIDER_ID

    def __init__(self, api_key: str, model: str, *, client: anthropic.Anthropic | None = None):
        self.model = model
        self._client = client or anthropic.Anthropic(api_key=api_key, timeout=600.0)

    def complete_json(
        self,
        system: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        image_png: bytes | None = None,
        effort: str = "high",
    ) -> Mapping[str, Any]:
        content: list[dict[str, Any]] = []
        if image_png is not None:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64.standard_b64encode(image_png).decode("ascii"),
                    },
                }
            )
        content.append({"type": "text", "text": prompt})
        try:
            with self._client.beta.messages.stream(
                model=self.model,
                max_tokens=64000,
                betas=[FALLBACK_BETA],
                fallbacks="default",
                system=system,
                thinking={"type": "adaptive"},
                output_config={
                    "effort": effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                messages=[{"role": "user", "content": content}],
            ) as stream:
                message = stream.get_final_message()
        except anthropic.AuthenticationError as error:
            raise ProviderError("Anthropic rejected the API key.") from error
        except anthropic.PermissionDeniedError as error:
            raise ProviderError("The Anthropic key cannot use this model.") from error
        except anthropic.NotFoundError as error:
            raise ProviderError(f"Anthropic does not offer the model {self.model}.") from error
        except anthropic.RateLimitError as error:
            raise ProviderError("Anthropic rate limit reached. Try again shortly.") from error
        except anthropic.BadRequestError as error:
            raise ProviderError(f"Anthropic refused the request: {error.message}") from error
        except anthropic.APIStatusError as error:
            raise ProviderError(f"Anthropic returned an error ({error.status_code}).") from error
        except anthropic.APIConnectionError as error:
            raise ProviderError("Studio could not reach Anthropic.") from error
        if message.stop_reason == "refusal":
            raise ProviderError("Claude declined this request.")
        if message.stop_reason == "max_tokens":
            raise ProviderError("Claude ran out of output space before finishing.")
        text = next((block.text for block in message.content if block.type == "text"), None)
        if text is None:
            raise ProviderError("Claude returned no text.")
        return parse_json_text(text)
