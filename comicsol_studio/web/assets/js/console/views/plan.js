// Plan: the story, the cast, and the storyboard, edited as forms over the engine's own
// documents. The engine validates the unsaved draft as you type; nothing is saved until
// it passes. A connected model can draft the whole plan for review.

import { api } from "../api.js";
import { debounce, h, icon, mount } from "../dom.js";
import { providerName } from "../model.js";
import {
  ANCHORS,
  LAYOUT_LABELS,
  TEXT_KINDS,
  addPage,
  allPanels,
  clone,
  continuityOptions,
  emptyPlan,
  findPanel,
  issuesFor,
  isValidId,
  layoutPanelCount,
  newCharacter,
  newScene,
  newTextItem,
  normalizePlan,
  panelWords,
  parseIssue,
  planEquals,
  removeCharacter,
  removePage,
  removeScene,
  renameCharacter,
  renameScene,
  setLayout,
  uniqueId,
  wordCount,
} from "../plan-model.js";
import { badge, busy, button, chips, confirmDialog, field, segmented, select, textArea, textInput, toast, toastError } from "../ui.js";

const drafts = new Map();
const TABS = [
  ["story", "Story"],
  ["cast", "Cast"],
  ["storyboard", "Storyboard"],
  ["json", "JSON"],
];

function savedPlan(project) {
  const plan = project.plan;
  return plan?.storyboard ? { storyPlan: plan.storyPlan, characterBible: plan.characterBible, storyboard: plan.storyboard } : null;
}

function draftFor(ctx) {
  const project = ctx.project;
  let draft = drafts.get(project.id);
  const saved = savedPlan(project);
  if (!draft) {
    const plan = saved
      ? normalizePlan(clone(saved), ctx.session.layouts)
      : emptyPlan({ title: project.title, pageCount: project.settings?.page_count || 2 }, ctx.session.layouts);
    draft = { base: project.revision, saved: saved ? clone(plan) : null, plan, tab: saved ? "storyboard" : "story", panel: null, issues: null, validating: false, loadedRun: null };
    drafts.set(project.id, draft);
  } else if (project.revision !== draft.base && !isDirty(draft)) {
    // Nothing unsaved: follow the project to its newest plan.
    const plan = saved ? normalizePlan(clone(saved), ctx.session.layouts) : draft.plan;
    Object.assign(draft, { base: project.revision, saved: saved ? clone(plan) : null, plan });
  }
  return draft;
}

function isDirty(draft) {
  return !draft.saved || !planEquals(draft.plan, draft.saved);
}

