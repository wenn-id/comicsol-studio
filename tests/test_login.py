"""Single-owner login protects page, API, files, sessions, and credential reset."""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from comicsol_studio import __main__ as launcher
from comicsol_studio.app import create_app
from comicsol_studio.auth import (
    AUTH_COOKIE, LOGIN_ATTEMPTS, LOGIN_WINDOW, SESSION_SECONDS, Login, LoginThrottled,
)
from comicsol_studio.config import ConfigError, StudioConfig

PASSWORD = "a-test-password-123"
ORIGIN = "https://studio.comicsol.com"


class LoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        Login(self.root).set_credentials("owner", PASSWORD)
        self.app = create_app(StudioConfig(data_root=self.root, public_origin=ORIGIN))
        self.client = TestClient(self.app, base_url=ORIGIN, follow_redirects=False)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def form(self):
        page = self.client.get("/login")
        self.assertEqual(200, page.status_code)
        self.assertEqual("no-store", page.headers["cache-control"])
        return {"username": "owner", "password": PASSWORD,
                "csrf": re.search(r'name="csrf" value="([^"]+)"', page.text)[1]}

    def sign_in(self):
        response = self.client.post("/login", data=self.form(), headers={"origin": ORIGIN})
        self.assertEqual(303, response.status_code, response.text)
        self.assertEqual("/studio/", response.headers["location"])
        return response

    def test_anonymous_pages_and_all_api_methods_are_blocked(self):
        for path in ("/studio", "/studio/", "/studio/p/abc/render"):
            response = self.client.get(path)
            self.assertEqual(303, response.status_code)
            self.assertEqual("/login", response.headers["location"])
        for method, path in (
            ("GET", "/api/session"), ("GET", "/api/engine"), ("GET", "/api/projects"),
            ("POST", "/api/projects"), ("DELETE", "/api/projects/abc"),
            ("GET", "/api/projects/abc/files/pages/1.pdf"),
        ):
            with self.subTest(method=method, path=path):
                response = self.client.request(method, path)
                self.assertEqual(401, response.status_code)
                self.assertEqual("login_required", response.json()["error"]["code"])
                self.assertEqual("no-store", response.headers["cache-control"])
        self.assertEqual(200, self.client.get("/").status_code)
        self.assertEqual({"status": "ok"}, self.client.get("/healthz").json())
        self.assertEqual(200, self.client.get("/assets/css/login.css").status_code)

    def test_success_uses_secure_cookie_and_protects_writes_with_csrf(self):
        response = self.sign_in()
        header = response.headers.get_list("set-cookie")[0].lower()
        for flag in ("httponly", "secure", "samesite=strict", f"max-age={SESSION_SECONDS}"):
            self.assertIn(flag, header)
        self.assertNotIn(PASSWORD, response.text)
        self.assertEqual(303, self.client.get("/login").status_code)
        page = self.client.get("/studio/")
        self.assertEqual(200, page.status_code)
        self.assertEqual("no-store", page.headers["cache-control"])
        self.assertEqual(403, self.client.post("/api/projects", json={}).status_code)
        session = self.client.get("/api/session").json()
        self.assertTrue(session["loginEnabled"])
        created = self.client.post("/api/projects", json={"starter": "minimal-one-page"},
                                   headers={"x-csrf-token": session["csrfToken"], "origin": ORIGIN})
        self.assertEqual(201, created.status_code, created.text)
        self.assertEqual(200, self.client.get("/api/projects").status_code)

    def test_wrong_credentials_are_generic_and_never_echoed(self):
        for changes in ({"username": "missing"}, {"password": "wrong-password"}):
            form = {**self.form(), **changes}
            response = self.client.post("/login", data=form)
            self.assertEqual(401, response.status_code)
            self.assertIn("Username or password is incorrect.", response.text)
            self.assertNotIn(PASSWORD, response.text)
            self.assertNotIn(AUTH_COOKIE, response.headers.get("set-cookie", ""))

    def test_login_csrf_origin_and_body_limit(self):
        self.assertEqual(403, self.client.post("/login", data={"username": "owner", "password": PASSWORD}).status_code)
        form = self.form()
        self.assertEqual(403, self.client.post("/login", data=form, headers={"origin": "https://evil.com"}).status_code)
        form = self.form()
        form["csrf"] += "tampered"
        self.assertEqual(403, self.client.post("/login", data=form).status_code)
        self.assertEqual(413, self.client.post("/login", content=b"a" * (16 * 1024 + 1)).status_code)
        self.assertEqual(400, self.client.post("/login", content=b"\xff").status_code)

    def test_logout_revokes_session_and_requires_csrf(self):
        self.sign_in()
        token = self.client.cookies.get(AUTH_COOKIE)
        self.assertEqual(403, self.client.post("/logout").status_code)
        csrf = self.client.get("/api/session").json()["csrfToken"]
        response = self.client.post("/logout", headers={"x-csrf-token": csrf, "origin": ORIGIN})
        self.assertEqual(303, response.status_code)
        self.assertEqual("/login", response.headers["location"])
        self.assertIsNone(self.client.cookies.get(AUTH_COOKIE))
        # A stolen or restored old cookie cannot be replayed after logout.
        self.client.cookies.set(AUTH_COOKIE, token)
        self.assertEqual(401, self.client.get("/api/projects").status_code)

    def test_sessions_survive_restart_but_expire_and_reject_tampering(self):
        self.sign_in()
        token = self.client.cookies.get(AUTH_COOKIE)
        restarted = Login(self.root)
        self.assertTrue(restarted.valid(token))
        self.assertFalse(restarted.valid(token + "x"))
        self.assertFalse(restarted.valid("x" * 129))
        self.app.state.login.clock = lambda: restarted.clock() + SESSION_SECONDS + 1
        self.assertEqual(401, self.client.get("/api/projects").status_code)

    def test_password_reset_revokes_existing_sessions(self):
        self.sign_in()
        self.app.state.login.set_credentials("new-owner", "a-new-password-456")
        self.assertEqual(401, self.client.get("/api/projects").status_code)
        self.assertIsNone(self.app.state.login.authenticate("owner", PASSWORD))
        self.assertIsNotNone(self.app.state.login.authenticate("new-owner", "a-new-password-456"))
        self.assertNotIn(PASSWORD.encode(), self.app.state.login.path.read_bytes())

    def test_rate_limit_is_persistent_and_returns_retry_after(self):
        now = self.app.state.login.clock()
        self.app.state.login.clock = lambda: now
        for _ in range(LOGIN_ATTEMPTS):
            self.assertIsNone(self.app.state.login.authenticate("owner", "incorrect"))
        with self.assertRaises(LoginThrottled):
            Login(self.root).authenticate("owner", PASSWORD)
        response = self.client.post("/login", data=self.form())
        self.assertEqual(429, response.status_code)
        self.assertEqual("300", response.headers["retry-after"])
        self.app.state.login.clock = lambda: now + LOGIN_WINDOW + 1
        self.assertIsNotNone(self.app.state.login.authenticate("owner", PASSWORD))


