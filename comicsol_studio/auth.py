"""Single-creator password login and durable, revocable browser sessions."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from starlette.requests import Request
from starlette.responses import RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from comicsol_studio.config import ConfigError
from comicsol_studio.errors import error_response

AUTH_COOKIE = "comicsol_studio_login"
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
LOGIN_WINDOW = 5 * 60
LOGIN_ATTEMPTS = 10


def _derive(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS
    ).hex()


class LoginThrottled(Exception):
    """Too many login attempts in the current window."""


class Login:
    def __init__(self, data_root: Path, *, clock=time.time) -> None:
        self.path = data_root / "login.sqlite3"
        self.clock = clock
        data_root.mkdir(parents=True, exist_ok=True)
        # Credentials contain only a salted password hash. Restrict the file at creation.
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        with closing(self._connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS owner (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attempts (at REAL NOT NULL);
            """)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=30, isolation_level=None)

    @property
    def enabled(self) -> bool:
        with closing(self._connect()) as db:
            return db.execute("SELECT 1 FROM owner WHERE id = 1").fetchone() is not None

    def set_credentials(self, username: str, password: str) -> None:
        if not username or username != username.strip() or len(username) > 80:
            raise ConfigError("Username must contain 1 to 80 characters without outer spaces.")
        if not 12 <= len(password) <= 1024:
            raise ConfigError("Use a password with 12 to 1024 characters.")
        salt = secrets.token_hex(16)
        password_hash = _derive(password, salt)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR REPLACE INTO owner VALUES (1, ?, ?, ?)",
                       (username, salt, password_hash))
            db.execute("DELETE FROM sessions")
            db.execute("DELETE FROM attempts")
            db.commit()

    def authenticate(self, username: str, password: str) -> str | None:
        now = self.clock()
        # Reserve an attempt before doing expensive password work. This budget is global:
        # it cannot be bypassed by forged proxy/IP headers or a server restart.
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM attempts WHERE at <= ?", (now - LOGIN_WINDOW,))
            count = db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0]
            if count >= LOGIN_ATTEMPTS:
                db.rollback()
                raise LoginThrottled
            db.execute("INSERT INTO attempts VALUES (?)", (now,))
            owner = db.execute("SELECT username, salt, password_hash FROM owner WHERE id = 1").fetchone()
            db.commit()
        if owner is None:
            return None
        supplied = _derive(password, owner[1])
        valid_user = hmac.compare_digest(username.encode(), owner[0].encode())
        if not hmac.compare_digest(supplied, owner[2]) or not valid_user:
            return None
        token = secrets.token_urlsafe(32)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            # A concurrent password reset must not create a session for the old password.
            current = db.execute("SELECT password_hash FROM owner WHERE id = 1").fetchone()
            if current is None or current[0] != owner[2]:
                db.rollback()
                return None
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            # Keep a bounded session history; a fresh login replaces the oldest if full.
            db.execute("DELETE FROM sessions WHERE token_hash IN "
                       "(SELECT token_hash FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 31)")
            db.execute("INSERT INTO sessions VALUES (?, ?)",
                       (hashlib.sha256(token.encode()).hexdigest(), now + SESSION_SECONDS))
            db.commit()
        return token

    def valid(self, token: str) -> bool:
        if not token or len(token) > 128:
            return False
        with closing(self._connect()) as db:
            row = db.execute("SELECT expires FROM sessions WHERE token_hash = ?",
                             (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return row is not None and row[0] > self.clock()

    def revoke(self, token: str) -> None:
        with closing(self._connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?",
                       (hashlib.sha256(token.encode()).hexdigest(),))


class LoginGuard:
    """Protect every Studio page and API before any request body is parsed."""

    def __init__(self, app: ASGIApp, *, login: Login) -> None:
        self.app = app
        self.login = login

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        protected = path in {"/studio", "/api", "/logout"} or path.startswith(("/studio/", "/api/"))
        if protected:
            request = Request(scope)
            if not self.login.valid(request.cookies.get(AUTH_COOKIE, "")):
                if path == "/api" or path.startswith("/api/"):
                    response = error_response(401, "login_required", "Sign in to continue.")
                else:
                    response = RedirectResponse("/login", status_code=303,
                                                headers={"Cache-Control": "no-store"})
                await response(scope, receive, send)
                return

        async def no_private_cache(message: dict) -> None:
            if protected and message["type"] == "http.response.start":
                message["headers"] = [
                    (key, value) for key, value in message.get("headers", ())
                    if key.lower() != b"cache-control"
                ] + [(b"cache-control", b"no-store")]
            await send(message)

        await self.app(scope, receive, no_private_cache)
