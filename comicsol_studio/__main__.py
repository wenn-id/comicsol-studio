"""Loopback launcher for comicsol-studio."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence

import uvicorn
from comic_sol_web.config import DATA_ROOT_VAR, WebConfig, WebConfigError

from comicsol_studio.app import (
    UI_PATH,
    MissingBackendModuleError,
    create_studio_app,
)

DEFAULT_PORT = 8766


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="comicsol-studio",
        description="Run the single-user comicsol-studio on a loopback address.",
    )
    parser.add_argument(
        "--data-root",
        help=f"absolute directory for Studio data (defaults to ${DATA_ROOT_VAR})",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="loopback port")
    parser.add_argument(
        "--agent-images",
        action="store_true",
        help="offer the agent-native image route: a local agent session supplies rasters",
    )
    args = parser.parse_args(argv)

    environ = dict(os.environ)
    if args.data_root:
        environ[DATA_ROOT_VAR] = args.data_root
    try:
        config = WebConfig.local_from_env(environ)
        capabilities = frozenset({"text_to_image"}) if args.agent_images else frozenset()
        app = create_studio_app(config, active_agent_image_capabilities=capabilities)
    except (WebConfigError, MissingBackendModuleError) as error:
        parser.error(str(error))

    print(f"comicsol-studio: http://{config.host}:{args.port}{UI_PATH}/", file=sys.stderr)
    uvicorn.run(app, host=config.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