export function renderPlan(container, ctx) {
  const draft = draftFor(ctx);
  const project = ctx.project;
  const layouts = ctx.session.layouts;
  const refs = {};

  const rerender = () => renderPlan(container, ctx);
  const changed = () => {
    refs.save.disabled = !isDirty(draft);
    refs.dirty.textContent = isDirty(draft) ? (draft.saved ? "Unsaved changes" : "Not saved yet") : "Saved";
    validate();
  };
  const structural = (next) => {
    draft.plan = normalizePlan(next, layouts);
    rerender();
    validate();
  };

  const validate = debounce(async () => {
    draft.validating = true;
    paintStatus();
    try {
      const { issues } = await api.validatePlan(project.id, draft.plan);
      draft.issues = issues;
    } catch (error) {
      draft.issues = null;
      if (error.code !== "offline") toastError(error);
    } finally {
      draft.validating = false;
      paintStatus();
      paintIssues();
      paintMarkers();
    }
  }, 650);

  // Header ---------------------------------------------------------------------------
  refs.status = h("p", { class: "plan-status", "aria-live": "polite" });
  refs.dirty = h("span", { class: "plan-dirty" }, isDirty(draft) ? (draft.saved ? "Unsaved changes" : "Not saved yet") : "Saved");
  refs.save = button("Save plan", { kind: "amber", disabled: !isDirty(draft) });
  refs.save.addEventListener("click", () => save(ctx, draft, refs, rerender));

  const paintStatus = () => {
    if (draft.validating) mount(refs.status, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), " Checking with the engine");
    else if (draft.issues === null) mount(refs.status, "Not checked yet");
    else if (draft.issues.length === 0) mount(refs.status, icon("check", 16), " The engine accepts this plan");
    else mount(refs.status, icon("warn", 16), ` ${draft.issues.length} ${draft.issues.length === 1 ? "issue" : "issues"} to fix`);
    refs.status.dataset.tone = draft.issues?.length ? "warn" : draft.issues ? "ok" : "";
  };

  refs.issues = h("div", { class: "issues", "aria-live": "polite" });
  const paintIssues = () => {
    const list = (draft.issues || []).map(parseIssue);
    if (draft.issues === null) {
      mount(refs.issues, h("p", { class: "muted" }, "Edits are checked by the engine a moment after you stop typing."));
      return;
    }
    if (!list.length) {
      mount(refs.issues, h("p", { class: "ok-line" }, icon("check", 16), " Ready to save."));
      return;
    }
    const tabFor = { story: "story", cast: "cast", storyboard: "storyboard", other: "json" };
    mount(
      refs.issues,
      h(
        "ul",
        { class: "issue-list" },
        list.slice(0, 60).map((issue) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "issue",
                onclick: () => {
                  draft.tab = tabFor[issue.doc];
                  if (issue.doc === "storyboard" && issue.pageIndex !== null && issue.panelIndex !== null) {
                    draft.panel = draft.plan.storyboard.pages[issue.pageIndex]?.panels[issue.panelIndex]?.id || draft.panel;
                  }
                  rerender();
                  const target = container.querySelector(`[data-path="${CSS.escape(issue.path)}"]`) || container.querySelector(`[data-field="${issue.doc}:${issue.field}"]`);
                  target?.focus();
                },
              },
              h("span", { class: "issue__where" }, issueWhere(issue, draft.plan)),
              h("span", { class: "issue__message" }, issue.message),
            ),
          ),
        ),
      ),
    );
  };

  refs.markers = [];
  const paintMarkers = () => {
    for (const marker of refs.markers) marker();
  };

  const tabs = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Plan documents" },
    TABS.map(([id, label]) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: "tabs__tab",
          id: `plan-tab-${id}`,
          "aria-selected": String(draft.tab === id),
          "aria-controls": "plan-panel",
          tabindex: draft.tab === id ? "0" : "-1",
          onclick: () => {
            draft.tab = id;
            rerender();
            container.querySelector(`#plan-tab-${id}`)?.focus();
          },
          onkeydown: (event) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
            if (!step) return;
            const index = TABS.findIndex(([tab]) => tab === draft.tab);
            draft.tab = TABS[(index + step + TABS.length) % TABS.length][0];
            rerender();
            container.querySelector(`#plan-tab-${draft.tab}`)?.focus();
          },
        },
        label,
      ),
    ),
  );

  const editors = { story: storyEditor, cast: castEditor, storyboard: storyboardEditor, json: jsonEditor };
  const editor = editors[draft.tab]({ ctx, draft, layouts, changed, structural, rerender, refs });

  mount(
    container,
    h(
      "div",
      { class: "page page--plan" },
      h(
        "header",
        { class: "page__head page__head--sticky" },
        h("div", {}, h("p", { class: "page__eyebrow" }, "Plan"), h("h1", { class: "page__title" }, "Story, cast, storyboard")),
        h("div", { class: "page__tools" }, refs.dirty, refs.save),
      ),
      staleBanner(ctx, draft, rerender),
      draftBanner(ctx, draft, rerender, validate),
      plannerBar(ctx, draft),
      h(
        "div",
        { class: "plan-layout" },
        h("div", { class: "plan-main" }, tabs, h("div", { class: "plan-panel", role: "tabpanel", id: "plan-panel", "aria-labelledby": `plan-tab-${draft.tab}` }, editor)),
        h("aside", { class: "plan-side", "aria-label": "Engine validation" }, h("h2", { class: "section-title" }, "Engine check"), refs.status, refs.issues),
      ),
    ),
  );
  paintStatus();
  paintIssues();
  paintMarkers();
  if (draft.issues === null && !draft.validating) validate();
}

const FIELD_NAMES = {
  continuity_anchor: "continuity anchor",
  age_band: "age",
  visual_fingerprint: "visual fingerprint",
  signature_props: "signature props",
  scene_id: "scene",
  speaker_anchor: "voice source",
  voice_source: "voice",
  render_mode: "drawn by",
};

function issueWhere(issue, plan) {
  const field = issue.field ? ` · ${FIELD_NAMES[issue.field] || issue.field.replace(/_/g, " ")}` : "";
  if (issue.doc === "story") return `${issue.sceneIndex !== null ? `Scene ${issue.sceneIndex + 1}` : "Story"}${field}`;
  if (issue.doc === "cast") {
    const character = plan.characterBible.characters[issue.characterIndex];
    return `${character ? character.name || character.id : "Cast"}${field}`;
  }
  if (issue.doc === "storyboard") {
    if (issue.pageIndex !== null && issue.panelIndex !== null) {
      return `${plan.storyboard.pages[issue.pageIndex]?.panels[issue.panelIndex]?.id || `Page ${issue.pageIndex + 1}`}${field}`;
    }
    return `${issue.pageIndex !== null ? `Page ${issue.pageIndex + 1}` : "Storyboard"}${field}`;
  }
  return `Plan${field}`;
}

