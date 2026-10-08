"""Runtime checks of the interface's pure modules under Node."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.support import backend_static_dir, run_node, stage_modules


class InterfaceRuntimeTests(unittest.TestCase):
    staged: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.staged = stage_modules(Path(tempfile.mkdtemp(prefix="comicsol-studio-modules-")))

    def module(self, relative: str) -> str:
        return json.dumps((self.staged / relative).as_uri())

    def check(self, body: str) -> None:
        run_node(
            self,
            "function check(condition, message) { if (!condition) throw new Error(message); }\n" + body,
        )

    def test_formatting_helpers(self) -> None:
        self.check(f"""
const f = await import({self.module("format.js")});
check(f.utf8Length("é") === 2, "UTF-8 length must count bytes");
check(f.formatBytes(0) === "0 B", "zero bytes");
check(f.formatBytes(1536) === "1.5 KB", "kilobytes keep one decimal under ten");
check(f.formatBytes(204800) === "200 KB", "the source limit reads as 200 KB");
check(f.stateLabel("polling") === "Waiting on provider", "known state label");
check(f.stateLabel("surprise") === "Unknown state", "unknown states are never guessed");
check(f.phaseLabel("panel-qa") === "Panel QA", "workflow phase label");
check(f.humanize("ready_for_review") === "Ready for review", "humanize slugs");
check(f.plural(1, "job") === "1 job" && f.plural(2, "job") === "2 jobs", "plural");
""")

    def test_plan_documents_parse_into_readable_models(self) -> None:
        self.check(f"""
const m = await import({self.module("plan-model.js")});
check(m.parseDocument("").state === "empty", "empty document");
check(m.parseDocument("{{").state === "invalid", "invalid document");
check(/line|JSON/.test(m.parseDocument("{{\\n\\"a\\": }}").message), "invalid JSON explains where");
const board = m.storyboardPages({{ pages: [{{ number: 1, layout: "two-horizontal", panels: [
  {{ id: "b", order: 2, rect: {{ x: 64, y: 1232, width: 1472, height: 1104 }}, text: [{{ kind: "dialogue", speaker: "tavi", content: "Go." }}] }},
  {{ id: "a", order: 1, rect: {{ x: 64, y: 64, width: 1472, height: 1136 }} }},
  {{ id: "c", order: 3, rect: {{ x: 0, y: 0, width: 0, height: 10 }} }},
] }}] }});
check(board[0].panels.map((panel) => panel.id).join() === "a,b,c", "panels sort by order");
check(board[0].panels[0].box.left === 4 && board[0].panels[0].box.top === 2.667, "rectangles map onto 1600 x 2400");
check(board[0].panels[2].box === null, "a degenerate rectangle falls back to flow layout");
check(board[0].panels[1].lettering[0].speaker === "tavi", "lettering keeps its speaker");
const story = m.storyOutline({{ title: "T", beginning: "b", scenes: [{{ id: "s", continuity_anchor: "red cables", characters: ["tavi", 3] }}] }});
check(story.beats.length === 4 && story.beats[0].text === "b" && story.beats[1].text === "", "four beats in order");
check(story.scenes[0].anchor === "red cables" && story.scenes[0].characters.join() === "tavi,3", "scene fields");
const cast = m.characterCards({{ characters: [{{ id: "tavi", visual_fingerprint: {{ face: "f", palette: ["blue"] }} }}] }});
check(cast[0].name === "tavi" && cast[0].look[0][0] === "Face" && cast[0].palette[0] === "blue", "character card");
check(m.documentIsBlank("storyboard", m.parseDocument('{{"pages":[],"schema_version":"1.0"}}')), "template storyboard is blank");
check(!m.documentIsBlank("storyPlan", m.parseDocument('{{"title":"x"}}')), "a titled story is not blank");
""")

    def test_plan_diff_reads_line_by_line(self) -> None:
        self.check(f"""
