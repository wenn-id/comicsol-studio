// Plan: read the four plan documents as a story, a cast, and real page
// layouts; edit their JSON; review a line diff; then save and approve production.

import {
  StaleRevisionError,
  StudioApiError,
  approveWorkflow,
  getGenerationOptions,
  getPlanningJob,
  getProject,
  updatePlan,
} from "/static/api.js";
import { h, icon, replace } from "../dom.js";
import { humanize, plural, stateLabel } from "../format.js";
import {
  PLAN_DOCUMENTS,
  PLAN_KEYS,
  changedKeys,
  characterCards,
  diffHunks,
  diffStats,
  documentDiff,
  documentIsBlank,
  outlineEntries,
  parseDocument,
  persistReviewedDraft,
  planShapeIssues,
  responseMatchesProject,
  safeProposal,
  storyOutline,
  storyboardPages,
  tidyJson,
} from "../plan-model.js";

const PLANNING_POLL_MS = 1500;
const BLANK_HINTS = Object.freeze({
  storyPlan: "No story yet. Your planner fills this in, or write the logline, beats, and scenes in Edit.",
  characterBible: "No characters yet. Add who appears and how they look in Edit.",
  storyboard: "No pages yet. Your planner lays out pages and panels, or add them in Edit.",
  visualIdentityPack: "No visual identity yet. A planner derives it from the character bible so every panel draws the same cast. The plan cannot be saved without it.",
});

