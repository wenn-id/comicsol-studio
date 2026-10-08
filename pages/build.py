"""Assemble the GitHub Pages preview of Comic Sol Studio.

Copies the real landing page and console from `comicsol_studio/web/`, rebases their
root-absolute links (`/assets/`, `/studio/`, `/`) onto the Pages project path, and adds
the DEMO layer from `pages/demo/` plus a recording made by `pages/record.py`. The
console still calls `/api/*`; the DEMO layer answers those calls in the browser.

    python pages/build.py --recording <record.py output> --out _site --base /comicsol-studio/
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "comicsol_studio" / "web"
DEMO_DIR = Path(__file__).resolve().parent / "demo"


def rebase_rules(base: str) -> list[tuple[str, str]]:
    escaped = base.replace("/", "\\/")
    return [
        ('"/assets/', f'"{base}assets/'),
        ('"/studio', f'"{base}studio'),
        ("`/studio/", f"`{base}studio/"),
        ("/^\\/studio\\/p\\/", f"/^{escaped}studio\\/p\\/"),
        ('href: "/"', f'href: "{base}"'),
        ('location.href = "/"', f'location.href = "{base}"'),
        ('href="/"', f'href="{base}"'),
    ]


# Path suffixes the console appends to an already rebased route, not routes of their own.
ROUTE_SUFFIXES = frozenset({"`/${stage}", '"/plan'})


def leftover_root_paths(text: str, base: str) -> list[str]:
    """Quoted root-absolute paths that would escape the Pages project path."""
    pattern = re.compile(r"""(["'`])/(?!api/|/|\1)([^"'`\s]*)""")
    return [
        match.group(0)
        for match in pattern.finditer(text)
        if not ("/" + match.group(2)).startswith(base) and match.group(0) not in ROUTE_SUFFIXES
    ]


def build(recording: Path, out: Path, base: str) -> None:
    if not base.startswith("/") or not base.endswith("/"):
        raise SystemExit("--base must start and end with '/'")
    if not (recording / "recording.json").is_file():
        raise SystemExit(f"{recording} has no recording.json; run pages/record.py first")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(WEB_DIR / "assets", out / "assets")
    shutil.copy2(WEB_DIR / "index.html", out / "index.html")
    (out / "studio").mkdir()
    shutil.copy2(WEB_DIR / "studio.html", out / "studio" / "index.html")
    shutil.copytree(recording, out / "demo")
    for name in ("mock.js", "demo.css"):
        shutil.copy2(DEMO_DIR / name, out / "demo" / name)

    rules = rebase_rules(base)
    injection = (
        f'  <link rel="stylesheet" href="{base}demo/demo.css">\n'
        f'  <script src="{base}demo/mock.js"></script>\n'
    )
    problems: list[str] = []
    sources = [out / "index.html", out / "studio" / "index.html", *sorted((out / "assets" / "js").rglob("*.js"))]
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for old, new in rules:
            text = text.replace(old, new)
        if path.suffix == ".html":
            if text.count("</head>") != 1:
                raise SystemExit(f"{path.name} no longer has exactly one </head>")
            text = text.replace("</head>", injection + "</head>")
        path.write_text(text, encoding="utf-8")
        problems += [f"{path.relative_to(out)}: {found}" for found in leftover_root_paths(text, base)]
    if problems:
        raise SystemExit("Root-absolute paths left after rebasing:\n" + "\n".join(problems))

    # GitHub Pages answers unknown paths with 404.html: the console shell, so a reload
    # on a console route (for example studio/p/<id>/review) still opens the console.
    shutil.copy2(out / "studio" / "index.html", out / "404.html")
    (out / ".nojekyll").write_text("", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--recording", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base", default="/comicsol-studio/")
    args = parser.parse_args()
    build(args.recording, args.out, args.base)


if __name__ == "__main__":
    main()
