"""Loopback launcher for Comic Sol Studio."""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from collections.abc import Sequence

import uvicorn

from comicsol_studio.app import CONSOLE_PATH, create_app
from comicsol_studio.auth import Login
from comicsol_studio.config import DATA_ROOT_VAR, DEFAULT_PORT, ConfigError, StudioConfig


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="comicsol-studio",
        description="Run Comic Sol Studio for one creator on a loopback address.",
    )
    parser.add_argument(
        "--data-root",
        help=f"absolute directory for Studio data (defaults to ${DATA_ROOT_VAR})",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="loopback port")
    parser.add_argument("--set-login", action="store_true",
                        help="set or reset the owner login interactively, then exit")
    args = parser.parse_args(argv)
    try:
        config = StudioConfig.from_env(os.environ, data_root=args.data_root, port=args.port)
        if args.set_login:
            username = input("Username: ").strip()
            password = getpass.getpass("Password (at least 12 characters): ")
            if password != getpass.getpass("Confirm password: "):
                raise ConfigError("Passwords do not match.")
            Login(config.data_root).set_credentials(username, password)
            print("Studio login saved. Existing sessions have been signed out.")
            return 0
        app = create_app(config)
    except ConfigError as error:
        parser.error(str(error))
    print(f"Comic Sol Studio: http://{config.host}:{config.port}/", file=sys.stderr)
    print(f"Console:          http://{config.host}:{config.port}{CONSOLE_PATH}/", file=sys.stderr)
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
