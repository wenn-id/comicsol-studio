// Create: a hero that shows the engine's real page layouts, a prompt composer
// docked to the bottom of the screen, and archive import by drop or picker.

import {
  MAX_ARCHIVE_BYTES,
  MigrationValidationError,
  StudioApiError,
  createProject,
  getPlanningOptions,
  importProject,
  queuePlanning,
} from "/static/api.js";
import { confirmDialog } from "../dialogs.js";
import { h, icon, replace } from "../dom.js";
import { MAX_SOURCE_BYTES, formatBytes, humanize, utf8Length } from "../format.js";
import { PAGE_HEIGHT, PAGE_WIDTH, parseDocument, storyboardPages } from "../plan-model.js";

const LANGUAGES = Object.freeze([
  ["en", "English"], ["id", "Indonesian"], ["ja", "Japanese"], ["ko", "Korean"],
  ["zh", "Chinese"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"],
]);
const MODES = Object.freeze([
  Object.freeze({
    id: "source-mode-prompt",
    value: "short_prompt",
    label: "Prompt",
    hint: "A few lines about the idea. The planner invents the details.",
    placeholder: "Describe the comic you imagine: who it is about, what they want, what stands in the way.",
  }),
  Object.freeze({
    id: "source-mode-story",
    value: "pasted_story",
    label: "Story",
    hint: "A finished story or script. The planner adapts it into pages.",
    placeholder: "Paste your story or script. The planner adapts it into pages.",
  }),
]);
const SELF_PLANNED = "self";

// The five page layouts the engine composes, as panel rectangles on its
// 1600 x 2400 page. The hero draws them so the first screen shows real output.
const LAYOUTS = Object.freeze([
  ["Two top, hero bottom", [[64, 64, 720, 1064], [816, 64, 720, 1064], [64, 1160, 1472, 1176]]],
  ["Three horizontal", [[64, 64, 1472, 736], [64, 832, 1472, 736], [64, 1600, 1472, 736]]],
  ["Full page", [[64, 64, 1472, 2272]]],
  ["Hero top, two bottom", [[64, 64, 1472, 1176], [64, 1272, 720, 1064], [816, 1272, 720, 1064]]],
  ["Two horizontal", [[64, 64, 1472, 1120], [64, 1216, 1472, 1120]]],
]);

// Retrying the same request reuses its idempotency key, so a flaky network
// never creates the same project twice.
export function retryOperation(previous, identity) {
  if (previous?.identity === identity) return previous;
  return Object.freeze({ identity, idempotencyKey: crypto.randomUUID() });
}

function failureMessage(error) {
  if (error instanceof MigrationValidationError || error instanceof StudioApiError) return error.message;
  return "The project request could not be completed safely.";
}

function pageSheet(rects, className = "page-thumb") {
  return h(
    "span",
    { class: className, "aria-hidden": "true" },
    rects.map(([x, y, width, height], index) => h("span", {
      class: `thumb-panel tone-${index % 3}`,
      style: {
        left: `${(x / PAGE_WIDTH) * 100}%`,
        top: `${(y / PAGE_HEIGHT) * 100}%`,
        width: `${(width / PAGE_WIDTH) * 100}%`,
        height: `${(height / PAGE_HEIGHT) * 100}%`,
      },
    })),
  );
}

function hero() {
  return h(
    "section",
    { class: "create-hero", "aria-labelledby": "create-heading" },
    h(
      "div",
      { class: "fan", "aria-hidden": "true" },
      LAYOUTS.map(([, rects], index) => h("span", { class: "fan-card", style: { "--i": String(index - 2) } }, pageSheet(rects))),
    ),
    h(
      "h1",
      { id: "create-heading", class: "display" },
      h("span", { text: "Turn a pitch" }),
      h("span", { class: "display-accent", text: "into comic pages" }),
    ),
    h("p", {
      class: "hero-lede",
      text: "Describe a story or paste one. Comic Sol plans the pages, renders the panels, letters them, and exports a PDF.",
    }),
  );
}

function chip(label, control, extraClass = "") {
  return h("label", { class: `chip ${extraClass}`.trim() }, h("span", { class: "chip-label", text: label }), control);
}

export function mountStartView(context) {
  const { store, announce, navigate, setFocusMode, sessionReady } = context;
  let retry = null;
  let importRetry = null;
  let mode = MODES[0];
  let resumeKey = null;

  // Composer controls
  const title = h("input", {
    id: "project-title",
    name: "title",
    type: "text",
    class: "composer-title",
    required: true,
    maxlength: "160",
    autocomplete: "off",
    placeholder: "Untitled comic",
    "aria-label": "Project title",
  });
  const source = h("textarea", {
    id: "project-source",
    name: "source",
    class: "composer-input",
    required: true,
    maxlength: String(MAX_SOURCE_BYTES),
    rows: "3",
    placeholder: mode.placeholder,
    "aria-label": "Prompt or story",
    "aria-describedby": "project-source-help project-source-meter",
  });
  const modeHint = h("p", { class: "visually-hidden", id: "project-source-help", text: mode.hint });
  const meter = h("span", { class: "meter", id: "project-source-meter" });

  function updateMeter() {
    const bytes = utf8Length(source.value.trim());
    meter.dataset.state = bytes > MAX_SOURCE_BYTES ? "over" : bytes > MAX_SOURCE_BYTES * 0.85 ? "near" : "ok";
    meter.textContent = `${formatBytes(bytes)} / ${formatBytes(MAX_SOURCE_BYTES)}`;
  }
  // The prompt grows with its text up to a comfortable height, then scrolls.
  function autosize() {
    source.style.height = "auto";
    source.style.height = `${Math.min(source.scrollHeight, 320)}px`;
  }
  source.addEventListener("input", () => {
    updateMeter();
    autosize();
  });
  updateMeter();

  const modeGroup = h("fieldset", { class: "segmented segmented-compact" }, h("legend", { class: "visually-hidden", text: "Source format" }));
  for (const option of MODES) {
    const input = h("input", {
      id: option.id,
      type: "radio",
      name: "source_mode",
      value: option.value,
      class: "visually-hidden",
      checked: option === mode,
    });
    input.addEventListener("change", () => {
      mode = option;
      modeHint.textContent = option.hint;
      source.placeholder = option.placeholder;
    });
    modeGroup.append(input, h("label", { for: option.id, text: option.label }));
  }

  const pageCount = h(
    "select",
    { id: "project-page-count", name: "page_count", required: true },
    [1, 2, 3, 4].map((count) => h("option", { value: String(count), selected: count === 2, text: `${count} page${count === 1 ? "" : "s"}` })),
  );
  const language = h("input", {
    id: "project-language",
    name: "language",
    type: "text",
    value: "en",
    required: true,
    maxlength: "16",
    size: "4",
    list: "project-language-options",
    autocomplete: "off",
    spellcheck: "false",
  });
  const languages = h(
    "datalist",
    { id: "project-language-options" },
    LANGUAGES.map(([code, name]) => h("option", { value: code, text: name })),
  );
  const planner = h("select", { id: "project-planner", name: "planner", "aria-describedby": "project-planner-help" });
  const plannerHelp = h("p", { class: "composer-help", id: "project-planner-help", text: "Loading planners…" });

  async function loadPlanners() {
    let options = [];
    await sessionReady;
    try {
      options = (await getPlanningOptions()).options;
    } catch {
      options = [];
    }
    const self = h("option", { value: SELF_PLANNED, text: "Write it myself" });
    const providers = [...new Set(options.map((option) => option.provider))];
    const groups = providers.map((provider) => h(
      "optgroup",
      { label: provider },
      options.filter((option) => option.provider === provider).map((option) => {
        const missing = !option.enabled && option.required_environment_variable;
        return h("option", {
          value: `${option.provider}\u0000${option.model}`,
          disabled: !option.enabled,
          text: missing ? `${option.model} (needs ${option.required_environment_variable})` : option.model,
        });
      }),
    ));
    planner.replaceChildren(self, ...groups);
    const firstEnabled = options.find((option) => option.enabled);
    planner.value = firstEnabled ? `${firstEnabled.provider}\u0000${firstEnabled.model}` : SELF_PLANNED;
    plannerHelp.textContent = firstEnabled
      ? "The planner drafts all four plan documents on your provider account. Keys stay on the machine running Studio."
      : "No planner key found, so you will write the plan yourself. Set OPENAI_API_KEY or ANTHROPIC_API_KEY and restart Studio to enable one.";
  }
  void loadPlanners();

  // Archive import: the picker and drag-and-drop both land in one file input,
  // which the WebMCP import tool also reads.
  const archive = h("input", {
    id: "project-archive",
    name: "archive",
    type: "file",
    accept: ".comic-sol-handoff",
    class: "visually-hidden",
  });
  const archiveChip = h("span", { class: "file-chip", hidden: true });
  const importLabel = h(
    "label",
    { for: "project-archive", class: "chip chip-icon", title: "Import a .comic-sol-handoff archive" },
    icon("upload"),
    h("span", { class: "visually-hidden", text: "Import a .comic-sol-handoff archive" }),
  );

  function confirmImport(trigger) {
    const file = archive.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".comic-sol-handoff")) {
      announce("Choose a .comic-sol-handoff archive.", "error");
      return;
    }
    if (file.size > MAX_ARCHIVE_BYTES) {
      announce("The archive is larger than the import limit.", "error");
      return;
    }
    confirmDialog({
      title: "Import this archive?",
      body: [
        `${file.name} · ${formatBytes(file.size)}`,
        "Studio validates and migrates it on the server. Your original file is never changed.",
      ],
      confirmText: "Validate and import",
      trigger,
      onConfirm: async (close) => {
        announce("Validating and importing the archive…");
        try {
          importRetry = retryOperation(importRetry, file);
          const project = await importProject(file, importRetry.idempotencyKey);
          close();
          store.setProject(project);
          announce("Archive imported. Read the plan before you continue.", "success");
          navigate("plan");
        } catch (error) {
          announce(failureMessage(error), "error");
        }
      },
    });
  }

  function describeArchive() {
    const file = archive.files?.[0];
    archiveChip.hidden = !file;
    if (!file) return;
    replace(
      archiveChip,
      h("span", { class: "file-name", text: file.name }),
      h("button", { type: "button", class: "file-action", on: { click: (event) => confirmImport(event.currentTarget) } }, "Import"),
    );
  }
  archive.addEventListener("change", () => {
    describeArchive();
    confirmImport(importLabel);
  });

  const submit = h(
    "button",
    { type: "submit", class: "button-generate", title: "Create project (Ctrl Enter)", "aria-keyshortcuts": "Control+Enter" },
    h("span", { class: "generate-label", text: "Create" }),
    icon("play"),
  );

  const form = h(
    "form",
    { id: "create-project-form", class: "composer" },
    h(
      "div",
      { class: "composer-head" },
      title,
      modeGroup,
      h(
        "button",
        { type: "button", class: "icon-button", title: "Focus mode", "aria-label": "Focus mode", on: { click: () => setFocusMode(document.body.dataset.focus !== "true") } },
        icon("focus"),
      ),
    ),
    source,
    modeHint,
    h(
      "div",
      { class: "composer-bar" },
      importLabel,
      archive,
      archiveChip,
      chip("Pages", pageCount),
      chip("Language", language),
      languages,
      chip("Planner", planner, "chip-wide"),
      h("span", { class: "composer-spacer" }),
      meter,
      submit,
    ),
    plannerHelp,
  );

  function setBusy(busy) {
    for (const control of form.elements) control.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    submit.querySelector(".generate-label").textContent = busy ? "Creating…" : "Create";
  }

  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const sourceValue = source.value.trim();
    if (new TextEncoder().encode(sourceValue).byteLength > MAX_SOURCE_BYTES) {
      announce("The prompt or story must be at most 200 KB of UTF-8 text.", "error");
      source.focus();
      return;
    }
    const request = {
      title: title.value.trim(),
      prompt: sourceValue,
      language: language.value.trim(),
      mode: form.elements.source_mode.value,
      page_count: Number(pageCount.value),
    };
    const plannerChoice = planner.value;
    setBusy(true);
    announce("Creating your project…");
    try {
      retry = retryOperation(retry, JSON.stringify(request));
      const project = await createProject(request, retry.idempotencyKey);
      store.setProject(project);
      let outcome = "Write the four plan documents, then review your changes.";
      if (plannerChoice && plannerChoice !== SELF_PLANNED) {
        const [provider, model] = plannerChoice.split("\u0000");
        try {
          const planned = await queuePlanning(project.project_id, project.revision, { provider, model });
          store.setPlanningJob(planned.job);
          outcome = "The planner is drafting your plan. The Plan stage updates on its own.";
        } catch {
          outcome = "The planner could not be queued. You can still write the plan yourself.";
        }
      }
      announce(`Project created. ${outcome}`, "success");
      navigate("plan");
    } catch (error) {
      announce(failureMessage(error), "error");
    } finally {
      if (form.isConnected) setBusy(false);
    }
  });

  // Continue card for the project that is already open.
  const resume = h("section", { class: "resume-card", hidden: true, "aria-label": "Continue your project" });

  function renderResume(project, workingPlan) {
    const parsed = parseDocument(workingPlan?.storyboard);
    const pages = parsed.state === "valid" ? storyboardPages(parsed.value) : [];
    const first = pages[0];
    const rects = first
      ? first.panels.filter((panel) => panel.box).map((panel) => [
        (panel.box.left / 100) * PAGE_WIDTH,
        (panel.box.top / 100) * PAGE_HEIGHT,
        (panel.box.width / 100) * PAGE_WIDTH,
        (panel.box.height / 100) * PAGE_HEIGHT,
      ])
      : [];
    const projectTitle = typeof project.summary?.title === "string" && project.summary.title ? project.summary.title : "Untitled comic";
    replace(
      resume,
      h("div", { class: "resume-thumbs" }, pageSheet(rects, "page-thumb resume-thumb")),
      h(
        "div",
        { class: "resume-body" },
        h("p", { class: "eyebrow", text: "Continue where you left off" }),
        h("h2", { text: projectTitle }),
        h("p", { class: "resume-meta", text: `${humanize(project.status)} · revision ${project.revision}${pages.length ? ` · ${pages.length} page${pages.length === 1 ? "" : "s"} planned` : ""}` }),
      ),
      h("button", { type: "button", class: "button", on: { click: () => navigate("plan") } }, "Open the plan"),
    );
  }

  const dropOverlay = h(
    "div",
    { class: "drop-overlay", "aria-hidden": "true" },
    icon("upload"),
    h("p", { text: "Drop the .comic-sol-handoff archive to import it" }),
  );

  const element = h(
    "div",
    { class: "view view-start" },
    resume,
    hero(),
    h("div", { class: "composer-dock" }, form),
    dropOverlay,
  );

  // Dropping a file anywhere on Create imports it.
  let dragDepth = 0;
  element.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    dragDepth += 1;
    element.dataset.drop = "true";
  });
  element.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  element.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) element.dataset.drop = "false";
  });
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    element.dataset.drop = "false";
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    archive.files = files;
    describeArchive();
    confirmImport(importLabel);
  });

  return {
    element,
    supportsFocus: true,
    update(state) {
      const project = state.project;
      resume.hidden = !project;
      if (!project) return;
      const key = `${project.project_id}:${project.revision}`;
      if (key === resumeKey) return;
      resumeKey = key;
      renderResume(project, state.workingPlan);
    },
    dispose() {},
  };
}
