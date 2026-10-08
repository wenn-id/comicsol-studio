"""OpenAI as planner, visual reviewer, and image renderer, over its HTTP API."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

from comicsol_studio.providers.planning import ProviderError, parse_json_text

PROVIDER_ID = "openai"
API = "https://api.openai.com/v1"
NATIVE_SIZES = ((1024, 1024), (1024, 1536), (1536, 1024))
MAX_REFERENCES = 16


def _raise_for(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    try:
        error = response.json().get("error") or {}
    except ValueError:
        error = {}
    code = " ".join(str(error.get(key) or "") for key in ("code", "type")).lower()
    if response.status_code == 401:
        raise ProviderError("OpenAI rejected the API key.")
    if response.status_code == 429 and "insufficient_quota" in code:
        raise ProviderError("The OpenAI account has no remaining quota.")
    if response.status_code == 429:
        raise ProviderError("OpenAI rate limit reached. Try again shortly.")
    if any(marker in code for marker in ("content_policy", "moderation", "safety")):
        raise ProviderError("OpenAI's safety system declined this prompt.")
    message = str(error.get("message") or "").strip()
    raise ProviderError(
        f"OpenAI returned an error ({response.status_code})" + (f": {message}" if message else ".")
    )


class OpenAIClient:
    provider_id = PROVIDER_ID

    def __init__(
        self,
        api_key: str,
        *,
        text_model: str,
        image_model: str,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.text_model = text_model
        self.image_model = image_model
        self._headers = {"authorization": f"Bearer {api_key}"}
        self._transport = transport

    def _client(self, timeout: float) -> httpx.Client:
        return httpx.Client(
            base_url=API,
            headers=self._headers,
            timeout=httpx.Timeout(timeout, connect=10.0),
            transport=self._transport,
        )

    # text ---------------------------------------------------------------

    def complete_json(
        self,
        system: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        image_png: bytes | None = None,
        effort: str = "high",
    ) -> Mapping[str, Any]:
        del effort
        content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
        if image_png is not None:
            content.append(
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,"
                    + base64.b64encode(image_png).decode("ascii"),
                }
            )
        payload = {
            "model": self.text_model,
            "instructions": system,
            "input": [{"role": "user", "content": content}],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "comic_sol_result",
                    "strict": True,
                    "schema": schema,
                }
            },
        }
        try:
            with self._client(600.0) as client:
                response = client.post("/responses", json=payload)
        except httpx.HTTPError as error:
            raise ProviderError("Studio could not reach OpenAI.") from error
        _raise_for(response)
        body = response.json()
        texts = [
            item.get("text")
            for message in body.get("output") or []
            if isinstance(message, Mapping)
            for item in message.get("content") or []
            if isinstance(item, Mapping) and item.get("type") == "output_text"
        ]
        if not texts or not isinstance(texts[0], str):
            refusal = any(
                isinstance(item, Mapping) and item.get("type") == "refusal"
                for message in body.get("output") or []
                if isinstance(message, Mapping)
                for item in message.get("content") or []
            )
            raise ProviderError(
                "The OpenAI model declined this request." if refusal else "OpenAI returned no text."
            )
        return parse_json_text(texts[0])

    # images -------------------------------------------------------------

    @staticmethod
    def native_size(width: int, height: int) -> tuple[int, int]:
        """OpenAI's closest native orientation; Studio crops to the exact job size."""
        if width == height:
            return NATIVE_SIZES[0]
        return NATIVE_SIZES[2] if width > height else NATIVE_SIZES[1]

    def render(
        self,
        prompt: str,
        *,
        width: int,
        height: int,
        references: Sequence[bytes] = (),
    ) -> bytes:
        size_width, size_height = self.native_size(width, height)
        fields = {
            "model": self.image_model,
            "prompt": prompt,
            "n": "1",
            "size": f"{size_width}x{size_height}",
            "output_format": "png",
        }
        try:
            with self._client(300.0) as client:
                if references:
                    files = [
                        ("image[]", (f"reference-{index}.png", payload, "image/png"))
                        for index, payload in enumerate(references[:MAX_REFERENCES])
                    ]
                    response = client.post("/images/edits", data=fields, files=files)
                else:
                    response = client.post(
                        "/images/generations", json={**fields, "n": 1}
                    )
        except httpx.HTTPError as error:
            raise ProviderError("Studio could not reach OpenAI.") from error
        _raise_for(response)
        data = response.json().get("data")
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], Mapping):
            raise ProviderError("OpenAI returned no image.")
        encoded = data[0].get("b64_json")
        if not isinstance(encoded, str):
            raise ProviderError("OpenAI returned no image data.")
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ProviderError("OpenAI returned unreadable image data.") from error
