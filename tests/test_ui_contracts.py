"""Static contracts for the Studio Next interface: safety, accessibility, drift."""

from __future__ import annotations

import re
import unittest
from html.parser import HTMLParser

from tests.support import UI_DIR, backend_static_dir, js_sources, ui_files


def contrast_ratio(foreground: str, background: str) -> float:
    def luminance(color: str) -> float:
        channels = [int(color[index : index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [
            value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
            for value in channels
        ]
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

    lighter, darker = sorted((luminance(foreground), luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def theme_tokens(block: str) -> dict[str, str]:
    return dict(re.findall(r"--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;", block))


class ShellParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, {key: value or "" for key, value in attrs}))


class InterfaceSafetyTests(unittest.TestCase):
    sources: dict[str, str]
    styles: str
    index: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.sources = js_sources()
        cls.styles = (UI_DIR / "css" / "studio.css").read_text(encoding="utf-8")
        cls.index = (UI_DIR / "index.html").read_text(encoding="utf-8")

    def test_text_never_reaches_an_html_parser(self) -> None:
        sink = re.compile(r"innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(")
        for name, source in self.sources.items():
            with self.subTest(module=name):
                self.assertIsNone(sink.search(source))

    def test_interface_loads_nothing_from_another_origin(self) -> None:
        allowed = {"http://www.w3.org/2000/svg"}
        for path in ui_files():
            if path.suffix not in {".html", ".css", ".js"}:
                continue
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                urls = set(re.findall(r"https?://[^\s\"')]+", text))
                self.assertEqual(set(), urls - allowed)

    def test_no_telemetry_or_logging_of_project_content(self) -> None:
        pattern = re.compile(r"console\.(?:log|warn|error|info)|sendBeacon|XMLHttpRequest|WebSocket")
        for name, source in self.sources.items():
            with self.subTest(module=name):
                self.assertIsNone(pattern.search(source))

    def test_storage_holds_only_interface_preferences(self) -> None:
        for name, source in self.sources.items():
            with self.subTest(module=name):
                self.assertNotRegex(source, r"sessionStorage|indexedDB")
                if "localStorage" in source:
                    self.assertIn(name, {"js/theme.js", "js/log.js"})
        keys = set()
        for name in ("js/theme.js", "js/log.js"):
            keys |= set(re.findall(r'"(comic-sol-studio-next:[a-z-]+)"', self.sources[name]))
        self.assertEqual({"comic-sol-studio-next:theme", "comic-sol-studio-next:log-open"}, keys)

    def test_copy_has_no_em_dash(self) -> None:
        for path in ui_files():
            if path.suffix in {".html", ".css", ".js"}:
                with self.subTest(file=path.name):
                    self.assertNotIn("—", path.read_text(encoding="utf-8"))


class BackendContractTests(unittest.TestCase):
    """The interface reuses the backend's browser client; guard against drift."""

    sources: dict[str, str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.sources = js_sources()
        cls.static = backend_static_dir()

    def backend_imports(self) -> dict[str, set[str]]:
        imported: dict[str, set[str]] = {}
        pattern = re.compile(r"import\s*(\*\s*as\s*\w+|\{[^}]*\})\s*from\s*\"/static/([^\"]+)\"")
        for source in self.sources.values():
            for names, module in pattern.findall(source):
                bucket = imported.setdefault(module, set())
                if names.startswith("{"):
                    bucket |= {name.strip() for name in names.strip("{}").split(",") if name.strip()}
        return imported

    def test_only_published_client_modules_are_imported(self) -> None:
        self.assertEqual({"api.js", "state.js", "webmcp.js"}, set(self.backend_imports()))

    def test_every_imported_name_is_exported_by_the_backend(self) -> None:
        for module, names in self.backend_imports().items():
            exported = set(
                re.findall(
                    r"export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)",
                    (self.static / module).read_text(encoding="utf-8"),
                )
            )
            for name in sorted(names):
                with self.subTest(module=module, name=name):
                    self.assertIn(name, exported)

    def test_namespace_api_usage_exists_in_the_backend(self) -> None:
        exported = set(
            re.findall(
                r"export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)",
                (self.static / "api.js").read_text(encoding="utf-8"),
            )
        )
        used = set(re.findall(r"\bapi\.(\w+)\(", self.sources["js/main.js"]))
        self.assertTrue(used)
        self.assertLessEqual(used, exported)

    def test_webmcp_dom_hooks_and_events_are_honoured(self) -> None:
        webmcp = (self.static / "webmcp.js").read_text(encoding="utf-8")
        combined = "\n".join(self.sources.values())
        for identifier in sorted(set(re.findall(r'getElementById\("([^"]+)"\)', webmcp))):
            with self.subTest(element=identifier):
                self.assertRegex(combined, rf'id:\s*"{re.escape(identifier)}"')
        for event in sorted(set(re.findall(r'new CustomEvent\("([^"]+)"', webmcp))):
            with self.subTest(event=event):
                self.assertIn(f'addEventListener("{event}"', combined)


class ConfirmationContractTests(unittest.TestCase):
    sources: dict[str, str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.sources = js_sources()

    def test_generation_is_queued_only_after_the_exact_route_is_confirmed(self) -> None:
        generate = self.sources["js/views/generate.js"]
        guard = generate.index("confirmed !== fingerprint")
        self.assertLess(guard, generate.index("await queueGeneration("))
        for control in ("authMode = mode;", "selected = option;"):
            block = generate[generate.index(control) : generate.index(control) + 120]
            self.assertIn("resetConfirmation()", block)

    def test_promotion_switch_and_export_go_through_a_confirmation_dialog(self) -> None:
        generate = self.sources["js/views/generate.js"]
        review = self.sources["js/views/review.js"]
        for source, call in (
            (generate, "submitStagedRaster("),
            (generate, "approveProposal("),
            (generate, "rejectProposal("),
            (review, "submitStagedRaster("),
            (review, "exportProject("),
        ):
            with self.subTest(call=call):
                position = source.index(call)
                self.assertGreater(source.rfind("confirmDialog({", 0, position), -1)

    def test_export_requires_the_replace_confirmation(self) -> None:
        review = self.sources["js/views/review.js"]
        handler = review[review.index('exportButton.addEventListener("click"') :]
        self.assertLess(handler.index("if (!overwrite.checked)"), handler.index("startExport("))
        request = review[review.index("const exportRequestHandler") :]
        self.assertIn("overwrite.checked = false", request[: request.index("};")])

    def test_plan_saves_only_a_reviewed_revision_bound_draft(self) -> None:
        plan = self.sources["js/views/plan.js"]
        save = plan[plan.index('saveButton.addEventListener("click"') :]
        self.assertLess(save.index("latest.project.revision !== draft.expectedRevision"), save.index("updatePlan("))
        self.assertLess(save.index("planShapeIssues(draft.changes)"), save.index("updatePlan("))
        self.assertIn("draft.expectedRevision", save[save.index("updatePlan(") : save.index("updatePlan(") + 200])


class AccessibilityContractTests(unittest.TestCase):
    styles: str
    index: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.styles = (UI_DIR / "css" / "studio.css").read_text(encoding="utf-8")
        cls.index = (UI_DIR / "index.html").read_text(encoding="utf-8")

    def test_shell_landmarks_skip_link_and_live_region(self) -> None:
        parser = ShellParser()
        parser.feed(self.index)
        tags = {tag for tag, _attributes in parser.elements}
        self.assertTrue({"header", "nav", "main", "aside"} <= tags)
        self.assertRegex(self.index, r'class="skip-link" href="#stage"')
        self.assertRegex(self.index, r'<main id="stage" tabindex="-1">')
        self.assertRegex(self.index, r'<nav[^>]+aria-label="Production stages"')
        self.assertRegex(self.index, r'id="toasts"[^>]+aria-live="polite"')
        views = [attributes["data-view"] for _tag, attributes in parser.elements if "data-view" in attributes]
        self.assertEqual(["start", "plan", "generate", "review"], views)
        self.assertRegex(self.index, r'<script type="module" src="\./js/main\.js">')

    def test_focus_is_visible_and_motion_respects_the_user(self) -> None:
        self.assertRegex(self.styles, r":focus-visible\s*\{[^}]*outline:\s*2px solid")
        # Only the programmatic focus target drops the default ring, and it
        # replaces it for keyboard focus.
        suppressed = re.findall(r"([^{}]+)\{[^}]*outline:\s*(?:none|0)\b", self.styles)
        self.assertEqual(["#stage"], [selector.strip() for selector in suppressed])
        self.assertRegex(self.styles, r"#stage:focus-visible\s*\{[^}]*outline:\s*2px solid")
        reduced = self.styles.split("@media (prefers-reduced-motion: reduce)", 1)[1]
        self.assertRegex(reduced, r"animation-duration:\s*0\.01ms")
        self.assertRegex(reduced, r"transition-duration:\s*0\.01ms")

    def test_hidden_attribute_always_wins(self) -> None:
        self.assertRegex(self.styles, r"\[hidden\]\s*\{\s*display:\s*none\s*!important;")

    def test_both_themes_define_the_same_tokens_and_meet_aa_contrast(self) -> None:
        dark = theme_tokens(self.styles.split(":root {", 1)[1].split("}", 1)[0])
        light_block = self.styles.split(':root[data-theme="light"] {', 1)[1].split("}", 1)[0]
        light = {**dark, **theme_tokens(light_block)}
        overridden = set(theme_tokens(light_block))
        for token in ("bg", "surface", "raise", "field", "text", "dim", "faint", "cyan", "ok", "bad"):
            self.assertIn(token, overridden, f"light theme does not set --{token}")
        for name, tokens in (("dark", dark), ("light", light)):
            for text in ("text", "dim", "faint", "cyan", "ok", "bad"):
                for surface in ("bg", "surface", "raise", "field"):
                    with self.subTest(theme=name, text=text, surface=surface):
                        self.assertGreaterEqual(contrast_ratio(tokens[text], tokens[surface]), 4.5)
        self.assertGreaterEqual(contrast_ratio(dark["amber-ink"], dark["amber"]), 4.5)
        self.assertGreaterEqual(contrast_ratio(dark["paper-ink"], dark["paper"]), 4.5)


if __name__ == "__main__":
    unittest.main()
