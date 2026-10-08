"""Browser-side contracts: contrast, copy rules, no remote origins, and the pure JS modules."""

from __future__ import annotations

import json
import re
import unittest

from comicsol_studio import engine
from comicsol_studio.app import WEB_DIR
from tests.support import run_node

CSS = WEB_DIR / "assets" / "css"


def tokens(block: str) -> dict[str, str]:
    return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", block))


def luminance(hex_color: str) -> float:
    channels = [int(hex_color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class ContrastTests(unittest.TestCase):
    def themes(self) -> dict[str, dict[str, str]]:
        night = tokens((CSS / "tokens.css").read_text(encoding="utf-8").split(":root {", 1)[1].split("}", 1)[0])
        console = (CSS / "console.css").read_text(encoding="utf-8")
        day_block = console.split(':root[data-theme="day"] {', 1)[1].split("}", 1)[0]
        return {"night": night, "day": {**night, **tokens(day_block)}}

    def test_text_tokens_meet_wcag_aa_on_every_surface(self) -> None:
        texts = ("ivory", "ivory-2", "ivory-3", "amber-text", "sage", "ember")
        surfaces = ("obsidian", "ink-1", "ink-2", "ink-3")
        for theme, values in self.themes().items():
            for text in texts:
                for surface in surfaces:
                    with self.subTest(theme=theme, text=text, surface=surface):
                        self.assertGreaterEqual(contrast(values[text], values[surface]), 4.5)

    def test_primary_button_text(self) -> None:
        for theme, values in self.themes().items():
            with self.subTest(theme=theme):
                self.assertGreaterEqual(contrast(values["on-amber"], values["amber"]), 4.5)


class SourceRuleTests(unittest.TestCase):
    def sources(self):
        for path in sorted(WEB_DIR.rglob("*")):
            if path.suffix in {".html", ".css", ".js"} and "vendor" not in path.parts:
                yield path, path.read_text(encoding="utf-8")

    def test_copy_has_no_em_dash(self) -> None:
        for path, text in self.sources():
            with self.subTest(file=path.name):
                self.assertNotIn("—", text)

    def test_no_remote_origins_or_inline_scripts(self) -> None:
        for path, text in self.sources():
            with self.subTest(file=path.name):
                for url in re.findall(r"""(?:src|href)=["'](https?:[^"']+)""", text):
                    self.assertTrue(url.startswith("https://github.com/wenn-id/"), url)
                if path.suffix == ".html":
                    self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)[^>]*>", text), "inline scripts are blocked by the CSP")
                if path.suffix == ".js":
                    self.assertNotIn("innerHTML", text)
                    self.assertNotIn("fetch(\"http", text)

    def test_focus_outline_is_never_removed(self) -> None:
        for path, text in self.sources():
            if path.suffix == ".css":
                with self.subTest(file=path.name):
                    self.assertNotRegex(text, r"outline:\s*(none|0)\s*;(?![^}]*box-shadow)")

    def test_book_layouts_mirror_the_engine(self) -> None:
        script = "import { LAYOUTS } from './assets/js/landing/textures.js'; console.log(JSON.stringify(LAYOUTS));"
        # textures.js touches the DOM only inside functions, so importing it under Node is safe.
        mirrored = json.loads(run_node(self, script))
        expected = {name: [[r["x"], r["y"], r["width"], r["height"]] for r in rects] for name, rects in engine.layouts().items()}
        self.assertEqual(expected, mirrored)


class ModuleTests(unittest.TestCase):
    def test_plan_model(self) -> None:
        layouts = json.dumps(engine.layouts())
        run_node(
            self,
            f"""
            import assert from 'node:assert/strict';
            import * as m from './assets/js/console/plan-model.js';
            const layouts = {layouts};
            const plan = m.emptyPlan({{ title: 'T', pageCount: 2 }}, layouts);
            assert.equal(plan.storyboard.pages.length, 2);
            assert.deepEqual(plan.storyboard.pages[1].panels.map((p) => p.id), ['p02-01', 'p02-02']);
            assert.equal(plan.storyboard.pages[0].panels[0].rect.width, 1472);
            const hero = m.setLayout(plan, 0, 'hero-top-two-bottom', layouts);
            assert.equal(hero.storyboard.pages[0].panels.length, 3);
            assert.equal(hero.storyboard.pages[0].panels[2].rect.x, 816);
            let next = m.clone(hero);
            next.characterBible.characters.push(m.newCharacter('mara'));
            next.storyPlan.scenes[0].characters = ['mara'];
            const panel = next.storyboard.pages[0].panels[0];
            panel.characters = ['mara'];
            panel.continuity = ['mara:red scarf'];
            panel.text.push(m.newTextItem('dialogue', 'mara'));
            next = m.normalizePlan(next, layouts);
            assert.equal(next.storyboard.pages[0].panels[0].text[0].id, 'p01-01-t01');
            const renamed = m.renameCharacter(next, 'mara', 'mira');
            assert.deepEqual(renamed.storyPlan.scenes[0].characters, ['mira']);
            assert.equal(renamed.storyboard.pages[0].panels[0].continuity[0], 'mira:red scarf');
            assert.equal(renamed.storyboard.pages[0].panels[0].text[0].speaker, 'mira');
            assert.equal(renamed.characterBible.characters[0].reference_path, 'references/characters/mira.png');
            const removed = m.removeCharacter(renamed, 'mira');
            assert.equal(removed.storyboard.pages[0].panels[0].text.length, 0);
            assert.equal(m.addPage(m.addPage(plan, layouts), layouts).storyboard.pages.length, 4);
            assert.equal(m.addPage(m.addPage(m.addPage(plan, layouts), layouts), layouts).storyboard.pages.length, 4);
            assert.equal(m.removePage(plan, 0, layouts).storyboard.pages[0].panels[0].id, 'p01-01');
            const caption = m.normalizePlan({{...plan, storyboard: {{...plan.storyboard, pages: [{{...plan.storyboard.pages[0], panels: [{{...m.newPanel(), text: [{{kind: 'caption', content: 'x', anchor: 'top-left', speaker: 'z', voice_source: 'human'}}]}}]}}]}}}}, layouts);
            assert.equal(caption.storyboard.pages[0].panels[0].text[0].speaker, null);
            assert.equal('voice_source' in caption.storyboard.pages[0].panels[0].text[0], false);
            const issue = m.parseIssue('plan/storyboard.json.pages[1].panels[0].action: must be a non-empty string');
            assert.deepEqual([issue.doc, issue.pageIndex, issue.panelIndex, issue.field], ['storyboard', 1, 0, 'action']);
            assert.equal(m.slugify('Mara Quinn'), 'mara-quinn');
            assert.equal(m.isValidId('9lives'), false);
            """,
        )

    def test_next_step_follows_the_lifecycle(self) -> None:
        run_node(
            self,
            """
            import assert from 'node:assert/strict';
            import { nextStep, stageStates } from './assets/js/console/model.js';
            const base = { status: 'INIT', plan: {}, panels: [], pages: [], generation: { prepared: false, jobs: [] }, runs: [] };
            assert.equal(nextStep(base).stage, 'plan');
            const planned = { ...base, status: 'STORYBOARDED', plan: { storyboard: {} }, panels: [{ id: 'p01-01' }] };
            assert.equal(nextStep(planned).title, 'Prepare render jobs');
            const ready = { ...planned, generation: { prepared: true, jobs: [{ status: 'ready', kind: 'reference' }] } };
            assert.match(nextStep(ready).title, /reference sheets/);
            const candidate = { ...planned, generation: { prepared: true, jobs: [{ status: 'ready', kind: 'reference', candidate: true }] } };
            assert.match(nextStep(candidate).title, /Approve 1 reference/);
            const rendered = { ...planned, panels: [{ id: 'p01-01', image: 'x' }], generation: { prepared: true, jobs: [] } };
            assert.equal(nextStep(rendered).panel, 'p01-01');
            const sentBack = { ...rendered, panels: [{ id: 'p01-01', image: 'x', decision: 'regenerate' }] };
            assert.equal(nextStep(sentBack).title, 'Prepare render jobs');
            const accepted = { ...rendered, status: 'QA_READY', panels: [{ id: 'p01-01', image: 'x', decision: 'accept' }] };
            assert.match(nextStep(accepted).title, /compose/);
            const composed = { ...accepted, status: 'COMPOSED', pages: [{ number: 1, image: 'x' }] };
            assert.equal(nextStep(composed).page, 1);
            const reviewed = { ...composed, pages: [{ number: 1, image: 'x', decision: 'accept' }], pagesReviewed: true };
            assert.equal(nextStep(reviewed).stage, 'finish');
            assert.equal(stageStates(reviewed).finish, 'current');
            assert.equal(nextStep({ ...reviewed, status: 'COMPLETE' }).title, 'Your comic is bound');
            """,
        )


if __name__ == "__main__":
    unittest.main()
