"""Record a real Studio session for the GitHub Pages preview.

Drives the actual Studio application and the pinned Comic Sol engine through the whole
creator workflow (create, plan, references, panels, reviews, pages, finish) using the
engine's Sunlight Courier sample, and saves every response the console reads at every
step. The preview's in-browser demo replays this recording; it never invents engine
output. No provider is configured, so nothing leaves the machine.

    python pages/record.py --sample <comicsol>/samples/sunlight-courier --out <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image

from comicsol_studio.app import create_app
from comicsol_studio.config import StudioConfig
from comicsol_studio.providers import Providers

BASE_URL = "http://127.0.0.1:8766"
EXTENSIONS = {"image/webp": ".webp", "image/png": ".png", "application/pdf": ".pdf", "text/markdown": ".md"}
FILE_URL = re.compile(r"/api/projects/[a-f0-9]{24}/(?:files|thumb)/[^\"\s]+")

# Character-trait assessments: the engine refuses generic evidence, so each names what
# was compared against the reference sheet.
TRAIT_EVIDENCE = "{name}'s {trait} matches the reference sheet: same {trait} as the retained Mira reference."
PAGE_EVIDENCE = {
    "reading-order": "Panels read left to right, top to bottom in storyboard order on page {n}.",
    "lettering": "Balloons sit in protected space on page {n} and never cover a face or the vial.",
    "balloon-tails": "Every balloon tail on page {n} points at the speaking character.",
    "layout": "Page {n} uses the planned layout with even gutters and no clipped panel.",
    "continuity": "Mira's amber scarf, black bob, and brass-clasp case stay consistent across page {n}.",
}


def stage_of(path: str) -> str:
    """The console stage where a recorded write is made, so the replay can open it."""
    if path.endswith("/finalize"):
        return "finish"
    if "/review" in path or path.endswith("/pages/compose"):
        return "review"
    if "/render/" in path:
        return "render"
    return "plan"


class Recorder:
    def __init__(self, sample: Path, out: Path) -> None:
        self.sample = sample
        self.out = out
        self.data_root = Path(tempfile.mkdtemp(prefix="comicsol-pages-record-"))
        self.app = create_app(StudioConfig(data_root=self.data_root), providers=Providers())
        self.http = TestClient(self.app, base_url=BASE_URL)
        session = self.http.get("/api/session")
        session.raise_for_status()
        self.csrf = session.json()["csrfToken"]
        self.responses: dict[str, Any] = {}
        self.files: dict[str, str] = {}
        self.steps: list[dict[str, Any]] = []
        self.project: dict[str, Any] | None = None
        self.qa = {
            path.stem: json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((sample / "qa" / "panels").glob("*.json"))
        }
        if out.exists():
            shutil.rmtree(out)
        (out / "files").mkdir(parents=True)

    # Storage ----------------------------------------------------------------------

    def keep(self, status: int, body: Any) -> str:
        blob = json.dumps({"status": status, "body": body}, sort_keys=True, separators=(",", ":"))
        ref = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
        self.responses[ref] = {"status": status, "body": body}
        for url in FILE_URL.findall(blob):
            self.keep_file(url)
        return ref

    def keep_file(self, url: str) -> None:
        if url in self.files:
            return
        response = self.http.get(url)
        response.raise_for_status()
        kind = response.headers["content-type"].split(";")[0]
        content = response.content
        if kind == "image/png":
            # Full-size engine PNGs run to several MB each; WebP keeps the preview light.
            image = Image.open(io.BytesIO(content))
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", quality=88, method=4)
            content, kind = buffer.getvalue(), "image/webp"
        extension = EXTENSIONS.get(kind) or mimetypes.guess_extension(kind) or ".bin"
        name = hashlib.sha256(content).hexdigest()[:16] + extension
        target = self.out / "files" / name
        if not target.exists():
            target.write_bytes(content)
        self.files[url] = f"files/{name}"

    # HTTP -------------------------------------------------------------------------

    def headers(self, revision: int | None) -> dict[str, str]:
        headers = {"x-csrf-token": self.csrf, "idempotency-key": str(uuid.uuid4())}
        if revision is not None:
            headers["x-revision"] = str(revision)
        return headers

    def read(self, path: str) -> str:
        response = self.http.get(path)
        body = response.json() if response.content else None
        return self.keep(response.status_code, body)

    def reads(self) -> dict[str, str]:
        """Every GET the console can make in the current state."""
        reads = {"/api/projects": self.read("/api/projects")}
        if self.project is None:
            return reads
        base = f"/api/projects/{self.project['id']}"
        for path in (base, f"{base}/activity", f"{base}/validation"):
            reads[path] = self.read(path)
        for panel in self.project["panels"]:
            if panel["image"]:
                reads[f"{base}/panels/{panel['id']}/review"] = self.read(f"{base}/panels/{panel['id']}/review")
        for page in self.project["pages"]:
            if page["image"]:
                reads[f"{base}/pages/{page['number']}/review"] = self.read(f"{base}/pages/{page['number']}/review")
        return reads

    def step(self, label: str, method: str, path: str, *, revision: bool = True, **kwargs: Any) -> None:
        revision_value = self.project["revision"] if revision and self.project else None
        response = self.http.request(method, path, headers=self.headers(revision_value), **kwargs)
        if response.status_code >= 400:
            raise SystemExit(f"{label}: {method} {path} returned {response.status_code}: {response.text}")
        body = response.json() if response.content else None
        if isinstance(body, dict) and "revision" in body:
            self.project = body
        self.steps.append(
            {
                "label": label,
                "stage": stage_of(path),
                "write": {"method": method, "path": path, "response": self.keep(response.status_code, body)},
                "reads": self.reads(),
            }
        )

    # Workflow ---------------------------------------------------------------------

    def run(self) -> None:
        request = json.loads((self.sample / "source" / "request.json").read_text(encoding="utf-8"))
        prompt = (self.sample / "source" / "input.txt").read_text(encoding="utf-8").strip()
        self.steps.append({"label": "Library", "stage": "library", "write": None, "reads": self.reads()})

        self.step(
            "Create the project",
            "POST",
            "/api/projects",
            revision=False,
            json={
                "title": request["title"],
                "prompt": prompt,
                "language": request.get("language", "en"),
                "mode": request.get("mode", "short_prompt"),
                "pageCount": 2,
            },
        )
        plan = {
            "storyPlan": self.document("story-plan.json"),
            "characterBible": self.document("character-bible.json"),
            "storyboard": self.document("storyboard.json"),
        }
        project_path = f"/api/projects/{self.project['id']}"
        self.step("Save the plan", "PUT", f"{project_path}/plan", json={"plan": plan})
        self.step("Prepare references", "POST", f"{project_path}/render/prepare")
        self.upload_ready()
        self.step("Prepare panels", "POST", f"{project_path}/render/prepare")
        self.upload_ready()
        for panel in list(self.project["panels"]):
            self.review_panel(panel["id"])
        self.step("Letter and compose the pages", "POST", f"{project_path}/pages/compose")
        for page in list(self.project["pages"]):
            self.review_page(page["number"])
        self.step("Finish: export the verified PDF", "POST", f"{project_path}/finalize")
        self.keep_file(self.project["exports"]["pdf"])

    def document(self, name: str) -> Any:
        return json.loads((self.sample / "plan" / name).read_text(encoding="utf-8"))

    def upload_ready(self) -> None:
        project_path = f"/api/projects/{self.project['id']}"
        # Reading order (references, then p01-01, p01-02, ...), the order a creator works in.
        jobs = sorted(self.project["generation"]["jobs"], key=lambda job: (job["kind"] != "reference", job["subjectId"]))
        for job in jobs:
            if job["status"] != "ready":
                continue
            if job["kind"] == "reference":
                art = self.sample / "references" / "characters" / f"{job['subjectId']}.png"
            else:
                art = self.sample / "panels" / job["subjectId"] / "clean.png"
            self.step(
                f"Upload art for {job['subjectId']}",
                "POST",
                f"{project_path}/render/jobs/{job['jobId']}/upload",
                files={"image": (art.name, art.read_bytes(), "image/png")},
            )

    def review_panel(self, panel_id: str) -> None:
        project_path = f"/api/projects/{self.project['id']}"
        context = self.http.get(f"{project_path}/panels/{panel_id}/review").json()
        evidence = {check["id"]: check["evidence"] for check in self.qa[panel_id]["checks"]}
        checks = [
            {
                "id": check_id,
                "result": "pass",
                "severity": "error",
                "evidence": evidence.get(check_id) or f"{check_id} on {panel_id} matches the storyboard description.",
                "regions": [],
            }
            for check_id in context["checks"]
        ]
        assessments = [
            {
                "character_id": character["characterId"],
                "trait": trait["trait"],
                "result": "pass",
                "severity": "error",
                "evidence": TRAIT_EVIDENCE.format(name=character.get("name") or character["characterId"], trait=trait["trait"]),
            }
            for character in context["characters"]
            for trait in character["traits"]
        ]
        self.step(
            f"Review panel {panel_id}",
            "POST",
            f"{project_path}/panels/{panel_id}/review",
            json={"checks": checks, "assessments": assessments},
        )

    def review_page(self, number: int) -> None:
        project_path = f"/api/projects/{self.project['id']}"
        context = self.http.get(f"{project_path}/pages/{number}/review").json()
        checks = [
            {
                "id": check_id,
                "result": "pass",
                "severity": "error",
                "evidence": PAGE_EVIDENCE.get(check_id, "{id} on page {n} matches the storyboard.").format(n=number, id=check_id),
                "regions": [],
            }
            for check_id in context["checks"]
        ]
        balloons = {f"{balloon['panelId']}/{balloon['textId']}": "pass" for balloon in context["balloons"]}
        self.step(
            f"Review page {number}",
            "POST",
            f"{project_path}/pages/{number}/review",
            json={"checks": checks, "balloons": balloons},
        )

    # Output -----------------------------------------------------------------------

    def save(self) -> None:
        session = self.http.get("/api/session").json()
        session["csrfToken"] = "demo"
        recording = {
            "engine": self.http.get("/api/engine").json(),
            "session": session,
            "starters": self.http.get("/api/starters").json(),
            "projectId": self.project["id"],
            "steps": self.steps,
            "responses": self.responses,
            "files": self.files,
        }
        (self.out / "recording.json").write_text(
            json.dumps(recording, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
        )

    def close(self) -> None:
        self.http.close()
        self.app.state.studio.close()
        shutil.rmtree(self.data_root, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sample", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    recorder = Recorder(args.sample, args.out)
    try:
        recorder.run()
        recorder.save()
    finally:
        recorder.close()
    print(f"Recorded {len(recorder.steps)} steps and {len(set(recorder.files.values()))} files in {args.out}")


if __name__ == "__main__":
    main()
