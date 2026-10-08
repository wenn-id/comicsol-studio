"""Shared helpers for the Comic Sol Studio test suite."""

from __future__ import annotations

import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # pragma: no cover - plain checkout without an install
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from comicsol_studio import engine  # noqa: E402
from comicsol_studio.app import WEB_DIR, create_app  # noqa: E402
from comicsol_studio.config import StudioConfig  # noqa: E402
from comicsol_studio.providers import Providers  # noqa: E402

BASE_URL = "http://127.0.0.1:8766"


def png_bytes(width: int, height: int, seed: int = 1, *, mode: str = "RGB") -> bytes:
    """A busy, non-blank test raster (the engine refuses empty images)."""
    image = Image.new(mode, (width, height), (210, 190, 160) + ((255,) if mode == "RGBA" else ()))
    draw = ImageDraw.Draw(image)
    for index in range(40):
        x = (index * 53 + seed * 17) % width
        y = (index * 97 + seed * 29) % height
        fill = ((index * 37) % 255, (seed * 41) % 255, (index * 13) % 255)
        draw.rectangle([x, y, x + width // 8, y + height // 10], fill=fill + ((255,) if mode == "RGBA" else ()))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def starter_documents(starter_id: str = "dialogue-two-page") -> dict[str, Any]:
    starter = engine.module("starter_templates").load_starter(
        engine.module("comic_sol").TEMPLATES, starter_id
    )
    return {
        "storyPlan": starter.story_plan,
        "characterBible": starter.character_bible,
        "storyboard": starter.storyboard,
    }


class StudioClient:
    """A TestClient that carries the CSRF token and the current revision."""

    def __init__(self, providers: Providers | None = None) -> None:
        self.data_root = Path(tempfile.mkdtemp(prefix="comicsol-studio-test-"))
        self.config = StudioConfig(data_root=self.data_root)
        self.app = create_app(self.config, providers=providers or Providers())
        self.http = TestClient(self.app, base_url=BASE_URL)
        session = self.http.get("/api/session")
        session.raise_for_status()
        self.session = session.json()
        self.csrf = self.session["csrfToken"]

    @property
    def studio(self):
        return self.app.state.studio

    def headers(self, revision: int | None = None, **extra: str) -> dict[str, str]:
        headers = {"x-csrf-token": self.csrf, **extra}
        if revision is not None:
            headers["x-revision"] = str(revision)
        return headers

    def get(self, path: str, **kwargs):
        return self.http.get(path, **kwargs)

    def post(self, path: str, revision: int | None = None, **kwargs):
        headers = {**self.headers(revision), **kwargs.pop("headers", {})}
        return self.http.post(path, headers=headers, **kwargs)

    def put(self, path: str, revision: int | None = None, **kwargs):
        return self.http.put(path, headers=self.headers(revision), **kwargs)

    def patch(self, path: str, revision: int | None = None, **kwargs):
        return self.http.patch(path, headers=self.headers(revision), **kwargs)

    def delete(self, path: str, **kwargs):
        return self.http.delete(path, headers=self.headers(), **kwargs)

    def close(self) -> None:
        self.http.close()
        self.studio.close()
        shutil.rmtree(self.data_root, ignore_errors=True)


def run_node(test_case: unittest.TestCase, script: str) -> str:
    node = shutil.which("node")
    if node is None:
        test_case.skipTest("Node.js is required for the browser module tests")
    completed = subprocess.run(
        [node, "--input-type=module", "--eval", script],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        cwd=WEB_DIR,
    )
    test_case.assertEqual(
        0,
        completed.returncode,
        f"Node check failed:\n{completed.stdout}\n{completed.stderr}",
    )
    return completed.stdout
