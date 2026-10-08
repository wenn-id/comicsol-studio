"""The GitHub Pages preview build: every link stays under the project path, and the DEMO
layer is added without touching the shipped web files."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from comicsol_studio.app import WEB_DIR

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "pages"
BASE = "/comicsol-studio/"


def load_build():
    spec = importlib.util.spec_from_file_location("pages_build", PAGES / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PagesBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = Path(tempfile.mkdtemp(prefix="comicsol-pages-test-"))
        recording = cls.temp / "recording"
        (recording / "files").mkdir(parents=True)
        (recording / "recording.json").write_text(json.dumps({"steps": []}), encoding="utf-8")
        cls.out = cls.temp / "site"
        load_build().build(recording, cls.out, BASE)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.temp, ignore_errors=True)

    def test_landing_console_and_fallback_pages_exist(self) -> None:
        for relative in ("index.html", "studio/index.html", "404.html", ".nojekyll", "demo/mock.js", "demo/demo.css"):
            with self.subTest(relative=relative):
                self.assertTrue((self.out / relative).is_file())

    def test_demo_layer_loads_before_the_app(self) -> None:
        for relative in ("index.html", "studio/index.html"):
            html = (self.out / relative).read_text(encoding="utf-8")
            with self.subTest(relative=relative):
                self.assertIn(f'<script src="{BASE}demo/mock.js"></script>', html)
                self.assertLess(html.index("demo/mock.js"), html.index("</head>"))

    def test_routes_are_rebased_onto_the_project_path(self) -> None:
        main = (self.out / "assets/js/console/main.js").read_text(encoding="utf-8")
        self.assertIn(f'const BASE = "{BASE}studio";', main)
        self.assertIn("/^\\/comicsol-studio\\/studio\\/p\\/", main)
        landing = (self.out / "index.html").read_text(encoding="utf-8")
        self.assertIn(f'href="{BASE}studio/"', landing)
        self.assertNotIn('"/assets/', landing)

    def test_shipped_web_files_are_untouched(self) -> None:
        self.assertNotIn("mock.js", (WEB_DIR / "index.html").read_text(encoding="utf-8"))
        self.assertIn('const BASE = "/studio";', (WEB_DIR / "assets/js/console/main.js").read_text(encoding="utf-8"))

    def test_demo_script_parses(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is required to check the DEMO script")
        completed = subprocess.run([node, "--check", str(PAGES / "demo" / "mock.js")], capture_output=True, text=True)
        self.assertEqual(0, completed.returncode, completed.stderr)

    def test_original_sample_has_all_its_artwork(self) -> None:
        sample = PAGES / "sample"
        request = json.loads((sample / "source/request.json").read_text(encoding="utf-8"))
        plan = json.loads((sample / "plan/storyboard.json").read_text(encoding="utf-8"))
        cast = json.loads((sample / "plan/character-bible.json").read_text(encoding="utf-8"))
        self.assertEqual(request["title"], "Rooftop Stories")
        self.assertEqual(request["page_count"], len(plan["pages"]))
        subjects = {panel["id"] for page in plan["pages"] for panel in page["panels"]}
        subjects.update(character["id"] for character in cast["characters"])
        self.assertEqual(subjects, request["art"].keys())
        for subject, relative in request["art"].items():
            with self.subTest(subject=subject):
                art = (sample / "source" / relative).resolve()
                self.assertTrue(art.is_relative_to(WEB_DIR / "assets/img"))
                self.assertTrue(art.is_file())


if __name__ == "__main__":
    unittest.main()
