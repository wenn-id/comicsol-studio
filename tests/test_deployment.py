"""Regression checks for production origin and separate public landing."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

from comicsol_studio.app import create_app
from comicsol_studio.config import StudioConfig, ConfigError
from deploy.build_landing import build


class ProductionTests(unittest.TestCase):
    def test_origin_validation(self):
        root = Path(tempfile.gettempdir())
        for value in ("http://studio.example.com", "https://studio.example.com/path", "https://studio.example.com/", "https://evil@example.com", "https://127.0.0.1", "https://studio.example.com:8766"):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                StudioConfig(data_root=root, public_origin=value)
        cfg = StudioConfig(data_root=root, public_origin="https://studio.comicsol.com")
        self.assertIn("studio.comicsol.com", cfg.allowed_hosts())
        self.assertNotIn("evil.com", cfg.allowed_hosts())

    def test_https_host_csrf_and_secure_cookie(self):
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(StudioConfig(data_root=Path(temp), public_origin="https://studio.comicsol.com"))
            with TestClient(app, base_url="https://studio.comicsol.com") as client:
                response = client.get("/api/session")
                self.assertEqual(200, response.status_code)
                self.assertIn("secure", response.headers["set-cookie"].lower())
                token = response.json()["csrfToken"]
                good = client.post("/api/projects", json={"starter": "minimal-one-page"}, headers={"origin": "https://studio.comicsol.com", "x-csrf-token": token})
                self.assertEqual(201, good.status_code, good.text)
                bad = client.post("/api/projects", json={"starter": "minimal-one-page"}, headers={"origin": "https://evil.com", "x-csrf-token": token})
                self.assertEqual(403, bad.status_code)
                foreign_host = client.get("/api/session", headers={"host": "evil.com"})
                self.assertEqual(400, foreign_host.status_code)

    def test_static_public_build_has_no_backend(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "site"
            build(output)
            self.assertTrue((output / "index.html").is_file())
            self.assertTrue((output / "assets").is_dir())
            self.assertIn("https://studio.comicsol.com/studio/", (output / "index.html").read_text())
            self.assertFalse((output / "studio").exists())
            self.assertFalse((output / "demo").exists())


if __name__ == "__main__":
    unittest.main()