class LoginSetupTests(unittest.TestCase):
    def test_first_credentials_protect_an_already_running_local_app(self):
        with tempfile.TemporaryDirectory() as root:
            app = create_app(StudioConfig(data_root=Path(root)))
            with TestClient(app, base_url="http://127.0.0.1:8766", follow_redirects=False) as client:
                self.assertEqual(200, client.get("/api/session").status_code)
                login = Login(Path(root))
                login.set_credentials("owner", PASSWORD)
                for path in ("/api/session", "/api/projects", "/api/projects/x/files/page.png"):
                    self.assertEqual(401, client.get(path).status_code)
                self.assertEqual("/login", client.get("/studio/").headers["location"])
                client.cookies.set(AUTH_COOKIE, login.authenticate("owner", PASSWORD))
                self.assertEqual(200, client.get("/api/session").status_code)
                login.set_credentials("owner", "new-password-456")
                self.assertEqual(401, client.get("/api/session").status_code)

    def test_public_origin_fails_closed_without_credentials(self):
        with tempfile.TemporaryDirectory() as root, self.assertRaises(ConfigError):
            create_app(StudioConfig(data_root=Path(root), public_origin=ORIGIN))

    def test_local_mode_remains_available_without_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            app = create_app(StudioConfig(data_root=Path(root)))
            with TestClient(app, base_url="http://127.0.0.1:8766") as client:
                self.assertEqual(200, client.get("/api/session").status_code)

    def test_set_login_prompts_without_starting_server(self):
        with (
            tempfile.TemporaryDirectory() as root,
            mock.patch("builtins.input", return_value="owner"),
            mock.patch.object(launcher.getpass, "getpass", side_effect=[PASSWORD, PASSWORD]),
            mock.patch.object(launcher.uvicorn, "run") as run,
            mock.patch("builtins.print"),
        ):
            self.assertEqual(0, launcher.main(["--data-root", root, "--set-login"]))
            self.assertTrue(Login(Path(root)).enabled)
            run.assert_not_called()

    def test_credentials_need_a_nonempty_username_and_long_password(self):
        with tempfile.TemporaryDirectory() as root:
            login = Login(Path(root))
            for username, password in (("", PASSWORD), (" owner ", PASSWORD), ("owner", "short")):
                with self.assertRaises(ConfigError):
                    login.set_credentials(username, password)


if __name__ == "__main__":
    unittest.main()
