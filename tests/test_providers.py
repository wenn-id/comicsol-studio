"""Provider adapters and background runs, with model calls replaced at the transport."""

from __future__ import annotations

import base64
import io
import json
import time
import unittest
from types import SimpleNamespace
from typing import Any

import httpx
from PIL import Image

from comicsol_studio import engine
from comicsol_studio.providers import Providers, ProviderError
from comicsol_studio.providers.anthropic_text import FALLBACK_BETA, AnthropicText
from comicsol_studio.providers.openai_api import OpenAIClient
from comicsol_studio.providers.planning import PlanRequest, assemble, draft_plan, draft_schema
from tests.support import StudioClient, png_bytes, starter_documents


def draft_from(documents: dict[str, Any]) -> dict[str, Any]:
    """Reverse `assemble`: what a model would return for a known-good plan."""
    pages = []
    for page in documents["storyboard"]["pages"]:
        panels = []
        for panel in page["panels"]:
            entry = {key: value for key, value in panel.items() if key not in {"id", "order", "rect", "text"}}
            entry["text"] = [
                {
                    "kind": item["kind"],
                    "speaker": item.get("speaker"),
                    "voice_source": item.get("voice_source"),
                    "speaker_anchor": item.get("speaker_anchor"),
                    "content": item["content"],
                    "anchor": item["anchor"],
                    "render_mode": item.get("render_mode"),
                }
                for item in panel["text"]
            ]
            panels.append(entry)
        pages.append({"layout": page["layout"], "panels": panels})
    story = {k: v for k, v in documents["storyPlan"].items() if k not in {"schema_version", "rating"}}
    characters = [
        {k: v for k, v in character.items() if k != "reference_path"}
        for character in documents["characterBible"]["characters"]
    ]
    return {"storyPlan": story, "characters": characters, "pages": pages}


class FakeText:
    provider_id = "fake"

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.prompts: list[str] = []

    def complete_json(self, system, prompt, schema, *, image_png=None, effort="high"):
        self.prompts.append(prompt)
        return self.responses.pop(0)


class FakeImages:
    provider_id = "fake"
    image_model = "fake-image-1"

    def __init__(self) -> None:
        self.calls: list[tuple[int, int, int]] = []

    def render(self, prompt, *, width, height, references=()):
        self.calls.append((width, height, len(references)))
        return png_bytes(1024, 1536 if height > width else 1024, seed=len(self.calls))


class PlanningTests(unittest.TestCase):
    def test_draft_schema_is_strict(self) -> None:
        def walk(node: Any) -> None:
            if isinstance(node, dict):
                if node.get("type") == "object":
                    self.assertFalse(node["additionalProperties"])
                    self.assertEqual(sorted(node["required"]), sorted(node["properties"]))
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(draft_schema())

    def test_assembled_draft_passes_engine_validation(self) -> None:
        for starter in ("minimal-one-page", "dialogue-two-page", "action-focused"):
            with self.subTest(starter=starter):
                documents = starter_documents(starter)
                assembled = assemble(draft_from(documents), language="en")
                self.assertEqual([], engine.validate_plan(assembled))
                self.assertEqual(documents["storyboard"], assembled["storyboard"])

    def test_validation_issues_are_sent_back_for_repair(self) -> None:
        good = draft_from(starter_documents())
        bad = json.loads(json.dumps(good))
        bad["storyPlan"]["scenes"] = bad["storyPlan"]["scenes"][:1]
        model = FakeText([bad, good])
        request = PlanRequest("Between Trains", "Two friends.", "en", 2)
        documents, issues = draft_plan(request, model.complete_json)
        self.assertEqual([], issues)
        self.assertEqual(2, len(model.prompts))
        self.assertIn("failed the engine's validation", model.prompts[1])
        self.assertEqual(2, len(documents["storyboard"]["pages"]))

    def test_wrong_page_count_is_an_issue(self) -> None:
        good = draft_from(starter_documents())
        model = FakeText([good, good, good])
        _, issues = draft_plan(PlanRequest("T", "S", "en", 1), model.complete_json)
        self.assertTrue(any("exactly 1 pages" in issue for issue in issues))


