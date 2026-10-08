"""One error shape for every API failure: `{"error": {code, message, hint, details}}`."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi.responses import JSONResponse


class StudioError(Exception):
    """A request Studio refused or could not complete, with a creator-facing message."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        hint: str | None = None,
        *,
        details: Sequence[str] = (),
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.details = tuple(details)


def error_response(
    status: int,
    code: str,
    message: str,
    hint: str | None = None,
    details: Sequence[str] = (),
) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message, "hint": hint, "details": list(details)}},
        status_code=status,
        headers={"cache-control": "no-store"},
    )


def not_found(what: str = "project") -> StudioError:
    return StudioError(404, f"{what}_not_found", f"That {what} does not exist.")


def stale_revision(expected: int, actual: int) -> StudioError:
    return StudioError(
        409,
        "stale_revision",
        "This project changed since you loaded it.",
        "Reload the project to see the latest version.",
        details=(f"expected revision {expected}, current revision {actual}",),
    )


def invalid(message: str, details: Sequence[str] = (), hint: str | None = None) -> StudioError:
    return StudioError(422, "invalid_request", message, hint, details=details)


def conflict(code: str, message: str, hint: str | None = None) -> StudioError:
    return StudioError(409, code, message, hint)