async function save(ctx, draft, refs, rerender) {
  try {
    const project = await busy(refs.save, () => ctx.act(() => api.savePlan(ctx.project.id, draft.base, draft.plan)), "Saving");
    const plan = normalizePlan(clone(savedPlan(project)), ctx.session.layouts);
    Object.assign(draft, { base: project.revision, saved: clone(plan), plan, issues: [] });
    toast("Plan saved. The engine validated it and wrote the render prompts.", { tone: "success" });
    rerender();
  } catch (error) {
    if (error.status === 422 && error.details?.length) {
      draft.issues = error.details;
      rerender();
    } else if (error.stale) {
      draft.staleNotice = true;
      rerender();
    }
  }
}

function staleBanner(ctx, draft, rerender) {
  if (!(isDirty(draft) && draft.base !== ctx.project.revision)) return null;
  return h(
    "div",
    { class: "banner banner--warn", role: "status" },
    h("p", {}, "The saved plan changed while you were editing (another window or an agent). Saving now is refused so nothing is overwritten."),
    button("Load the saved plan", {
      kind: "ghost",
      size: "small",
      onClick: async () => {
        const ok = await confirmDialog({ title: "Discard your unsaved edits?", text: "The editor will show the plan that is saved on disk now.", confirmLabel: "Discard and load", tone: "danger" });
        if (!ok) return;
        drafts.delete(ctx.project.id);
        rerender();
      },
    }),
  );
}

function plannerBar(ctx, draft) {
  const planners = ctx.session.providers.planners;
  if (!planners.length) {
    return h(
      "p",
      { class: "hint-line" },
      "Write the plan here or use a starter. To draft with a model, connect one when launching Studio.",
    );
  }
  const running = (ctx.project.runs || []).find((run) => run.kind === "plan-draft" && (run.status === "queued" || run.status === "running"));
  if (running) {
    return h("div", { class: "banner", role: "status" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), h("p", {}, `${providerName(running.provider)} is drafting the plan. ${running.message || ""}`));
  }
  return h(
    "div",
    { class: "planner-bar" },
    h("p", {}, "Let a model draft the whole plan from your idea. You review it here before anything is saved."),
    h(
      "div",
      { class: "planner-bar__actions" },
      planners.map((planner) => {
        const start = button(`Draft with ${providerName(planner.id)}`, { kind: "ghost", size: "small" });
        start.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: `Draft the plan with ${providerName(planner.id)}?`,
            text: `Studio sends the title, the idea, the page count, and the language to ${providerName(planner.id)} (${planner.model}). The call is billed to the key you started Studio with. The engine checks the draft and asks the model to repair it up to two times.`,
            confirmLabel: "Send to the model",
          });
          if (!ok) return;
          try {
            await busy(start, () => api.draftPlan(ctx.project.id, ctx.project.revision, planner.id), "Starting");
            ctx.refresh();
          } catch (error) {
            toastError(error);
          }
        });
        return start;
      }),
    ),
  );
}

function draftBanner(ctx, draft, rerender, validate) {
  const run = (ctx.project.runs || []).find((item) => item.kind === "plan-draft" && item.status === "succeeded" && item.result?.documents);
  if (!run || draft.loadedRun === run.id || draft.dismissedRun === run.id) return null;
  return h(
    "div",
    { class: "banner banner--amber", role: "status" },
    h("p", {}, `${providerName(run.provider)} drafted a plan that passes the engine's validation. Load it into the editor to review and save it.`),
    h(
      "div",
      { class: "banner__actions" },
      button("Load the draft", {
        kind: "amber",
        size: "small",
        onClick: async () => {
          if (isDirty(draft) && draft.saved) {
            const ok = await confirmDialog({ title: "Replace your current edits?", text: "The editor will show the model's draft instead.", confirmLabel: "Load the draft" });
            if (!ok) return;
          }
          draft.plan = normalizePlan(clone(run.result.documents), ctx.session.layouts);
          draft.loadedRun = run.id;
          draft.issues = null;
          draft.tab = "story";
          rerender();
          validate();
        },
      }),
      button("Dismiss", {
        kind: "ghost",
        size: "small",
        onClick: () => {
          draft.dismissedRun = run.id;
          rerender();
        },
      }),
    ),
  );
}

// Story --------------------------------------------------------------------------------

function bound(obj, key, changed, attrs = {}) {
  return textInput(obj[key], (value) => {
    obj[key] = value;
    changed();
  }, attrs);
}

function boundArea(obj, key, changed, attrs = {}) {
  return textArea(obj[key], (value) => {
    obj[key] = value;
    changed();
  }, attrs);
}

