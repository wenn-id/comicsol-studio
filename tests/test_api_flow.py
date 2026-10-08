"""End-to-end production over HTTP against the real Comic Sol engine.

Rasters are uploaded by the test as a creator would upload them; reviews are recorded as
the creator. Nothing here mocks the engine.
"""

from __future__ import annotations

import unittest
import uuid

from tests.support import StudioClient, png_bytes, starter_documents


def checks_for(check_ids: list[str], subject: str) -> list[dict]:
    return [
        {
            "id": check_id,
            "result": "pass",
            "severity": "error",
            "evidence": f"Checked {check_id} on {subject}: matches the storyboard description",
            "regions": [],
        }
        for check_id in check_ids
    ]


def assessments_for(context: dict) -> list[dict]:
    return [
        {
            "character_id": character["characterId"],
            "trait": trait["trait"],
            "result": "pass",
            "severity": "error",
            "evidence": f"{character['characterId']} {trait['trait']} matches the reference sheet",
        }
        for character in context["characters"]
        for trait in character["traits"]
    ]


class ProductionFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = StudioClient()

    def tearDown(self) -> None:
        self.client.close()

    def create_prompt_project(self) -> dict:
        response = self.client.post(
            "/api/projects",
            json={
                "title": "Between Trains",
                "prompt": "Two estranged friends meet on a night train platform.",
                "language": "en",
                "mode": "short_prompt",
                "pageCount": 2,
            },
            headers={"idempotency-key": str(uuid.uuid4())},
        )
        self.assertEqual(201, response.status_code, response.text)
        return response.json()

    def upload_ready_jobs(self, project: dict) -> dict:
        for index, job in enumerate(project["generation"]["jobs"]):
            if job["status"] != "ready":
                continue
            # Deliberately the wrong shape: Studio center-crops to the job's frame.
            payload = png_bytes(job["width"] + 300, job["height"] + 40, seed=index + 3)
            response = self.client.post(
                f"/api/projects/{project['id']}/render/jobs/{job['jobId']}/upload",
                revision=project["revision"],
                files={"image": ("art.png", payload, "image/png")},
            )
            self.assertEqual(200, response.status_code, response.text)
            project = response.json()
        return project

    def prepare(self, project: dict) -> dict:
        response = self.client.post(
            f"/api/projects/{project['id']}/render/prepare", revision=project["revision"]
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def test_prompt_to_finished_pdf_and_archive_round_trip(self) -> None:
        project = self.create_prompt_project()
        self.assertEqual("INIT", project["status"])
        self.assertIsNone(project["plan"]["storyboard"])
        project_id = project["id"]

        # Invalid plans are explained and never saved.
        broken = starter_documents()
        broken["storyPlan"] = {**broken["storyPlan"], "scenes": []}
        issues = self.client.post(
            f"/api/projects/{project_id}/plan/validate", json={"plan": broken}
        ).json()["issues"]
        self.assertTrue(any("scenes" in issue for issue in issues), issues)
        refused = self.client.put(
            f"/api/projects/{project_id}/plan", revision=project["revision"], json={"plan": broken}
        )
        self.assertEqual(422, refused.status_code)
        self.assertTrue(refused.json()["error"]["details"])

        saved = self.client.put(
            f"/api/projects/{project_id}/plan",
            revision=project["revision"],
            json={"plan": starter_documents()},
        )
        self.assertEqual(200, saved.status_code, saved.text)
        project = saved.json()
        self.assertEqual("STORYBOARDED", project["status"])
        self.assertEqual(4, len(project["panels"]))

        # A write bound to an old revision is refused.
        stale = self.client.post(f"/api/projects/{project_id}/render/prepare", revision=1)
        self.assertEqual(409, stale.status_code)
        self.assertEqual("stale_revision", stale.json()["error"]["code"])

        project = self.prepare(project)
        self.assertEqual("reference", project["generation"]["phase"])
        project = self.upload_ready_jobs(project)
        self.assertTrue(all(reference["image"] for reference in project["references"]))

        project = self.prepare(project)
        self.assertEqual("panel", project["generation"]["phase"])
        panel_jobs = [job for job in project["generation"]["jobs"] if job["kind"] == "panel"]
        self.assertEqual(4, len(panel_jobs))
        self.assertTrue(all(job["exactSize"] for job in panel_jobs))
        project = self.upload_ready_jobs(project)
        self.assertTrue(all(panel["image"] for panel in project["panels"]))

        # Generic evidence is refused by the engine's quality rules.
        first = project["panels"][0]["id"]
        context = self.client.get(f"/api/projects/{project_id}/panels/{first}/review").json()
        generic = [dict(check, evidence="ok") for check in checks_for(context["checks"], first)]
        refused = self.client.post(
            f"/api/projects/{project_id}/panels/{first}/review",
            revision=project["revision"],
            json={"checks": generic, "assessments": assessments_for(context)},
        )
        self.assertEqual(422, refused.status_code)

        for panel in project["panels"]:
            context = self.client.get(
                f"/api/projects/{project_id}/panels/{panel['id']}/review"
            ).json()
            response = self.client.post(
                f"/api/projects/{project_id}/panels/{panel['id']}/review",
                revision=project["revision"],
                json={
                    "checks": checks_for(context["checks"], panel["id"]),
                    "assessments": assessments_for(context),
                },
            )
            self.assertEqual(200, response.status_code, response.text)
            project = response.json()
        self.assertEqual("QA_READY", project["status"])
        self.assertTrue(all(panel["decision"] == "accept" for panel in project["panels"]))

        response = self.client.post(f"/api/projects/{project_id}/pages/compose", revision=project["revision"])
        self.assertEqual(200, response.status_code, response.text)
        project = response.json()
        self.assertEqual("COMPOSED", project["status"])
        self.assertTrue(all(page["image"] for page in project["pages"]))

        early = self.client.post(f"/api/projects/{project_id}/finalize", revision=project["revision"])
        self.assertEqual(422, early.status_code)

        for page in project["pages"]:
            context = self.client.get(f"/api/projects/{project_id}/pages/{page['number']}/review").json()
            balloons = {f"{b['panelId']}/{b['textId']}": "pass" for b in context["balloons"]}
            response = self.client.post(
                f"/api/projects/{project_id}/pages/{page['number']}/review",
                revision=project["revision"],
                json={"checks": checks_for(context["checks"], f"page {page['number']}"), "balloons": balloons},
            )
            self.assertEqual(200, response.status_code, response.text)
            project = response.json()
        self.assertTrue(project["pagesReviewed"])

        response = self.client.post(f"/api/projects/{project_id}/finalize", revision=project["revision"])
        self.assertEqual(200, response.status_code, response.text)
        project = response.json()
        self.assertEqual("COMPLETE", project["status"])
        pdf = self.client.get(project["exports"]["pdf"])
        self.assertEqual(200, pdf.status_code)
        self.assertTrue(pdf.content.startswith(b"%PDF-"))
        self.assertIn("immutable", pdf.headers["cache-control"])

        thumb = self.client.get(project["thumbnail"])
        self.assertEqual("image/webp", thumb.headers["content-type"])

        archive = self.client.post(f"/api/projects/{project_id}/exports/archive")
        self.assertEqual(200, archive.status_code, archive.text)
        suffix = self.client.session["archiveSuffix"]
        imported = self.client.post(
            "/api/projects/import",
            files={"archive": (f"between-trains{suffix}", archive.content, "application/octet-stream")},
        )
        self.assertEqual(201, imported.status_code, imported.text)
        self.assertEqual("COMPLETE", imported.json()["status"])

        activity = self.client.get(f"/api/projects/{project_id}/activity").json()
        kinds = {event["kind"] for event in activity["studio"]}
        self.assertTrue({"plan.saved", "render.uploaded", "pages.composed", "project.finished"} <= kinds)
        self.assertTrue(activity["engine"])

    def test_failed_review_sends_panel_back_to_render(self) -> None:
        project = self.client.post("/api/projects", json={"starter": "minimal-one-page"}).json()
        project = self.prepare(project)
        project = self.upload_ready_jobs(project)
        project = self.prepare(project)
        first_jobs = {job["jobId"] for job in project["generation"]["jobs"]}
        project = self.upload_ready_jobs(project)
        panel_id = project["panels"][0]["id"]
        context = self.client.get(f"/api/projects/{project['id']}/panels/{panel_id}/review").json()
        checks = checks_for(context["checks"], panel_id)
        checks[1] = {**checks[1], "result": "fail", "evidence": "The left hand has six fingers near the cup"}
        response = self.client.post(
            f"/api/projects/{project['id']}/panels/{panel_id}/review",
            revision=project["revision"],
            json={"checks": checks, "assessments": assessments_for(context)},
        )
        self.assertEqual(200, response.status_code, response.text)
        project = response.json()
        self.assertEqual("regenerate", project["panels"][0]["decision"])
        project = self.prepare(project)
        retry = [job for job in project["generation"]["jobs"] if job["subjectId"] == panel_id and job["status"] == "ready"]
        self.assertEqual(1, len(retry))
        self.assertNotIn(retry[0]["jobId"], first_jobs)

    def test_project_management(self) -> None:
        key = str(uuid.uuid4())
        body = {"title": "Kite", "prompt": "A kite escapes a storm.", "pageCount": 1}
        first = self.client.post("/api/projects", json=body, headers={"idempotency-key": key})
        again = self.client.post("/api/projects", json=body, headers={"idempotency-key": key})
        self.assertEqual(first.json()["id"], again.json()["id"])
        self.assertEqual(1, len(self.client.get("/api/projects").json()))

        project = first.json()
        renamed = self.client.patch(
            f"/api/projects/{project['id']}", revision=project["revision"], json={"title": "Kite Season"}
        )
        self.assertEqual("Kite Season", renamed.json()["title"])

        for bad in (
            {"title": "", "prompt": "x"},
            {"title": "T", "prompt": "x", "pageCount": 5},
            {"title": "T", "prompt": "x", "mode": "resume"},
            {"title": "T", "prompt": "x", "extra": 1},
        ):
            with self.subTest(body=bad):
                self.assertEqual(422, self.client.post("/api/projects", json=bad).status_code)

        self.assertEqual(204, self.client.delete(f"/api/projects/{project['id']}").status_code)
        self.assertEqual(404, self.client.get(f"/api/projects/{project['id']}").status_code)
        self.assertTrue(any(self.client.data_root.joinpath("trash").iterdir()))

    def test_outside_changes_advance_the_revision(self) -> None:
        project = self.client.post("/api/projects", json={"starter": "minimal-one-page"}).json()
        root = self.client.config.projects_root / project["id"]
        engine_dir = next(path for path in root.iterdir() if path.is_dir())
        (engine_dir / "source" / "input.txt").write_text("edited by an agent session\n", encoding="utf-8")
        reread = self.client.get(f"/api/projects/{project['id']}").json()
        self.assertGreater(reread["revision"], project["revision"])

    def test_files_stay_inside_the_project(self) -> None:
        project = self.client.post("/api/projects", json={"starter": "minimal-one-page"}).json()
        for path in ("project.json", "plan/storyboard.json", "../studio.sqlite3", "pages/../project.json"):
            with self.subTest(path=path):
                response = self.client.get(f"/api/projects/{project['id']}/files/{path}")
                self.assertEqual(404, response.status_code)


if __name__ == "__main__":
    unittest.main()
