"""Studio configuration: one absolute data root, served on a loopback address only."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DATA_ROOT_VAR = "COMICSOL_STUDIO_DATA_ROOT"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766

OPENAI_KEY_VAR = "OPENAI_API_KEY"
ANTHROPIC_KEY_VAR = "ANTHROPIC_API_KEY"
OPENAI_IMAGE_MODEL_VAR = "COMICSOL_STUDIO_OPENAI_IMAGE_MODEL"
OPENAI_TEXT_MODEL_VAR = "COMICSOL_STUDIO_OPENAI_TEXT_MODEL"
ANTHROPIC_TEXT_MODEL_VAR = "COMICSOL_STUDIO_ANTHROPIC_TEXT_MODEL"
DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2"
DEFAULT_OPENAI_TEXT_MODEL = "gpt-5.4-mini"
DEFAULT_ANTHROPIC_TEXT_MODEL = "claude-opus-5-5"

_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}\Z")


class ConfigError(ValueError):
    """The requested configuration is unsafe or incomplete."""


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class ProviderKeys:
    """Provider credentials read from the launching environment. Never sent to the page."""

    openai: str | None = None
    anthropic: str | None = None
    openai_image_model: str = DEFAULT_OPENAI_IMAGE_MODEL
    openai_text_model: str = DEFAULT_OPENAI_TEXT_MODEL
    anthropic_text_model: str = DEFAULT_ANTHROPIC_TEXT_MODEL

    def __repr__(self) -> str:  # keys must never reach logs
        return (
            f"ProviderKeys(openai={'set' if self.openai else 'unset'}, "
            f"anthropic={'set' if self.anthropic else 'unset'})"
        )

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> ProviderKeys:
        def model(variable: str, default: str) -> str:
            value = environ.get(variable, default).strip()
            if not _MODEL_ID.fullmatch(value):
                raise ConfigError(f"{variable} is not a valid model identifier")
            return value

        return cls(
            openai=environ.get(OPENAI_KEY_VAR, "").strip() or None,
            anthropic=environ.get(ANTHROPIC_KEY_VAR, "").strip() or None,
            openai_image_model=model(OPENAI_IMAGE_MODEL_VAR, DEFAULT_OPENAI_IMAGE_MODEL),
            openai_text_model=model(OPENAI_TEXT_MODEL_VAR, DEFAULT_OPENAI_TEXT_MODEL),
            anthropic_text_model=model(ANTHROPIC_TEXT_MODEL_VAR, DEFAULT_ANTHROPIC_TEXT_MODEL),
        )


@dataclass(frozen=True)
class StudioConfig:
    data_root: Path
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    keys: ProviderKeys = field(default_factory=ProviderKeys)

    def __post_init__(self) -> None:
        if not self.data_root.is_absolute():
            raise ConfigError(f"{DATA_ROOT_VAR} must be an absolute path")
        if not is_loopback(self.host):
            raise ConfigError("Studio serves loopback addresses only")
        if not 0 < self.port < 65536:
            raise ConfigError("port must be between 1 and 65535")

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str],
        *,
        data_root: str | None = None,
        port: int = DEFAULT_PORT,
    ) -> StudioConfig:
        raw = data_root or environ.get(DATA_ROOT_VAR, "")
        if not raw:
            raise ConfigError(f"set {DATA_ROOT_VAR} or pass --data-root")
        return cls(data_root=Path(raw), port=port, keys=ProviderKeys.from_env(environ))

    @property
    def database_path(self) -> Path:
        return self.data_root / "studio.sqlite3"

    @property
    def projects_root(self) -> Path:
        return self.data_root / "projects"

    @property
    def staging_root(self) -> Path:
        return self.data_root / "staging"

    @property
    def exports_root(self) -> Path:
        return self.data_root / "exports"

    @property
    def trash_root(self) -> Path:
        return self.data_root / "trash"

    def allowed_hosts(self) -> frozenset[str]:
        """`Host` header values a browser on this machine sends to the server."""
        names = ("127.0.0.1", "localhost", "[::1]")
        return frozenset({*(f"{name}:{self.port}" for name in names), *names})
