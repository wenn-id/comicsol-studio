"""Server composition, loopback security, static pages, rasters, and the launcher."""

from __future__ import annotations

import ast
import fnmatch
import io
import re
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from comicsol_studio import __main__ as launcher
from comicsol_studio import rasters
from comicsol_studio.app import WEB_DIR
from comicsol_studio.config import ConfigError, ProviderKeys, StudioConfig
from tests.support import ROOT, StudioClient, png_bytes

PACKAGE = ROOT / "comicsol_studio"


class SecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = StudioClient()

    def tearDown(self) -> None:
        self.client.close()

    def test_foreign_host_is_refused(self) -> None:
        response = self.client.http.get("/api/session", headers={"host": "evil.example:8766"})
        self.assertEqual(400, response.status_code)
        self.assertEqual("invalid_host", response.json()["error"]["code"])

    def test_writes_need_the_csrf_token(self) -> None:
        bare = self.client.http.post("/api/projects", json={"starter": "minimal-one-page"})
        self.assertEqual(403, bare.status_code)
        self.client.http.cookies.set("comicsol_studio_csrf", "abc.def")
        forged = self.client.http.post(
            "/api/projects", json={"starter": "minimal-one-page"}, headers={"x-csrf-token": "abc.def"}
        )
        self.assertEqual(403, forged.status_code)

    def test_cross_origin_writes_are_refused(self) -> None:
        response = self.client.post(
            "/api/projects",
            json={"starter": "minimal-one-page"},
            headers={"origin": "https://evil.example"},
        )
        self.assertEqual("cross_origin", response.json()["error"]["code"])

    def test_tokens_survive_a_restart(self) -> None:
        from comicsol_studio.security import CsrfTokens

        self.assertTrue(CsrfTokens(self.client.studio.store).valid(self.client.csrf))

    def test_security_headers(self) -> None:
        headers = self.client.get("/").headers
        self.assertIn("default-src 'self'", headers["content-security-policy"])
        self.assertEqual("nosniff", headers["x-content-type-options"])
        self.assertEqual("DENY", headers["x-frame-options"])
        self.assertEqual("no-store", self.client.get("/api/projects").headers["cache-control"])


class PagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = StudioClient()

    def tearDown(self) -> None:
        self.client.close()

    def test_landing_console_and_deep_links(self) -> None:
        self.assertIn("text/html", self.client.get("/").headers["content-type"])
        self.assertEqual(307, self.client.get("/studio", follow_redirects=False).status_code)
        console = self.client.get("/studio/").text
        for route in ("/studio/projects/abc/plan", "/studio/new"):
            with self.subTest(route=route):
                self.assertEqual(console, self.client.get(route).text)

    def test_every_asset_is_served_and_revalidated(self) -> None:
        for path in sorted((WEB_DIR / "assets").rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(WEB_DIR).as_posix()
            with self.subTest(asset=relative):
                response = self.client.get(f"/{relative}")
                self.assertEqual(200, response.status_code)
                self.assertEqual("no-cache", response.headers["cache-control"])

    def test_healthz(self) -> None:
        self.assertEqual({"status": "ok"}, self.client.get("/healthz").json())


class RasterTests(unittest.TestCase):
    def test_exact_jobs_are_cropped_and_resized(self) -> None:
        result = rasters.conform(png_bytes(2000, 1000), width=736, height=1120, exact=True)
        self.assertTrue(result.cropped)
        with Image.open(io.BytesIO(result.png)) as image:
            self.assertEqual((736, 1120), image.size)
            self.assertEqual("RGB", image.mode)

    def test_alpha_is_flattened_and_small_references_grow(self) -> None:
        result = rasters.conform(png_bytes(300, 400, mode="RGBA"), width=1024, height=1024, exact=False)
        with Image.open(io.BytesIO(result.png)) as image:
            self.assertEqual("RGB", image.mode)
            self.assertGreaterEqual(min(image.size), rasters.MIN_SIDE)

    def test_unreadable_input(self) -> None:
        for payload in (b"", b"not an image", b"GIF89a" + b"0" * 32):
            with self.subTest(payload=payload[:8]), self.assertRaises(rasters.RasterError):
                rasters.conform(payload, width=512, height=512, exact=True)


class ConfigAndLauncherTests(unittest.TestCase):
    def test_relative_root_and_remote_host_are_refused(self) -> None:
        with self.assertRaises(ConfigError):
            StudioConfig(data_root=Path("relative"))
        with self.assertRaises(ConfigError):
            StudioConfig(data_root=Path(tempfile.gettempdir()), host="0.0.0.0")

    def test_keys_never_appear_in_repr(self) -> None:
        keys = ProviderKeys.from_env({"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "sk-ant-secret"})
        self.assertNotIn("secret", repr(keys))
        with self.assertRaises(ConfigError):
            ProviderKeys.from_env({"COMICSOL_STUDIO_OPENAI_IMAGE_MODEL": "bad model id"})

    def test_launcher_binds_loopback(self) -> None:
        with (
            mock.patch.object(launcher, "create_app") as create,
            mock.patch.object(launcher.uvicorn, "run") as run,
            mock.patch("sys.stderr"),
        ):
            self.assertEqual(0, launcher.main(["--data-root", tempfile.mkdtemp(), "--port", "9001"]))
        create.assert_called_once()
        self.assertEqual("127.0.0.1", run.call_args.kwargs["host"])
        self.assertEqual(9001, run.call_args.kwargs["port"])

    def test_launcher_rejects_a_relative_root(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit) as raised:
            launcher.main(["--data-root", "relative/path"])
        self.assertEqual(2, raised.exception.code)


class IndependenceTests(unittest.TestCase):
    """Studio stands alone on the engine: no legacy backend, no engine internals."""

    def python_sources(self) -> dict[Path, str]:
        return {path: path.read_text(encoding="utf-8") for path in PACKAGE.rglob("*.py")}

    def test_no_legacy_backend_anywhere(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        self.assertFalse(any("comic-sol-web" in dep for dep in project["project"]["dependencies"]))
        for path, source in self.python_sources().items():
            tree = ast.parse(source)
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module]
                for name in names:
                    with self.subTest(file=path.name, module=name):
                        self.assertFalse(name.startswith("comic_sol_web"))
        for path in WEB_DIR.rglob("*.js"):
            if "vendor" in path.parts:
                continue
            with self.subTest(file=path.name):
                self.assertNotIn('"/static/', path.read_text(encoding="utf-8"))

    def test_engine_is_reached_only_through_the_bridge_and_public_names(self) -> None:
        for path, source in self.python_sources().items():
            if path.name == "engine.py":
                continue
            with self.subTest(file=path.name):
                self.assertNotIn("comic_sol_product", source)
        bridge = (PACKAGE / "engine.py").read_text(encoding="utf-8")
        private = re.findall(r'module\("[a-z_]+"\)\._[a-z]', bridge)
        self.assertEqual([], private)
        for line in bridge.splitlines():
            match = re.search(r"\b(comic_sol|validation|character_identity|character_quality|"
                              r"project_io|repair_strategy|quality_records|core|page_quality)\._[a-z]", line)
            self.assertIsNone(match, line)

    def test_package_data_declares_every_web_file(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        patterns = project["tool"]["setuptools"]["package-data"]["comicsol_studio"]
        for path in WEB_DIR.rglob("*"):
            if path.is_file():
                relative = path.relative_to(PACKAGE).as_posix()
                with self.subTest(file=relative):
                    # setuptools globs do not cross "/", so the depth must match too.
                    self.assertTrue(
                        any(
                            fnmatch.fnmatchcase(relative, p) and p.count("/") == relative.count("/")
                            for p in patterns
                        ),
                        relative,
                    )


if __name__ == "__main__":
    unittest.main()