const m = await import({self.module("plan-model.js")});
const fromEmpty = m.lineDiff("", "a\\nb");
check(fromEmpty.length === 2 && fromEmpty.every((row) => row.type === "add"), "an empty document has no removed line");
const edit = m.lineDiff("a\\nb\\nc", "a\\nB\\nc");
check(edit.map((row) => row.type).join() === "same,del,add,same", "a changed line is one removal and one addition");
const long = m.lineDiff(Array.from({{ length: 20 }}, (_, i) => `l${{i}}`).join("\\n"), Array.from({{ length: 20 }}, (_, i) => i === 10 ? "x" : `l${{i}}`).join("\\n"));
const hunks = m.diffHunks(long, 2);
check(hunks[0].type === "skip" && hunks[0].count === 8, "leading context collapses");
check(hunks.at(-1).type === "skip" && hunks.at(-1).count === 7, "trailing context collapses");
const formatting = m.documentDiff('{{"a":1,"b":[1]}}', '{{\\n  "a": 1,\\n  "b": [1]\\n}}');
check(formatting.formattingOnly, "formatting-only edits are recognised");
const content = m.documentDiff('{{"a":1}}', '{{"a":2}}');
check(!content.formattingOnly && m.diffStats(content.diff).added === 1, "content edits diff as formatted JSON");
check(m.changedKeys({{ storyPlan: "a", characterBible: "b", storyboard: "c", visualIdentityPack: "d" }},
  {{ storyPlan: "a", characterBible: "B", storyboard: "c", visualIdentityPack: "d" }}).join() === "characterBible", "changed keys");
""")

    def test_plan_shape_and_agent_proposals_are_checked(self) -> None:
        self.check(f"""
const m = await import({self.module("plan-model.js")});
const issues = m.planShapeIssues({{ storyPlan: "{{}}", characterBible: "", storyboard: "[1]", visualIdentityPack: "{{" }});
check(issues.map((issue) => issue.key).join() === "characterBible,storyboard,visualIdentityPack", "every bad document is named");
check(m.planShapeIssues({{ storyPlan: "{{}}", characterBible: "{{}}", storyboard: "{{}}", visualIdentityPack: "{{}}" }}).length === 0, "four objects pass");
check(m.safeProposal({{ expectedRevision: 2, changes: {{ storyPlan: "x" }} }}) === null, "incomplete proposals are refused");
check(m.safeProposal({{ expectedRevision: "2", changes: {{}} }}) === null, "proposals need an integer revision");
const full = {{ storyPlan: "a", characterBible: "b", storyboard: "c", visualIdentityPack: "d", extra: "e" }};
const proposal = m.safeProposal({{ expectedRevision: 2, changes: full }});
check(proposal && Object.keys(proposal.changes).length === 4, "only the four plan documents survive");
check(m.tidyJson('{{"a":1}}') === '{{\\n  "a": 1\\n}}\\n' && m.tidyJson("{{") === null, "tidy JSON");
""")

    def test_reviewed_drafts_reconcile_with_the_backend_store(self) -> None:
        state = json.dumps((backend_static_dir() / "state.js").as_uri())
        self.check(f"""
const m = await import({self.module("plan-model.js")});
const {{ createStore }} = await import({state});
const plan = (tag) => ({{ storyPlan: `s${{tag}}`, characterBible: `c${{tag}}`, storyboard: `b${{tag}}`, visualIdentityPack: `v${{tag}}` }});
const project = (revision, tag, id = "project_a") => ({{ project_id: id, revision, status: "STORYBOARDED", summary: {{ plan: plan(tag) }} }});

const store = createStore();
store.setProject(project(1, 1));
store.createDraft(plan(2));
let draft = store.getState().draft;
let result = await m.persistReviewedDraft(store, draft, async () => project(2, 2));
check(result.outcome === "promoted" && store.getState().project.revision === 2, "a reviewed draft is promoted");
check(store.getState().draft === null, "a promoted draft is cleared");

