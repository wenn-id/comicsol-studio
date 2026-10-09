"""Loopback security: Host and Origin checks, CSRF for every write, and response headers.

Studio is single-user and binds loopback only. The browser receives a CSRF token from
`GET /api/session` (cookie plus response body). Every state-changing request must echo
it in `X-CSRF-Token`; tokens are signed with a secret kept in the Studio database, so
they survive a restart.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from comicsol_studio.config import StudioConfig
from comicsol_studio.errors import StudioError, error_response
from comicsol_studio.store import Store

CSRF_COOKIE = "comicsol_studio_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    )
)
SECURITY_HEADERS = (
    (b"content-security-policy", CONTENT_SECURITY_POLICY.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
)


class CsrfTokens:
    def __init__(self, store: Store) -> None:
        self._secret = bytes.fromhex(store.set_meta_once("csrf_secret", secrets.token_hex(32)))

    def issue(self) -> str:
        nonce = secrets.token_urlsafe(24)
        return f"{nonce}.{self._sign(nonce)}"

    def valid(self, token: str) -> bool:
        nonce, _, signature = token.partition(".")
        return bool(nonce) and hmac.compare_digest(signature, self._sign(nonce))

    def _sign(self, nonce: str) -> str:
        return hmac.new(self._secret, nonce.encode(), hashlib.sha256).hexdigest()


class HostGuard:
    """Reject requests whose `Host` is not this loopback server, and add security headers.

    A page on another site can point its own hostname at 127.0.0.1 (DNS rebinding); its
    requests still carry that hostname, so they stop here.
    """

    def __init__(self, app: ASGIApp, *, allowed_hosts: frozenset[str]) -> None:
        self.app = app
        self.allowed_hosts = allowed_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        host = ""
        for name, value in scope.get("headers", ()):
            if name == b"host":
                host = value.decode("latin-1").lower()
                break
        if host not in self.allowed_hosts:
            response = error_response(
                400, "invalid_host", "Studio only answers on its loopback address."
            )
            await response(scope, receive, send)
            return

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", ()), *SECURITY_HEADERS]
            await send(message)

        await self.app(scope, receive, send_with_headers)


def same_origin(request: Request, config: StudioConfig) -> bool:
    origin = request.headers.get("origin")
    if origin is None:
        return True
    local_origins = {f"http://{host}" for host in config.allowed_hosts() if ":" in host}
    if config.public_origin:
        local_origins.add(config.public_origin)
    return origin.lower() in local_origins


def require_writer(request: Request) -> None:
    if request.method in SAFE_METHODS:
        return
    config: StudioConfig = request.app.state.config
    if not same_origin(request, config):
        raise StudioError(403, "cross_origin", "Studio refused a request from another site.")
    tokens: CsrfTokens = request.app.state.csrf
    header = request.headers.get(CSRF_HEADER, "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not header or not hmac.compare_digest(header, cookie) or not tokens.valid(header):
        raise StudioError(
            403, "csrf_failed", "Studio could not verify this request.", "Reload the page."
        )
