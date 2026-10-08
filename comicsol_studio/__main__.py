"""Loopback launcher for Comic Sol Studio."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence

import uvicorn

from comicsol_studio.app import CONSOLE_PATH, create_app
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
    args = parser.parse_args(argv)
    try:
        config = StudioConfig.from_env(os.environ, data_root=args.data_root, port=args.port)
        app = create_app(config)
    except ConfigError as error:
        parser.error(str(error))
    print(f"Comic Sol Studio: http://{config.host}:{config.port}/", file=sys.stderr)
    print(f"Console:          http://{config.host}:{config.port}{CONSOLE_PATH}/", file=sys.stderr)
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
