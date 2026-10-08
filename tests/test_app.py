"""Server composition and launcher contracts for Studio Next."""

from __future__ import annotations

import fnmatch
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from comic_sol_web.config import WebConfig
from fastapi.testclient import TestClient

from comic_sol_studio_next import __main__ as launcher
from comic_sol_studio_next import app as studio_app
from tests.support import ROOT, UI_DIR, ui_files


class StudioAppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data_root = Path(tempfile.mkdtemp(prefix="studio-next-"))
        config = WebConfig.local_from_env({"COMIC_SOL_WEB_DATA_ROOT": str(self.data_root)})
        self.client = TestClient(studio_app.create_studio_app(config))

    def test_root_redirects_to_the_interface(self) -> None:
        response = self.client.get("/", follow_redirects=False)
        self.assertEqual(307, response.status_code)
        self.assertEqual("/studio/", response.headers["location"])

    def test_every_interface_file_is_served_and_revalidated(self) -> None:
        index = self.client.get("/studio/")
        self.assertEqual(200, index.status_code)
        self.assertIn("text/html", index.headers["content-type"])
        for path in ui_files():
            relative = path.relative_to(UI_DIR).as_posix()
            with self.subTest(asset=relative):
                response = self.client.get(f"/studio/{relative}")
                self.assertEqual(200, response.status_code)
                self.assertEqual("no-cache", response.headers.get("cache-control"))
                self.assertEqual(path.read_bytes(), response.content)

    def test_backend_routes_stay_reachable_beside_the_interface(self) -> None:
        self.assertEqual({"status": "ok"}, self.client.get("/healthz").json())
        for module in studio_app.BACKEND_MODULES:
            with self.subTest(module=module):
                self.assertEqual(200, self.client.get(f"/static/{module}").status_code)
        # Without a session the project API refuses the write; it is not shadowed.
        rejected = self.client.post("/api/projects", json={})
        self.assertIn(rejected.status_code, {401, 403})

    def test_missing_backend_module_fails_closed(self) -> None:
        empty = Path(tempfile.mkdtemp(prefix="studio-next-static-"))
        self.assertEqual(studio_app.BACKEND_MODULES, studio_app.missing_backend_modules(empty))
        config = WebConfig.local_from_env({"COMIC_SOL_WEB_DATA_ROOT": str(self.data_root)})
        with (
            mock.patch.object(studio_app, "missing_backend_modules", return_value=("api.js",)),
            self.assertRaises(studio_app.MissingBackendModuleError),
        ):
            studio_app.create_studio_app(config)

    def test_package_data_declares_every_interface_file(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        patterns = project["tool"]["setuptools"]["package-data"]["comic_sol_studio_next"]
        package = ROOT / "comic_sol_studio_next"
        for path in ui_files():
            relative = path.relative_to(package).as_posix()
            with self.subTest(file=relative):
                self.assertTrue(
                    any(fnmatch.fnmatchcase(relative, pattern) for pattern in patterns),
                    f"{relative} is not packaged",
                )


class LauncherTests(unittest.TestCase):
    def run_launcher(self, *arguments: str) -> mock.MagicMock:
        data_root = tempfile.mkdtemp(prefix="studio-next-launch-")
        with (
            mock.patch.object(launcher, "create_studio_app") as create,
            mock.patch.object(launcher.uvicorn, "run") as run,
            mock.patch("sys.stderr"),
        ):
            self.assertEqual(0, launcher.main(["--data-root", data_root, *arguments]))
        run.assert_called_once()
        self.assertEqual("127.0.0.1", run.call_args.kwargs["host"])
        return create

    def test_agent_route_is_offered_only_when_asked(self) -> None:
        plain = self.run_launcher()
        self.assertEqual(frozenset(), plain.call_args.kwargs["active_agent_image_capabilities"])
        agent = self.run_launcher("--agent-images")
        self.assertEqual(
            frozenset({"text_to_image"}),
            agent.call_args.kwargs["active_agent_image_capabilities"],
        )

    def test_relative_data_root_is_rejected(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit) as raised:
            launcher.main(["--data-root", "relative/path"])
        self.assertEqual(2, raised.exception.code)


if __name__ == "__main__":
    unittest.main()