class OpenAITests(unittest.TestCase):
    def client(self, handler) -> OpenAIClient:
        return OpenAIClient(
            "sk-test", text_model="text-model", image_model="image-model",
            transport=httpx.MockTransport(handler),
        )

    def test_structured_text(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers["authorization"]
            seen["body"] = json.loads(request.content)
            output = [{"content": [{"type": "output_text", "text": '{"ok": true}'}]}]
            return httpx.Response(200, json={"output": output})

        result = self.client(handler).complete_json("sys", "prompt", {"type": "object"}, image_png=b"png")
        self.assertEqual({"ok": True}, result)
        self.assertEqual("https://api.openai.com/v1/responses", seen["url"])
        self.assertEqual("Bearer sk-test", seen["auth"])
        self.assertTrue(seen["body"]["text"]["format"]["strict"])
        self.assertEqual("input_image", seen["body"]["input"][0]["content"][1]["type"])

    def test_images_generation_and_edits(self) -> None:
        image = base64.b64encode(png_bytes(1536, 1024)).decode()
        paths: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            paths.append(request.url.path)
            if request.url.path.endswith("/generations"):
                self.assertEqual("1536x1024", json.loads(request.content)["size"])
            return httpx.Response(200, json={"data": [{"b64_json": image}]})

        client = self.client(handler)
        self.assertTrue(client.render("p", width=1472, height=1120).startswith(b"\x89PNG"))
        client.render("p", width=1472, height=1120, references=(png_bytes(600, 600),))
        self.assertEqual(["/v1/images/generations", "/v1/images/edits"], paths)

    def test_errors_become_creator_messages(self) -> None:
        cases = {
            401: ({}, "API key"),
            429: ({"error": {"code": "insufficient_quota"}}, "quota"),
            400: ({"error": {"code": "moderation_blocked"}}, "safety"),
        }
        for status, (body, words) in cases.items():
            with self.subTest(status=status):
                client = self.client(lambda request, status=status, body=body: httpx.Response(status, json=body))
                with self.assertRaises(ProviderError) as raised:
                    client.render("p", width=1024, height=1024)
                self.assertIn(words, str(raised.exception))


class AnthropicTests(unittest.TestCase):
    def fake_client(self, message, calls):
        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get_final_message(self):
                return message

        def stream(**kwargs):
            calls.append(kwargs)
            return Stream()

        return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))

    def test_request_shape_and_parsing(self) -> None:
        calls: list[dict] = []
        message = SimpleNamespace(
            stop_reason="end_turn", content=[SimpleNamespace(type="text", text='{"plan": 1}')]
        )
        model = AnthropicText("key", "claude-opus-5-5", client=self.fake_client(message, calls))
        self.assertEqual({"plan": 1}, model.complete_json("sys", "go", {"type": "object"}, image_png=b"x"))
        request = calls[0]
        self.assertEqual("claude-opus-5-5", request["model"])
        self.assertEqual([FALLBACK_BETA], request["betas"])
        self.assertEqual("default", request["fallbacks"])
        self.assertEqual({"type": "adaptive"}, request["thinking"])
        self.assertEqual("json_schema", request["output_config"]["format"]["type"])
        self.assertEqual("image", request["messages"][0]["content"][0]["type"])

    def test_refusal_is_reported(self) -> None:
        message = SimpleNamespace(stop_reason="refusal", content=[])
        model = AnthropicText("key", "m", client=self.fake_client(message, []))
        with self.assertRaises(ProviderError):
            model.complete_json("s", "p", {})


class BackgroundRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.images = FakeImages()
        self.text = FakeText([])
        providers = Providers(text={"fake": self.text}, text_models={"fake": "fake-text"}, images={"fake": self.images})
        self.client = StudioClient(providers)

    def tearDown(self) -> None:
        self.client.close()

    def wait(self, project_id: str, run: dict) -> dict:
        for _ in range(600):
            current = self.client.get(f"/api/projects/{project_id}/runs/{run['id']}").json()
            if current["status"] not in {"queued", "running"}:
                return current
            time.sleep(0.05)
        self.fail("run did not finish")

    def project(self, project_id: str) -> dict:
        return self.client.get(f"/api/projects/{project_id}").json()

    def test_capabilities_list_configured_routes_only(self) -> None:
        providers = self.client.session["providers"]
        self.assertEqual([{"id": "fake", "model": "fake-image-1"}], providers["renderers"])
        self.assertNotIn("key", json.dumps(providers).lower())

    def test_render_batch_reference_approval_and_ai_review(self) -> None:
        project = self.client.post("/api/projects", json={"starter": "minimal-one-page"}).json()
        project = self.client.post(f"/api/projects/{project['id']}/render/prepare", revision=project["revision"]).json()
        run = self.client.post(
            f"/api/projects/{project['id']}/render/ready", revision=project["revision"], json={"provider": "fake"}
        ).json()
        self.assertEqual("succeeded", self.wait(project["id"], run)["status"])

        # References are drawn as candidates and wait for the creator's approval.
        project = self.project(project["id"])
        candidates = [job for job in project["generation"]["jobs"] if job["candidate"]]
        self.assertTrue(candidates)
        self.assertTrue(all(reference["image"] is None for reference in project["references"]))
        preview = self.client.get(f"/api/projects/{project['id']}/render/jobs/{candidates[0]['jobId']}/candidate.png")
        self.assertEqual(200, preview.status_code)
        for job in candidates:
            response = self.client.post(
                f"/api/projects/{project['id']}/render/jobs/{job['jobId']}/candidate/approve",
                revision=project["revision"],
            )
            self.assertEqual(200, response.status_code, response.text)
            project = response.json()
        self.assertTrue(all(reference["image"] for reference in project["references"]))
        # The engine's receipt names the model that drew each approved reference.
        engine_root = next((self.client.config.projects_root / project["id"]).iterdir())
        receipts = [json.loads(path.read_text(encoding="utf-8")) for path in (engine_root / "generation" / "receipts").glob("*.json")]
        self.assertTrue(receipts)
        self.assertTrue(all("fake" in json.dumps(receipt) for receipt in receipts), receipts[0])

        project = self.client.post(f"/api/projects/{project['id']}/render/prepare", revision=project["revision"]).json()
        run = self.client.post(
            f"/api/projects/{project['id']}/render/ready", revision=project["revision"], json={"provider": "fake"}
        ).json()
        self.assertEqual("succeeded", self.wait(project["id"], run)["status"])
        project = self.project(project["id"])
        self.assertTrue(all(panel["image"] for panel in project["panels"]))
        panel_job_sizes = [call for call in self.images.calls if call[2] > 0]
        self.assertTrue(panel_job_sizes, "panel renders carry the reference images")
        job = next(j for j in project["generation"]["jobs"] if j["subjectId"] == project["panels"][0]["id"])
        with Image.open(io.BytesIO(self.client.get(project["panels"][0]["image"]).content)) as image:
            self.assertEqual((job["width"], job["height"]), image.size)

        panel_id = project["panels"][0]["id"]
        context = self.client.get(f"/api/projects/{project['id']}/panels/{panel_id}/review").json()
        self.text.responses.append(
            {
                "checks": [
                    {"id": check, "result": "pass", "severity": "error", "evidence": f"Seen: {check} holds in {panel_id}"}
                    for check in context["checks"]
                ],
                "assessments": [
                    {
                        "character_id": character["characterId"],
                        "trait": trait["trait"],
                        "result": "pass",
                        "severity": "error",
                        "evidence": f"{character['characterId']} shows the expected {trait['trait']}",
                    }
                    for character in context["characters"]
                    for trait in character["traits"]
                ],
            }
        )
        run = self.client.post(
            f"/api/projects/{project['id']}/panels/{panel_id}/review/auto",
            revision=project["revision"],
            json={"provider": "fake"},
        ).json()
        finished = self.wait(project["id"], run)
        self.assertEqual("succeeded", finished["status"], finished["message"])
        record = engine.read_json(
            next((self.client.config.projects_root / project["id"]).iterdir()), f"qa/panels/{panel_id}.json"
        )
        self.assertEqual("fake:fake-text", record["review"]["reviewer"])
        self.assertEqual("vision-model-review", record["review"]["method"])

    def test_plan_draft_run_returns_documents_for_review(self) -> None:
        project = self.client.post(
            "/api/projects", json={"title": "Trains", "prompt": "Two friends meet.", "pageCount": 2}
        ).json()
        self.text.responses.append(draft_from(starter_documents()))
        run = self.client.post(
            f"/api/projects/{project['id']}/plan/draft", revision=project["revision"], json={"provider": "fake"}
        ).json()
        finished = self.wait(project["id"], run)
        self.assertEqual("succeeded", finished["status"], finished["message"])
        self.assertEqual([], finished["result"]["issues"])
        # A draft is not saved until the creator saves it.
        self.assertIsNone(self.project(project["id"])["plan"]["storyboard"])

    def test_unknown_provider_is_refused(self) -> None:
        project = self.client.post("/api/projects", json={"starter": "minimal-one-page"}).json()
        response = self.client.post(
            f"/api/projects/{project['id']}/plan/draft", revision=project["revision"], json={"provider": "openai"}
        )
        self.assertEqual(422, response.status_code)


if __name__ == "__main__":
    unittest.main()