const controlId = (key) => `plan-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

function chips(values, className = "chip") {
  if (!values.length) return null;
  return h("ul", { class: "chips" }, values.map((value) => h("li", { class: className, text: value })));
}

function blankState(key) {
  return h("div", { class: "state-note" }, h("p", { text: BLANK_HINTS[key] }));
}

function renderStory(value) {
  const story = storyOutline(value);
  const facts = [["Setting", story.setting], ["Theme", story.theme]].filter(([, detail]) => detail);
  return h(
    "article",
    { class: "story-read" },
    h("h2", { class: "story-title", text: story.title || "Untitled story" }),
    story.logline ? h("p", { class: "logline", text: story.logline }) : null,
    chips([...story.tone, ...(story.rating ? [`Rated ${story.rating}`] : [])]),
    facts.length
      ? h("dl", { class: "fact-list" }, facts.map(([label, detail]) => [h("dt", { text: label }), h("dd", { text: detail })]))
      : null,
    h("h3", { class: "read-heading", text: "Beats" }),
    h(
      "ol",
      { class: "beat-strip" },
      story.beats.map((beat, index) => h(
        "li",
        { class: `beat${beat.text ? "" : " beat-empty"}` },
        h("span", { class: "beat-no", text: String(index + 1).padStart(2, "0") }),
        h("h4", { text: beat.label }),
        h("p", { text: beat.text || "Not written yet." }),
      )),
    ),
    story.scenes.length ? h("h3", { class: "read-heading", text: plural(story.scenes.length, "scene") }) : null,
    story.scenes.length
      ? h(
        "ol",
        { class: "scene-list" },
        story.scenes.map((scene) => h(
          "li",
          { class: "scene" },
          h("h4", { text: [scene.location || scene.id, scene.time].filter(Boolean).join(" · ") }),
          scene.purpose ? h("p", { text: scene.purpose }) : null,
          scene.anchor ? h("p", { class: "scene-anchor" }, h("strong", { text: "Continuity " }), scene.anchor) : null,
          chips(scene.characters, "chip chip-cast"),
        )),
      )
      : null,
  );
}

function renderCharacters(value) {
  const cards = characterCards(value);
  if (!cards.length) return null;
  return h(
    "div",
    { class: "cast" },
    cards.map((card) => h(
      "article",
      { class: "cast-card" },
      h(
        "header",
        {},
        h("h3", { text: card.name }),
        h("p", { class: "cast-meta", text: [card.role, card.pronouns, card.ageBand && humanize(card.ageBand)].filter(Boolean).join(" · ") }),
      ),
      card.motivation ? h("p", { class: "cast-motive", text: card.motivation }) : null,
      chips(card.personality),
      card.look.length
        ? h("dl", { class: "fact-list" }, card.look.map(([label, detail]) => [h("dt", { text: label }), h("dd", { text: detail })]))
        : null,
      card.speech ? h("p", { class: "cast-line" }, h("strong", { text: "Speaks in " }), card.speech) : null,
      card.palette.length ? h("div", { class: "cast-row" }, h("span", { class: "cast-label", text: "Palette" }), chips(card.palette, "chip chip-swatch")) : null,
      card.props.length ? h("div", { class: "cast-row" }, h("span", { class: "cast-label", text: "Props" }), chips(card.props)) : null,
      card.invariants.length ? h("div", { class: "cast-row" }, h("span", { class: "cast-label", text: "Always" }), chips(card.invariants)) : null,
      card.avoid.length ? h("div", { class: "cast-row" }, h("span", { class: "cast-label", text: "Never" }), chips(card.avoid, "chip chip-avoid")) : null,
    )),
  );
}

function panelDetail(page, panel) {
  if (!panel) return h("p", { class: "field-help", text: "Choose a panel to read its direction." });
  const facts = [
    ["Action", panel.action],
    ["Composition", panel.composition],
    ["Lighting", panel.lighting],
    ["Expression", panel.expression],
    ["Scene", panel.sceneId],
  ].filter(([, detail]) => detail);
  return h(
    "div",
    { class: "panel-detail-body" },
    h("p", { class: "eyebrow", text: `Page ${page.number} / Panel ${panel.order}` }),
    h("h3", { text: panel.shot || panel.beat || panel.id }),
    panel.shot && panel.beat ? h("p", { class: "panel-beat", text: panel.beat }) : null,
    facts.length
      ? h("dl", { class: "fact-list" }, facts.map(([label, detail]) => [h("dt", { text: label }), h("dd", { text: detail })]))
      : null,
    chips(panel.characters, "chip chip-cast"),
    panel.lettering.length
      ? h(
        "ul",
        { class: "lettering" },
        panel.lettering.map((item) => h(
          "li",
          { class: `letter letter-${item.kind.replace(/[^a-z]/gi, "") || "text"}` },
          h("span", { class: "letter-kind", text: [humanize(item.kind), item.speaker].filter(Boolean).join(" · ") }),
          h("q", { text: item.content }),
        )),
      )
      : h("p", { class: "field-help", text: "No lettering on this panel." }),
  );
}

function renderStoryboard(value) {
  const pages = storyboardPages(value);
  if (!pages.length) return null;
  let selected = { page: pages[0], panel: pages[0].panels[0] || null };
  const detail = h("div", { class: "panel-detail", "aria-live": "polite" });
  const buttons = [];

  function select(page, panel) {
    selected = { page, panel };
    for (const button of buttons) {
      button.node.setAttribute("aria-pressed", String(button.panel === panel));
    }
    replace(detail, panelDetail(page, panel));
  }

  const board = h(
    "div",
    { class: "board" },
    pages.map((page) => {
      const sheet = h("div", { class: "page-sheet-view" });
      const fallback = [];
      for (const panel of page.panels) {
        const label = `Page ${page.number}, panel ${panel.order}${panel.shot ? `: ${panel.shot}` : ""}`;
        const node = h(
          "button",
          { type: "button", class: "panel-box", "aria-label": label, "aria-pressed": "false" },
          h("span", { class: "panel-no", text: String(panel.order) }),
          h("span", { class: "panel-shot", text: panel.shot || panel.beat || "" }),
        );
        if (panel.box) {
          node.style.setProperty("left", `${panel.box.left}%`);
          node.style.setProperty("top", `${panel.box.top}%`);
          node.style.setProperty("width", `${panel.box.width}%`);
          node.style.setProperty("height", `${panel.box.height}%`);
          sheet.append(node);
        } else {
          node.classList.add("panel-box-flow");
          fallback.push(node);
        }
        node.addEventListener("click", () => select(page, panel));
        buttons.push({ node, panel });
      }
      return h(
        "figure",
        { class: "page-figure" },
        sheet,
        fallback.length ? h("div", { class: "panel-flow" }, fallback) : null,
        h("figcaption", {}, h("strong", { text: `Page ${page.number}` }), page.layout ? ` · ${humanize(page.layout)}` : ""),
      );
    }),
  );
  select(selected.page, selected.panel);
  return h("div", { class: "storyboard-read" }, board, detail);
}

function renderOutline(nodes) {
  return h(
    "dl",
    { class: "outline" },
    nodes.map((node) => [
      h("dt", { text: node.label }),
      h("dd", {}, node.children ? (node.children.length ? renderOutline(node.children) : "Empty") : (node.text || "Empty")),
    ]),
  );
}

function renderReadable(key, source, onEdit) {
  const parsed = parseDocument(source);
  if (parsed.state === "invalid") {
    return h(
      "div",
      { class: "state-note state-note-error" },
      icon("alert"),
      h("p", {}, `${parsed.message} The readable view needs valid JSON. `),
      h("button", { type: "button", class: "button button-quiet", on: { click: onEdit } }, "Fix it in Edit"),
    );
  }
  if (documentIsBlank(key, parsed)) return blankState(key);
  const value = parsed.value;
  let rendered = null;
  if (key === "storyPlan") rendered = renderStory(value);
  else if (key === "characterBible") rendered = renderCharacters(value);
  else if (key === "storyboard") rendered = renderStoryboard(value);
  return rendered || renderOutline(outlineEntries(value));
}

function renderDiff(container, workingPlan, draft) {
  replace(container);
  if (!draft) {
    container.append(h("p", { class: "field-help", text: "No draft is waiting. Edit a document, then choose Review changes." }));
    return;
  }
  container.append(h(
    "p",
    { class: `notice${draft.origin === "agent" ? " notice-agent" : ""}` },
    draft.origin === "agent"
      ? "Your agent proposed these changes. Nothing is saved until you save it."
      : "These are your edits. Nothing is saved until you save it.",
  ));
  const keys = changedKeys(workingPlan, draft.changes);
  if (!keys.length) {
    container.append(h("p", { class: "field-help", text: "The draft matches the saved plan." }));
    return;
  }
  for (const key of keys) {
    const entry = PLAN_DOCUMENTS.find((item) => item.key === key);
    const { diff, formattingOnly } = documentDiff(workingPlan[key], draft.changes[key]);
    const stats = diffStats(diff);
    const block = h(
      "section",
      { class: "diff-block", "aria-label": `${entry.title} changes` },
      h(
        "header",
        { class: "diff-head" },
        h("h3", { text: entry.title }),
        diff && !formattingOnly
          ? h("p", { class: "diff-stats" }, h("span", { class: "diff-add", text: `+${stats.added}` }), " ", h("span", { class: "diff-del", text: `-${stats.removed}` }))
          : null,
      ),
    );
    if (formattingOnly) {
      block.append(h("p", { class: "diff-note", text: "Only formatting changed. The content is the same." }));
    } else if (diff) {
      block.append(h(
        "ol",
        { class: "diff-lines" },
        diffHunks(diff).map((row) => (row.type === "skip"
          ? h("li", { class: "diff-skip", text: `${row.count} unchanged line${row.count === 1 ? "" : "s"}` })
          : h(
            "li",
            { class: `diff-${row.type}` },
            h("span", { class: "diff-sign", "aria-hidden": "true", text: row.type === "add" ? "+" : row.type === "del" ? "-" : " " }),
            h("span", { class: "visually-hidden", text: row.type === "add" ? "Added: " : row.type === "del" ? "Removed: " : "" }),
            h("code", { text: row.text || " " }),
          ))),
      ));
    } else {
      block.append(
        h("p", { class: "field-help", text: "This document is too large for a line diff. Compare both versions below." }),
        h("p", { class: "diff-label", text: "Saved" }),
        h("pre", { class: "diff-blob", text: workingPlan[key] || "Empty" }),
        h("p", { class: "diff-label", text: "Proposed" }),
        h("pre", { class: "diff-blob", text: draft.changes[key] || "Empty" }),
      );
    }
    container.append(block);
  }
}

let activeProposalHandler = null;

export function mountPlanView({ store, announce, navigate, setFocusMode, refreshWorkflow }) {
  let project = store.getState().project;
  let lastWorkingPlan = null;
  let lastDraft;
  let activeKey = PLAN_KEYS[0];
  let mode = "read";
  let promotionPending = false;
  // The draft currently being saved. The server stores canonical JSON, so the
  // saved text can differ from what was typed; that echo is not a conflict.
  let savingDraft = null;
  let pollTimer = null;
  let polledJobId = null;
  let disposed = false;
  let imageOptions = [];
  const draftKeys = new WeakMap();
  const controls = {};
  const readers = {};
  const tabs = {};
  const panes = {};
  const jsonStatus = {};

  // Header
  const statusFact = h("span", { class: "fact-value" });
  const revisionFact = h("span", { class: "fact-value" });
  const refreshButton = h("button", { type: "button", class: "button button-quiet", id: "refresh-project" }, icon("refresh"), "Refresh revision");
  const focusButton = h(
    "button",
    { type: "button", class: "button button-quiet", on: { click: () => setFocusMode(document.body.dataset.focus !== "true") } },
    icon("focus"),
    "Focus",
  );
  const banner = h("div", { class: "banner", hidden: true, role: "status" });

  // Binder
  const tabList = h("div", { class: "binder-tabs", role: "tablist", "aria-label": "Plan documents" });
  const readToggle = h("button", { type: "button", "aria-pressed": "true", text: "Read" });
  const editToggle = h("button", { type: "button", "aria-pressed": "false", text: "Edit" });
  const tidyButton = h("button", { type: "button", class: "button button-quiet", hidden: true, text: "Tidy JSON" });
  const form = h("form", { id: "plan-editor", class: "binder-body" });
  const changeSummary = h("p", { class: "binder-summary", "aria-live": "polite" });
  const reviewButton = h("button", { type: "submit", form: "plan-editor", class: "button button-primary" }, "Review changes");
  const resetButton = h("button", { type: "button", class: "button", text: "Discard edits" });

  for (const entry of PLAN_DOCUMENTS) {
    const id = controlId(entry.key);
    const tab = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `${id}-tab`,
        "aria-controls": `${id}-pane`,
        "aria-selected": "false",
        tabindex: "-1",
        class: "binder-tab",
      },
      h("span", { class: "tab-title", text: entry.title }),
      h("span", { class: "tab-hint", text: entry.hint }),
      h("span", { class: "tab-dot", "aria-hidden": "true" }),
    );
    tab.addEventListener("click", () => selectDocument(entry.key));
    tabs[entry.key] = tab;
    tabList.append(tab);

    const control = h("textarea", {
      id,
      name: entry.key,
      class: "code-editor",
      maxlength: "1048576",
      spellcheck: "false",
      "aria-describedby": `${id}-status`,
    });
    control.addEventListener("input", () => {
      refreshDirty();
      refreshJsonStatus(entry.key);
    });
    controls[entry.key] = control;
    jsonStatus[entry.key] = h("p", { class: "json-status", id: `${id}-status` });
    readers[entry.key] = h("div", { class: "doc-read" });
    panes[entry.key] = h(
      "div",
      { class: "doc-pane", role: "tabpanel", id: `${id}-pane`, "aria-labelledby": `${id}-tab`, hidden: true },
      readers[entry.key],
      h(
        "div",
        { class: "doc-edit" },
        h("label", { for: id, class: "visually-hidden", text: `${entry.title} JSON` }),
        control,
        jsonStatus[entry.key],
      ),
    );
    form.append(panes[entry.key]);
  }

  tabList.addEventListener("keydown", (event) => {
    const index = PLAN_KEYS.indexOf(activeKey);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = PLAN_KEYS[(index + 1) % PLAN_KEYS.length];
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = PLAN_KEYS[(index - 1 + PLAN_KEYS.length) % PLAN_KEYS.length];
    if (event.key === "Home") next = PLAN_KEYS[0];
    if (event.key === "End") next = PLAN_KEYS[PLAN_KEYS.length - 1];
    if (!next) return;
    event.preventDefault();
    selectDocument(next);
    tabs[next].focus();
  });

  const binder = h(
    "section",
    { class: "panel panel-marked binder", "aria-label": "Plan documents" },
    tabList,
    h(
      "div",
      { class: "binder-toolbar" },
      h("div", { class: "segmented segmented-buttons", role: "group", "aria-label": "Document view" }, readToggle, editToggle),
      tidyButton,
    ),
    form,
    h("footer", { class: "binder-foot" }, changeSummary, h("div", { class: "actions" }, resetButton, reviewButton)),
  );

  // Draft review
  const diff = h("div", { id: "draft-diff", class: "draft-diff" });
  const saveButton = h("button", { type: "button", class: "button button-primary" }, "Save to project");
  const discardButton = h("button", { type: "button", class: "button", text: "Discard draft" });
  const reviewActions = h("div", { class: "actions" }, saveButton, discardButton);
  const staleNote = h("p", {
    class: "notice notice-warn",
    hidden: true,
    text: "The editor changed after this draft was made. Choose Update draft to include the newer edits.",
  });
  const reviewPanel = h(
    "section",
    { class: "panel review-panel", "aria-labelledby": "draft-heading", tabindex: "-1" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Before it is saved" }), h("h2", { id: "draft-heading", text: "Draft review" })),
    staleNote,
    diff,
    reviewActions,
  );

  // Production approval
  const imageModel = h("select", { id: "workflow-image-model", name: "imageModel", "aria-describedby": "workflow-help" });
  const approveButton = h("button", { type: "button", class: "button button-primary", disabled: true }, "Approve plan and start production");
  const approvalHelp = h("p", { class: "field-help", id: "workflow-help" });
  const approvalPanel = h(
    "section",
    { class: "panel approval-panel", "aria-labelledby": "workflow-heading" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Next / Production" }), h("h2", { id: "workflow-heading", text: "Approve production" })),
    h("div", { class: "field" }, h("label", { for: "workflow-image-model", text: "Image route" }), imageModel),
    approvalHelp,
    h("div", { class: "actions" }, approveButton),
  );

  const element = h(
    "div",
    { class: "view view-plan" },
    h(
      "header",
      { class: "stage-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow", text: "02 / Plan" }),
        h("h1", { text: "Shape the story" }),
        h(
          "p",
          { class: "stage-facts" },
          h("span", { class: "fact" }, h("span", { class: "fact-label", text: "Status" }), statusFact),
          h("span", { class: "fact" }, h("span", { class: "fact-label", text: "Revision" }), revisionFact),
        ),
      ),
      h("div", { class: "stage-tools" }, refreshButton, focusButton),
    ),
    banner,
    h("div", { class: "plan-layout" }, binder, h("div", { class: "plan-side" }, reviewPanel, approvalPanel)),
  );

  function editorValues() {
    return Object.fromEntries(PLAN_KEYS.map((key) => [key, controls[key].value]));
  }

  function dirtyKeys() {
    const working = store.getState().workingPlan;
    return PLAN_KEYS.filter((key) => controls[key].value !== working[key]);
  }

  function refreshDirty() {
    const dirty = dirtyKeys();
    for (const key of PLAN_KEYS) tabs[key].dataset.dirty = String(dirty.includes(key));
    const draft = store.getState().draft;
    changeSummary.textContent = dirty.length
      ? `${plural(dirty.length, "document")} changed and not saved.`
      : "No unsaved edits.";
    const draftCurrent = draft?.origin === "creator" && !changedKeys(draft.changes, editorValues()).length;
    reviewButton.textContent = draftCurrent ? "Draft up to date" : draft?.origin === "creator" ? "Update draft" : "Review changes";
    staleNote.hidden = !(draft?.origin === "creator" && !draftCurrent);
    reviewButton.disabled = promotionPending || !dirty.length || draftCurrent;
    resetButton.disabled = promotionPending || !dirty.length;
    for (const control of Object.values(controls)) control.readOnly = promotionPending;
  }

  function refreshJsonStatus(key) {
    const parsed = parseDocument(controls[key].value);
    const node = jsonStatus[key];
    node.dataset.state = parsed.state;
    node.textContent = parsed.state === "valid" ? "Valid JSON" : parsed.state === "empty" ? "Empty document" : parsed.message;
    if (key === activeKey) tidyButton.disabled = parsed.state !== "valid";
  }

  function renderReader(key) {
    replace(readers[key], renderReadable(key, controls[key].value, () => setMode("edit")));
  }

  function selectDocument(key) {
    activeKey = key;
    for (const entry of PLAN_DOCUMENTS) {
      const selected = entry.key === key;
      tabs[entry.key].setAttribute("aria-selected", String(selected));
      tabs[entry.key].tabIndex = selected ? 0 : -1;
      panes[entry.key].hidden = !selected;
    }
    if (mode === "read") renderReader(key);
    refreshJsonStatus(key);
  }

  function setMode(next, { focus = true } = {}) {
    mode = next;
    readToggle.setAttribute("aria-pressed", String(mode === "read"));
    editToggle.setAttribute("aria-pressed", String(mode === "edit"));
    binder.dataset.mode = mode;
    tidyButton.hidden = mode !== "edit";
    if (mode === "read") renderReader(activeKey);
    else if (focus) controls[activeKey].focus();
  }
  readToggle.addEventListener("click", () => setMode("read"));
  editToggle.addEventListener("click", () => setMode("edit"));
  tidyButton.addEventListener("click", () => {
    const tidy = tidyJson(controls[activeKey].value);
    if (tidy === null) return;
    controls[activeKey].value = tidy;
    refreshDirty();
    refreshJsonStatus(activeKey);
    announce("JSON tidied. Review changes to keep it.");
  });

  resetButton.addEventListener("click", () => {
    const working = store.getState().workingPlan;
    for (const key of PLAN_KEYS) controls[key].value = working[key];
    refreshDirty();
    refreshJsonStatus(activeKey);
    if (mode === "read") renderReader(activeKey);
    announce("Edits discarded. The editor shows the saved plan again.");
  });

  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!reviewButton.disabled) form.requestSubmit();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (promotionPending || !dirtyKeys().length) return;
    store.createDraft(editorValues());
    announce("Draft ready. Read the changes before you save them.");
    reviewPanel.focus({ preventScroll: false });
    reviewPanel.scrollIntoView({ block: "nearest" });
  });

  async function refreshProject(force = false) {
    if (promotionPending && !force) return;
    announce("Checking the project revision…");
    try {
      const requestedProjectId = project.project_id;
      const refreshed = await getProject(requestedProjectId);
      const currentProject = store.getState().project;
      if (!responseMatchesProject(requestedProjectId, currentProject, refreshed)) return;
      const previousRevision = currentProject.revision;
      if (refreshed.revision !== previousRevision) {
        for (const key of PLAN_KEYS) controls[key].value = refreshed.summary.plan[key];
        store.clearDraft();
        store.replaceProject(refreshed);
        refreshDirty();
        if (mode === "read") renderReader(activeKey);
        announce("The project changed elsewhere. The stale draft was discarded; you are on the newest revision.", "error");
      } else {
        store.replaceProject(refreshed);
        announce("You are on the newest revision.", "success");
      }
    } catch (error) {
      announce(error instanceof StudioApiError ? error.message : "The project could not be refreshed safely.", "error");
    }
  }
  refreshButton.addEventListener("click", () => refreshProject());

  saveButton.addEventListener("click", async () => {
    if (promotionPending) return;
    const latest = store.getState();
    const draft = latest.draft;
    if (!draft) return;
    if (latest.project.revision !== draft.expectedRevision) {
      store.clearDraft();
      announce("The project changed since this draft. The stale draft was discarded; refresh before editing.", "error");
      return;
    }
    const shapeIssues = planShapeIssues(draft.changes);
    if (shapeIssues.length) {
      announce(`Not saved. ${shapeIssues.map((issue) => issue.message).join(" ")} Every plan document must be a JSON object.`, "error");
      selectDocument(shapeIssues[0].key);
      setMode("edit");
      return;
    }
    if (!draftKeys.has(draft)) draftKeys.set(draft, crypto.randomUUID());
    promotionPending = true;
    savingDraft = draft;
    saveButton.disabled = true;
    discardButton.disabled = true;
    refreshDirty();
    announce("Saving the reviewed plan…");
    try {
      const result = await persistReviewedDraft(store, draft, () => updatePlan(
        latest.project.project_id,
        draft.changes,
        draft.expectedRevision,
        draftKeys.get(draft),
      ));
      if (result.outcome === "replacement-preserved") {
        announce("The plan was saved; a newer draft is still waiting for review.", "error");
      } else if (result.outcome === "project-changed") {
        announce("The plan was saved, but another project is open now.", "error");
      } else if (result.outcome === "promoted") {
        for (const key of PLAN_KEYS) controls[key].value = store.getState().workingPlan[key];
        if (!disposed && mode === "read") renderReader(activeKey);
        announce(`Plan saved as revision ${store.getState().project.revision}.`, "success");
      }
    } catch (error) {
      if (error instanceof StaleRevisionError) await refreshProject(true);
      else if (Number(error?.status) === 400) {
        announce(
          "The server checked the plan and rejected it. The four documents must follow the Comic Sol plan schema and agree with each other: storyboard characters and scenes must exist in the story and character bible, and the visual identity must match the character bible.",
          "error",
        );
      } else announce(error instanceof StudioApiError ? error.message : "The reviewed plan could not be saved safely.", "error");
    } finally {
      promotionPending = false;
      savingDraft = null;
      if (!disposed) {
        renderReview(store.getState());
        refreshDirty();
      }
    }
  });

  discardButton.addEventListener("click", () => {
    if (promotionPending) return;
    store.clearDraft();
    announce("Draft discarded. Your editor still holds the edits.");
  });

  function renderReview(state) {
    renderDiff(diff, state.workingPlan, state.draft);
    reviewPanel.dataset.state = state.draft ? (state.draft.origin === "agent" ? "agent" : "draft") : "idle";
    saveButton.disabled = promotionPending || !state.draft || !changedKeys(state.workingPlan, state.draft.changes).length;
    discardButton.disabled = promotionPending || !state.draft;
    reviewActions.hidden = !state.draft;
  }

  function renderBanner(state) {
    const planning = state.planning;
    banner.hidden = false;
    banner.dataset.tone = "info";
    if (planning?.state === "queued" || planning?.state === "running") {
      banner.dataset.tone = "working";
      replace(
        banner,
        h("span", { class: "scan", "aria-hidden": "true" }),
        h("strong", { text: "Your planner is drafting the plan. " }),
        `${[planning.provider, planning.model].filter(Boolean).join(" / ")}${planning.attempt_count ? `, attempt ${planning.attempt_count}` : ""}. This page updates on its own.`,
      );
    } else if (planning?.state === "ready_for_review") {
      banner.dataset.tone = "ready";
      replace(banner, h("strong", { text: "The drafted plan is in. " }), "Read it, adjust anything you like, then approve production.");
    } else if (planning?.state === "failed" || planning?.state === "cancelled") {
      banner.dataset.tone = "error";
      replace(
        banner,
        h("strong", { text: `Planning ${planning.state === "failed" ? "failed" : "was cancelled"}. ` }),
        planning.error_category ? `Reason: ${humanize(planning.error_category)}. ` : "",
        "You can still write the plan yourself.",
      );
    } else {
      banner.hidden = true;
    }
  }

  function renderApproval(state) {
    const ready = state.planning?.state === "ready_for_review";
    const hasOption = imageOptions.length > 0;
    approveButton.disabled = !ready || !hasOption || Boolean(state.workflow) || Boolean(state.draft);
    imageModel.disabled = !hasOption;
    if (state.workflow) {
      approvalHelp.textContent = `Production is ${stateLabel(state.workflow.state).toLowerCase()}. Follow it in Generate.`;
    } else if (!hasOption) {
      approvalHelp.textContent = "No image route can run in this Studio yet. Start Studio with an image provider key, then reload.";
    } else if (state.draft) {
      approvalHelp.textContent = "Save or discard the draft first, so production uses the plan you reviewed.";
    } else if (!ready) {
      approvalHelp.textContent = "Approval opens when a planner finishes a draft. Without a planner, queue images from Generate.";
    } else {
      approvalHelp.textContent = "Approving starts references, panels, QA, lettering, composition, and export in order. Image calls run on the provider account shown.";
    }
  }

  async function loadImageOptions() {
    try {
      const result = await getGenerationOptions();
      imageOptions = (Array.isArray(result.options) ? result.options : []).filter(
        (option) => Array.isArray(option.capabilities) && option.capabilities.includes("text_to_image"),
      );
    } catch {
      imageOptions = [];
    }
    if (disposed) return;
    imageModel.replaceChildren(...imageOptions.map((option) => {
      const auth = Array.isArray(option.auth_modes) && option.auth_modes.includes("hosted") ? "hosted" : option.auth_modes?.[0] || "hosted";
      return h("option", { value: `${option.provider}\u0000${option.model}\u0000${auth}`, text: `${option.provider} / ${option.model} (${auth})` });
    }));
    if (!imageOptions.length) imageModel.append(h("option", { value: "", text: "No image route available" }));
    renderApproval(store.getState());
  }

  approveButton.addEventListener("click", async () => {
    const latest = store.getState();
    if (latest.planning?.state !== "ready_for_review" || !imageModel.value) return;
    const [imageProvider, imageModelName, imageAuth] = imageModel.value.split("\u0000");
    approveButton.disabled = true;
    try {
      const result = await approveWorkflow(latest.project.project_id, latest.project.revision, {
        planning_job_id: latest.planning.job_id,
        image_provider: imageProvider,
        image_model: imageModelName,
        image_auth_mode: imageAuth,
      });
      store.setWorkflow(result.workflow);
      announce("Plan approved. Production started; follow it on the render board.", "success");
      navigate("generate");
    } catch (error) {
      announce(error.message || "Production could not be approved.", "error");
      if (!disposed) renderApproval(store.getState());
    }
  });

  async function pollPlanning() {
    pollTimer = null;
    const planning = store.getState().planning;
    if (disposed || !planning?.job_id || !["queued", "running"].includes(planning.state)) {
      polledJobId = null;
      return;
    }
    try {
      const { job } = await getPlanningJob(planning.job_id);
      if (disposed) return;
      store.replacePlanningJob(job, planning.requestEpoch || 0);
      if (job.state === "ready_for_review") {
        const published = await getProject(job.project_id);
        if (store.getState().project?.project_id === published.project_id) {
          store.replaceProject(published);
          announce("The planner finished. Your plan is ready to read.", "success");
          void refreshWorkflow();
        }
        polledJobId = null;
        return;
      }
      if (["failed", "cancelled"].includes(job.state)) {
        polledJobId = null;
        return;
      }
      pollTimer = setTimeout(pollPlanning, PLANNING_POLL_MS);
    } catch (error) {
      announce(error.message || "Planning status could not be read.", "error");
      polledJobId = null;
    }
  }

  const proposalHandler = (event) => {
    const proposal = safeProposal(event.detail);
    if (!proposal) {
      event.preventDefault();
      return;
    }
    if (proposal.expectedRevision !== store.getState().project.revision) {
      announce("The agent proposal is for an older revision and was not opened.", "error");
      event.preventDefault();
      return;
    }
    if (store.getState().draft) {
      announce("A draft is already waiting. Save or discard it before opening the agent proposal.", "error");
      event.preventDefault();
      return;
    }
    if (dirtyKeys().length) {
      announce("Review or discard your typed edits before opening an agent proposal.", "error");
      event.preventDefault();
      return;
    }
    store.createDraft(proposal.changes, "agent");
    announce("Your agent proposed plan changes. They are waiting in Draft review.");
  };
  if (activeProposalHandler) document.removeEventListener("comic-sol:plan-proposal", activeProposalHandler);
  activeProposalHandler = proposalHandler;
  document.addEventListener("comic-sol:plan-proposal", proposalHandler);

  function update(state) {
    project = state.project;
    statusFact.textContent = humanize(project.status);
    revisionFact.textContent = String(project.revision);

    if (state.workingPlan !== lastWorkingPlan) {
      // Untouched documents follow the saved plan; typed edits are never
      // overwritten by a refresh that happens underneath them.
      const conflicted = [];
      for (const key of PLAN_KEYS) {
        const value = controls[key].value;
        if (value === state.workingPlan[key]) continue;
        const untouched = lastWorkingPlan === null
          || value === lastWorkingPlan[key]
          || (savingDraft !== null && value === savingDraft.changes[key]);
        if (untouched) controls[key].value = state.workingPlan[key];
        else conflicted.push(key);
      }
      if (lastWorkingPlan === null) {
        const blank = PLAN_KEYS.every((key) => documentIsBlank(key, parseDocument(state.workingPlan[key])));
        const drafting = state.planning?.state === "queued" || state.planning?.state === "running";
        selectDocument(activeKey);
        setMode(blank && !drafting ? "edit" : "read", { focus: false });
      } else if (conflicted.length) {
        announce("The saved plan changed while you were editing. Your edits are kept; review them against the new version.", "error");
      }
      lastWorkingPlan = state.workingPlan;
      if (mode === "read") renderReader(activeKey);
      refreshJsonStatus(activeKey);
    }

    if (state.draft !== lastDraft) {
      lastDraft = state.draft;
      renderReview(state);
    }
    refreshDirty();
    renderBanner(state);
    renderApproval(state);

    const planning = state.planning;
    if (planning?.job_id && ["queued", "running"].includes(planning.state) && polledJobId !== planning.job_id) {
      polledJobId = planning.job_id;
      pollTimer = setTimeout(pollPlanning, PLANNING_POLL_MS);
    }
  }

  void loadImageOptions();

  return {
    element,
    supportsFocus: true,
    update,
    dispose() {
      disposed = true;
      clearTimeout(pollTimer);
      if (activeProposalHandler === proposalHandler) {
        document.removeEventListener("comic-sol:plan-proposal", proposalHandler);
        activeProposalHandler = null;
      }
    },
  };
}