function storyEditor({ draft, changed, structural }) {
  const story = draft.plan.storyPlan;
  const cast = draft.plan.characterBible.characters;
  const f = (label, key, area, hint) =>
    field(label, (area ? boundArea : bound)(story, key, changed, { "data-field": `story:${key}`, "data-path": key, rows: area || undefined }), { hint, wide: Boolean(area) });
  return h(
    "div",
    { class: "doc" },
    h(
      "section",
      { class: "doc__section" },
      h("h2", { class: "doc__title" }, "The story"),
      h(
        "div",
        { class: "form-grid form-grid--two" },
        f("Title", "title"),
        f("Setting", "setting", 0, "Where and when, in one line."),
        f("Logline", "logline", 2, "One sentence: who wants what, and what is in the way."),
        f("Theme", "theme", 2),
        field("Tone", chips(story.tone, (list) => {
          story.tone = list;
          changed();
        }, { label: "tone", placeholder: "intimate, tense, hopeful" }), { hint: "One or more words." }),
      ),
    ),
    h(
      "section",
      { class: "doc__section" },
      h("h2", { class: "doc__title" }, "The arc"),
      h("div", { class: "form-grid form-grid--two" }, f("Beginning", "beginning", 3), f("Turn", "turn", 3), f("Climax", "climax", 3), f("Ending", "ending", 3)),
    ),
    h(
      "section",
      { class: "doc__section" },
      h(
        "div",
        { class: "section-head" },
        h("h2", { class: "doc__title" }, "Scenes"),
        button("Add scene", {
          kind: "ghost",
          size: "small",
          iconName: "plus",
          disabled: story.scenes.length >= 5,
          onClick: () => {
            const next = clone(draft.plan);
            next.storyPlan.scenes.push(newScene(uniqueId("scene", next.storyPlan.scenes.map((scene) => scene.id))));
            structural(next);
          },
        }),
      ),
      h("p", { class: "muted" }, "Two to five scenes. The continuity anchor names visible architecture, palette, time, and light that every panel in the scene repeats."),
      h(
        "ol",
        { class: "cards" },
        story.scenes.map((scene, index) =>
          h(
            "li",
            { class: "card" },
            h(
              "div",
              { class: "card__head" },
              h("p", { class: "card__title" }, `Scene ${index + 1}`),
              button("Remove", {
                kind: "ghost",
                size: "small",
                disabled: story.scenes.length <= 1,
                onClick: () => structural(removeScene(draft.plan, scene.id)),
              }),
            ),
            h(
              "div",
              { class: "form-grid form-grid--two" },
              idField("Scene ID", scene.id, (value) => structural(renameScene(draft.plan, scene.id, value)), story.scenes.map((s) => s.id)),
              field("Time", bound(scene, "time", changed, { "data-path": `scenes[${index}].time` })),
              field("Location", bound(scene, "location", changed, { "data-path": `scenes[${index}].location` }), { wide: true }),
              field("Purpose", bound(scene, "purpose", changed, { "data-path": `scenes[${index}].purpose` }), { wide: true }),
              field("Continuity anchor", boundArea(scene, "continuity_anchor", changed, { rows: 2, "data-path": `scenes[${index}].continuity_anchor` }), { wide: true }),
              checkboxGroup(
                "Characters in this scene",
                cast.map((character) => [character.id, character.name || character.id]),
                scene.characters,
                (list) => {
                  scene.characters = list;
                  changed();
                },
                cast.length ? null : "Add characters on the Cast tab first.",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function idField(label, value, onRename, taken) {
  let current = value;
  const input = textInput(value, (next) => (current = next), { spellcheck: "false", autocomplete: "off" });
  const error = h("p", { class: "field__error", hidden: true });
  input.addEventListener("change", () => {
    const next = current.trim();
    if (next === value) return;
    if (!isValidId(next)) {
      error.hidden = false;
      error.textContent = "Lowercase letters, digits, and hyphens, starting with a letter.";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    if (taken.includes(next)) {
      error.hidden = false;
      error.textContent = "Another entry already uses this ID.";
      return;
    }
    onRename(next);
  });
  const wrap = field(label, input, { hint: "Used to link scenes, panels, and dialogue." });
  wrap.append(error);
  return wrap;
}

function checkboxGroup(label, options, selected, onChange, empty) {
  const chosen = new Set(selected);
  return h(
    "fieldset",
    { class: "checks field--wide" },
    h("legend", { class: "field__label" }, label),
    options.length
      ? options.map(([value, text]) =>
          h(
            "label",
            { class: "check" },
            h("input", {
              type: "checkbox",
              checked: chosen.has(value),
              onchange: (event) => {
                if (event.target.checked) chosen.add(value);
                else chosen.delete(value);
                onChange(options.map(([v]) => v).filter((v) => chosen.has(v)).concat(selected.filter((v) => !options.some(([o]) => o === v) && chosen.has(v))));
              },
            }),
            h("span", {}, text),
          ),
        )
      : h("p", { class: "muted" }, empty),
  );
}

// Cast ---------------------------------------------------------------------------------

function castEditor({ draft, changed, structural }) {
  const characters = draft.plan.characterBible.characters;
  return h(
    "div",
    { class: "doc" },
    h(
      "div",
      { class: "section-head" },
      h("div", {}, h("h2", { class: "doc__title" }, "Cast"), h("p", { class: "muted" }, "Every speaking or recurring character. The visual fingerprint is pasted into every prompt, so describe what is visible.")),
      button("Add character", {
        kind: "ghost",
        size: "small",
        iconName: "plus",
        onClick: () => {
          const next = clone(draft.plan);
          next.characterBible.characters.push(newCharacter(uniqueId("character", next.characterBible.characters.map((c) => c.id))));
          structural(next);
        },
      }),
    ),
    characters.length
      ? h(
          "ol",
          { class: "cards" },
          characters.map((character, index) => {
            const vf = character.visual_fingerprint;
            const path = (key) => `characters[${index}].${key}`;
            const vfPath = (key) => `characters[${index}].visual_fingerprint.${key}`;
            const list = (label, key, hint, max) =>
              field(label, chips(vf[key], (next) => {
                vf[key] = next;
                changed();
              }, { label, max }), { hint, wide: true });
            return h(
              "li",
              { class: "card card--cast" },
              h(
                "div",
                { class: "card__head" },
                h("p", { class: "card__title" }, character.name || `Character ${index + 1}`),
                button("Remove", {
                  kind: "ghost",
                  size: "small",
                  onClick: async () => {
                    const ok = await confirmDialog({ title: `Remove ${character.name || character.id}?`, text: "Their lines, scene and panel appearances, and continuity facts are removed too.", confirmLabel: "Remove", tone: "danger" });
                    if (ok) structural(removeCharacter(draft.plan, character.id));
                  },
                }),
              ),
              h(
                "div",
                { class: "form-grid form-grid--three" },
                field("Name", bound(character, "name", (...a) => {
                  changed(...a);
                }, { "data-path": path("name") })),
                idField("Character ID", character.id, (value) => structural(renameCharacter(draft.plan, character.id, value)), characters.map((c) => c.id)),
                field("Role", bound(character, "role", changed, { "data-path": path("role") })),
                field("Age", bound(character, "age_band", changed, { "data-path": path("age_band"), placeholder: "young adult" })),
                field("Pronouns", bound(character, "pronouns", changed, { "data-path": path("pronouns") })),
                field("Speech", bound(character, "speech", changed, { "data-path": path("speech") })),
                field("Motivation", bound(character, "motivation", changed, { "data-path": path("motivation") }), { wide: true }),
                field("Personality", chips(character.personality, (next) => {
                  character.personality = next;
                  changed();
                }, { label: "personality" }), { wide: true }),
              ),
              h("h3", { class: "card__sub" }, "Visual fingerprint"),
              h(
                "div",
                { class: "form-grid form-grid--two" },
                field("Silhouette", bound(vf, "silhouette", changed, { "data-path": vfPath("silhouette") })),
                field("Face", bound(vf, "face", changed, { "data-path": vfPath("face") })),
                field("Hair", bound(vf, "hair", changed, { "data-path": vfPath("hair") })),
                field("Wardrobe", bound(vf, "wardrobe", changed, { "data-path": vfPath("wardrobe") })),
                list("Always visible", "invariants", "Two to five facts a reviewer can check in any panel, such as a red scarf.", 5),
                list("Palette", "palette"),
                list("Signature props", "signature_props"),
                list("Avoid", "avoid", "Things the image model must not draw for this character."),
              ),
            );
          }),
        )
      : h("div", { class: "state" }, h("p", { class: "state__title" }, "No characters yet."), h("p", { class: "state__text" }, "Add the people (or creatures, or robots) who appear more than once or speak.")),
  );
}

// Storyboard -----------------------------------------------------------------------------

function storyboardEditor({ ctx, draft, layouts, changed, structural, refs }) {
  const pages = draft.plan.storyboard.pages;
  if (!draft.panel || !findPanel(draft.plan, draft.panel)) draft.panel = pages[0]?.panels[0]?.id || null;
  const selected = draft.panel ? findPanel(draft.plan, draft.panel) : null;
  const page = { width: ctx.session.page.width, height: ctx.session.page.height };

  const pageCards = pages.map((pageEntry, pageIndex) => {
    const panels = pageEntry.panels.map((panel, panelIndex) => {
      const rect = panel.rect || { x: 0, y: 0, width: page.width, height: page.height };
      const count = h("span", { class: "sheet__issues" });
      refs.markers.push(() => {
        const issues = issuesFor(draft.issues, (issue) => issue.doc === "storyboard" && issue.pageIndex === pageIndex && issue.panelIndex === panelIndex);
        count.textContent = issues.length ? String(issues.length) : "";
        count.hidden = !issues.length;
        count.setAttribute("aria-label", `${issues.length} issues`);
      });
      return h(
        "button",
        {
          type: "button",
          class: "sheet__panel",
          "aria-pressed": String(panel.id === draft.panel),
          "aria-label": `Panel ${panel.id}${panel.beat ? `: ${panel.beat}` : ""}`,
          style: {
            left: `${(rect.x / page.width) * 100}%`,
            top: `${(rect.y / page.height) * 100}%`,
            width: `${(rect.width / page.width) * 100}%`,
            height: `${(rect.height / page.height) * 100}%`,
          },
          onclick: () => {
            draft.panel = panel.id;
            structural(draft.plan);
          },
        },
        h("span", { class: "sheet__id" }, panel.id),
        panel.beat ? h("span", { class: "sheet__beat" }, panel.beat) : null,
        count,
      );
    });
    return h(
      "li",
      { class: "page-card" },
      h("div", { class: "sheet", style: { aspectRatio: `${page.width} / ${page.height}` } }, panels),
      h(
        "div",
        { class: "page-card__tools" },
        h("p", { class: "page-card__name" }, `Page ${pageIndex + 1}`),
        select(
          pageEntry.layout,
          Object.keys(layouts).map((name) => [name, `${LAYOUT_LABELS[name] || name} (${layoutPanelCount(layouts, name)})`]),
          (layout) => structural(setLayout(draft.plan, pageIndex, layout, layouts)),
          { "aria-label": `Layout for page ${pageIndex + 1}` },
        ),
        button("", {
          kind: "ghost",
          size: "icon",
          iconName: "trash",
          title: `Remove page ${pageIndex + 1}`,
          disabled: pages.length <= 1,
          onClick: async () => {
            const ok = await confirmDialog({ title: `Remove page ${pageIndex + 1}?`, text: "Its panels and their text are removed from the plan.", confirmLabel: "Remove page", tone: "danger" });
            if (ok) structural(removePage(draft.plan, pageIndex, layouts));
          },
        }),
      ),
    );
  });

  const total = allPanels(draft.plan).length;
  return h(
    "div",
    { class: "doc doc--storyboard" },
    h(
      "div",
      { class: "section-head" },
      h("div", {}, h("h2", { class: "doc__title" }, "Storyboard"), h("p", { class: "muted" }, `${pages.length} ${pages.length === 1 ? "page" : "pages"}, ${total} of 12 panels. Rectangles come from the engine's fixed layouts.`)),
      button("Add page", { kind: "ghost", size: "small", iconName: "plus", disabled: pages.length >= 4, onClick: () => structural(addPage(draft.plan, layouts)) }),
    ),
    h("ol", { class: "page-strip" }, pageCards),
    selected ? panelInspector({ ctx, draft, selected, changed, structural, refs }) : null,
  );
}

function panelInspector({ draft, selected, changed, structural, refs }) {
  const { panel, pageIndex, panelIndex } = selected;
  const plan = draft.plan;
  const p = (key) => `pages[${pageIndex}].panels[${panelIndex}].${key}`;
  const scenes = plan.storyPlan.scenes;
  const cast = plan.characterBible.characters;
  const options = continuityOptions(plan, panel);
  const unknown = panel.continuity.filter((entry) => !options.some((option) => option.value === entry));
  const panelIssues = h("ul", { class: "issue-list issue-list--inline" });
  refs.markers.push(() => {
    const issues = issuesFor(draft.issues, (issue) => issue.doc === "storyboard" && issue.pageIndex === pageIndex && issue.panelIndex === panelIndex);
    mount(panelIssues, issues.map((issue) => h("li", {}, h("strong", {}, issue.path.replace(/^pages\[\d+\]\.panels\[\d+\]\.?/, "") || "panel"), ` ${issue.message}`)));
  });
  const words = panelWords(panel);

  return h(
    "section",
    { class: "inspector", "aria-labelledby": "inspector-title" },
    h("div", { class: "section-head" }, h("h2", { class: "doc__title", id: "inspector-title" }, `Panel ${panel.id}`), badge(`${panel.rect?.width} × ${panel.rect?.height} px`, "neutral")),
    panelIssues,
    h(
      "div",
      { class: "form-grid form-grid--two" },
      field(
        "Scene",
        select(panel.scene_id, scenes.map((scene) => [scene.id, scene.id]), (value) => {
          panel.scene_id = value;
          structural(plan);
        }, { "data-path": p("scene_id") }),
      ),
      field("Beat", bound(panel, "beat", changed, { "data-path": p("beat") }), { hint: "The single story beat this panel carries." }),
      checkboxGroup(
        "Who is visible",
        cast.map((character) => [character.id, character.name || character.id]),
        panel.characters,
        (list) => {
          panel.characters = list;
          structural(plan);
        },
        "Add characters on the Cast tab first.",
      ),
      field("Shot", bound(panel, "shot", changed, { "data-path": p("shot"), placeholder: "medium two-shot, eye level" })),
      field("Lighting", bound(panel, "lighting", changed, { "data-path": p("lighting") })),
      field("Composition", boundArea(panel, "composition", changed, { rows: 2, "data-path": p("composition") }), { wide: true, hint: "Where subjects sit, and where the balloons will go." }),
      field("Action", boundArea(panel, "action", changed, { rows: 2, "data-path": p("action") }), { wide: true }),
      field("Expression", bound(panel, "expression", changed, { "data-path": p("expression") }), { wide: true }),
      h(
        "fieldset",
        { class: "checks field--wide" },
        h("legend", { class: "field__label" }, "Continuity checked in review"),
        options.length
          ? options.map((option) =>
              h(
                "label",
                { class: "check" },
                h("input", {
                  type: "checkbox",
                  checked: panel.continuity.includes(option.value),
                  onchange: (event) => {
                    panel.continuity = event.target.checked
                      ? [...panel.continuity, option.value]
                      : panel.continuity.filter((entry) => entry !== option.value);
                    changed();
                  },
                }),
                h("span", {}, h("strong", {}, option.owner), `: ${option.fact}`),
              ),
            )
          : h("p", { class: "muted" }, "Pick visible characters and give them invariants, or give the scene a continuity anchor."),
        unknown.length
          ? h(
              "div",
              { class: "unknown-facts" },
              h("p", { class: "field__error" }, "These facts no longer match a character invariant or scene anchor:"),
              unknown.map((entry) =>
                h("span", { class: "chip" }, h("span", {}, entry), h("button", { type: "button", class: "chip__remove", "aria-label": `Remove ${entry}`, onclick: () => {
                  panel.continuity = panel.continuity.filter((item) => item !== entry);
                  structural(plan);
                } }, icon("close", 12))),
              ),
            )
          : null,
      ),
      field("Do not draw", chips(panel.negative, (list) => {
        panel.negative = list;
        changed();
      }, { label: "do not draw" }), { wide: true, hint: "Keep “generated text”, “speech bubbles”, and “watermark”." }),
    ),
    h(
      "div",
      { class: "section-head" },
      h("h3", { class: "card__sub" }, "Lettering"),
      h("p", { class: `meter${words > 45 ? " meter--over" : ""}` }, `${words} of 45 words`),
    ),
    h(
      "ol",
      { class: "text-items" },
      panel.text.map((item, index) => textItemEditor({ plan, panel, item, index, changed, structural, pathPrefix: p(`text[${index}]`) })),
    ),
    h(
      "div",
      { class: "button-row" },
      TEXT_KINDS.map((kind) =>
        button(`Add ${kind === "sfx" ? "sound effect" : kind}`, {
          kind: "ghost",
          size: "small",
          iconName: "plus",
          disabled: panel.text.length >= 3,
          onClick: () => {
            panel.text.push(newTextItem(kind, panel.characters[0] || null));
            structural(plan);
          },
        }),
      ),
    ),
  );
}

function textItemEditor({ plan, panel, item, index, changed, structural, pathPrefix }) {
  const cast = plan.characterBible.characters.filter((character) => panel.characters.includes(character.id));
  const marker = h("span", { class: "anchor-pad__marker", "aria-hidden": "true" });
  const placeMarker = () => {
    if (!Array.isArray(item.speaker_anchor)) return;
    marker.style.left = `${item.speaker_anchor[0] * 100}%`;
    marker.style.top = `${item.speaker_anchor[1] * 100}%`;
  };
  placeMarker();
  const anchorPad =
    item.kind === "dialogue"
      ? h(
          "div",
          { class: "field" },
          h("p", { class: "field__label" }, "Voice source"),
          h(
            "button",
            {
              type: "button",
              class: "anchor-pad",
              style: { aspectRatio: `${panel.rect?.width || 4} / ${panel.rect?.height || 3}` },
              "aria-label": `Speaker's mouth position, now ${Math.round(item.speaker_anchor[0] * 100)}% across and ${Math.round(item.speaker_anchor[1] * 100)}% down. Click the panel to move it; arrow keys nudge it.`,
              onclick: (event) => {
                const box = event.currentTarget.getBoundingClientRect();
                if (!event.clientX && !event.clientY) return;
                item.speaker_anchor = [
                  Math.round(((event.clientX - box.left) / box.width) * 100) / 100,
                  Math.round(((event.clientY - box.top) / box.height) * 100) / 100,
                ];
                placeMarker();
                changed();
              },
              onkeydown: (event) => {
                const step = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] }[event.key];
                if (!step) return;
                event.preventDefault();
                item.speaker_anchor = item.speaker_anchor.map((value, axis) => Math.min(1, Math.max(0, Math.round((value + step[axis]) * 100) / 100)));
                placeMarker();
                changed();
              },
            },
            marker,
          ),
          h("p", { class: "field__hint" }, "Click where the speaker's mouth (or the device) is in the panel."),
        )
      : null;

  return h(
    "li",
    { class: "text-item" },
    h(
      "div",
      { class: "card__head" },
      h("p", { class: "card__title" }, `${item.kind === "sfx" ? "Sound effect" : item.kind[0].toUpperCase() + item.kind.slice(1)} ${index + 1}`),
      button("Remove", {
        kind: "ghost",
        size: "small",
        onClick: () => {
          panel.text.splice(index, 1);
          structural(plan);
        },
      }),
    ),
    h(
      "div",
      { class: "text-item__grid" },
      h(
        "div",
        { class: "form-grid form-grid--two" },
        field(
          "Kind",
          select(item.kind, TEXT_KINDS.map((kind) => [kind, kind === "sfx" ? "sound effect" : kind]), (kind) => {
            const replacement = newTextItem(kind, panel.characters[0] || null);
            replacement.content = item.content;
            replacement.anchor = item.anchor;
            panel.text[index] = replacement;
            structural(plan);
          }),
        ),
        field("Placement", select(item.anchor, ANCHORS.map((anchor) => [anchor, anchor.replace("-", " ")]), (value) => {
          item.anchor = value;
          changed();
        }, { "data-path": `${pathPrefix}.anchor` })),
        item.kind === "dialogue"
          ? field(
              "Speaker",
              select(item.speaker || "", [["", "Choose"], ...cast.map((character) => [character.id, character.name || character.id])], (value) => {
                item.speaker = value || null;
                changed();
              }, { "data-path": `${pathPrefix}.speaker` }),
              { hint: cast.length ? null : "Mark who is visible in this panel first." },
            )
          : null,
        item.kind === "dialogue"
          ? field("Voice", segmented(item.voice_source, [["human", "Person"], ["device", "Device"]], (value) => {
              item.voice_source = value;
              structural(plan);
            }, { label: "Voice" }))
          : null,
        item.kind === "sfx"
          ? field(
              "Drawn by",
              select(item.render_mode || "generated-visual", [["generated-visual", "The image model"], ["deterministic-lettering", "The engine (exact text)"]], (value) => {
                item.render_mode = value;
                changed();
              }),
            )
          : null,
        field(
          "Words",
          textArea(item.content, (value) => {
            item.content = value;
            changed();
          }, { rows: 2, "data-path": `${pathPrefix}.content` }),
          { wide: true, hint: `${wordCount(item.content)} ${item.kind === "dialogue" ? "of 32" : item.kind === "sfx" ? "of 3" : "of 45"} words` },
        ),
      ),
      anchorPad,
    ),
  );
}

// JSON --------------------------------------------------------------------------------------

function jsonEditor({ draft, structural }) {
  const docs = [
    ["storyPlan", "plan/story-plan.json"],
    ["characterBible", "plan/character-bible.json"],
    ["storyboard", "plan/storyboard.json"],
  ];
  const areas = {};
  const message = h("p", { class: "field__error", "aria-live": "polite" });
  return h(
    "div",
    { class: "doc" },
    h("p", { class: "muted" }, "The exact documents the engine stores. Edit them directly when the forms are not enough; IDs, order, and rectangles are re-derived when you apply."),
    docs.map(([key, name]) => {
      areas[key] = textArea(JSON.stringify(draft.plan[key], null, 2), () => {}, { rows: 14, spellcheck: "false", class: "input input--area input--code", "aria-label": name });
      return field(name, areas[key], { wide: true });
    }),
    message,
    h(
      "div",
      { class: "button-row" },
      button("Apply JSON to the draft", {
        kind: "ghost",
        onClick: () => {
          const next = {};
          for (const [key, name] of docs) {
            try {
              next[key] = JSON.parse(areas[key].value);
            } catch (error) {
              message.textContent = `${name} is not valid JSON: ${error.message}`;
              return;
            }
          }
          message.textContent = "";
          structural(next);
          toast("Applied. The engine is checking the draft.", { tone: "info" });
        },
      }),
    ),
  );
}

export function forgetPlanDraft(projectId) {
  drafts.delete(projectId);
}
