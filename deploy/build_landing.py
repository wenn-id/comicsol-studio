"""Build the public landing only. Never publish the Studio console or API fixtures."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "comicsol_studio" / "web"


def build(output: Path, studio_origin: str = "https://studio.comicsol.com") -> None:
    if not (studio_origin.startswith("https://") and studio_origin.count("/") == 2):
        raise ValueError("Studio origin must be an HTTPS origin without a path")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copytree(WEB / "assets", output / "assets")
    source = (WEB / "index.html").read_text(encoding="utf-8")
    source = source.replace('href="/studio/"', f'href="{studio_origin}/studio/"')
    source = source.replace('All of it runs on your own machine.', 'Create your comic in Studio.')
    # The landing has a built-in static fallback for engine facts.
    (output / "index.html").write_text(source, encoding="utf-8")
    (output / "_headers").write_text(
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  X-Frame-Options: DENY\n"
        "  Permissions-Policy: camera=(), microphone=(), geolocation=()\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("public_site"))
    parser.add_argument("--studio-origin", default="https://studio.comicsol.com")
    args = parser.parse_args()
    build(args.out.resolve(), args.studio_origin)
