"""Shared helpers for the Studio Next test suite."""

from __future__ import annotations

import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # pragma: no cover - plain checkout without an install
    sys.path.insert(0, str(ROOT))

UI_DIR = ROOT / "comic_sol_studio_next" / "ui"
JS_DIR = UI_DIR / "js"


def ui_files() -> list[Path]:
    return sorted(path for path in UI_DIR.rglob("*") if path.is_file())


def js_sources() -> dict[str, str]:
    return {
        path.relative_to(UI_DIR).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(JS_DIR.rglob("*.js"))
    }


def backend_static_dir() -> Path:
    from comic_sol_web.app import STATIC_DIR

    return Path(STATIC_DIR)


def stage_modules(destination: Path) -> Path:
    """Copy the interface modules so Node can import them outside a browser.

    Browser imports of the backend client (`/static/...`) are rewritten to the
    installed comic-sol-web files, so runtime tests exercise the real client.
    """
    staged = destination / "js"
    shutil.copytree(JS_DIR, staged)
    static_url = backend_static_dir().as_uri()
    for path in staged.rglob("*.js"):
        source = path.read_text(encoding="utf-8")
        path.write_text(source.replace('"/static/', f'"{static_url}/'), encoding="utf-8")
    return staged


def run_node(test_case: unittest.TestCase, script: str) -> None:
    node = shutil.which("node")
    test_case.assertIsNotNone(node, "Node.js is required for the Studio Next runtime tests")
    assert node is not None
    completed = subprocess.run(
        [node, "--input-type=module", "--eval", script],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    test_case.assertEqual(
        0,
        completed.returncode,
        f"Node runtime check failed:\n{completed.stdout}\n{completed.stderr}",
    )