store.createDraft(plan(3));
draft = store.getState().draft;
let release;
const pending = m.persistReviewedDraft(store, draft, () => new Promise((resolve) => {{ release = resolve; }}));
store.createDraft(plan(4), "agent");
release(project(3, 3));
result = await pending;
check(result.outcome === "replacement-preserved", "a newer draft survives a slower save");
check(store.getState().draft.origin === "agent" && store.getState().draft.expectedRevision === 3, "the newer draft is rebound");

store.clearDraft();
store.createDraft(plan(5));
draft = store.getState().draft;
const switched = m.persistReviewedDraft(store, draft, () => new Promise((resolve) => {{ release = resolve; }}));
store.setProject(project(1, 9, "project_b"));
release(project(4, 5));
result = await switched;
check(result.outcome === "project-changed" && store.getState().project.project_id === "project_b", "a save never restores a replaced project");
check(!m.responseMatchesProject("project_a", store.getState().project, project(4, 5)), "stale responses are rejected");
""")

    def test_render_board_lanes_and_actions(self) -> None:
        self.check(f"""
const j = await import({self.module("jobs-model.js")});
const job = (state, extra = {{}}) => ({{ job_id: state, state, project_revision: 3, ...extra }});
check(j.laneFor(job("validating", {{ artifact_state: "staged" }}), 3) === "attention", "a current staged result needs you");
check(j.laneFor(job("validating", {{ artifact_state: "staged", project_revision: 2 }}), 3) === "history", "an old staged result is history");
check(j.laneFor(job("failed"), 3) === "attention" && j.laneFor(job("failed", {{ project_revision: 1 }}), 3) === "history", "failures");
check(j.laneFor(job("polling"), 3) === "active" && j.laneFor(job("accepted"), 3) === "done", "active and accepted");
check(j.laneFor(job("cancelled"), 3) === "history" && j.displayState(job("odd")) === "unknown", "stopped and unknown");
check(j.availableActions(job("failed"), 3).join() === "retry,switch", "a failure can retry or switch");
check(j.availableActions(job("validating", {{ artifact_state: "staged", can_cancel: true }}), 3).join() === "promote,cancel", "staged actions");
check(j.availableActions(job("failed", {{ project_revision: 2 }}), 3).length === 0, "older revisions are read-only");
check(j.hasActiveJobs([job("queued")]) && !j.hasActiveJobs([job("accepted")]), "active detection");
const option = {{ provider: "agent", model: "m" }};
check(j.routeFingerprint(option, "agent") !== j.routeFingerprint(option, "hosted"), "auth mode is part of the route");
check(j.routeFingerprint(null, "agent") === null, "no route, no fingerprint");
check(j.costText({{ amount: 0.04, currency: "USD", unit: "image" }}) === "0.04 USD per image" && j.costText(null) === null, "cost text");
""")

    def test_qa_findings_group_by_area_and_commands_filter(self) -> None:
        self.check(f"""
const q = await import({self.module("qa-model.js")});
const groups = q.groupIssues([
  {{ path: "panels/p01-01/lettered.png" }}, {{ path: "pages/page-001.png" }},
  {{ path: "panels/p01-01/lettering.json" }}, {{ path: "" }},
]);
check(groups.map(([area, items]) => `${{area}}:${{items.length}}`).join() === "panels/p01-01:2,pages:1,project:1", "QA groups");
const p = await import({self.module("palette.js")});
const command = {{ label: "Go to Plan", keywords: "stage navigate" }};
check(p.matchesQuery(command, "") && p.matchesQuery(command, "plan go") && p.matchesQuery(command, "NAV"), "query words match in any order");
check(!p.matchesQuery(command, "review"), "unrelated query");
const s = await import({self.module("views/start.js")});
const first = s.retryOperation(null, "same");
check(s.retryOperation(first, "same") === first, "a retried request keeps its idempotency key");
check(s.retryOperation(first, "other").idempotencyKey !== first.idempotencyKey, "a changed request gets a new key");
""")


if __name__ == "__main__":
    unittest.main()
