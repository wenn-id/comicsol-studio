// Start: write the pitch, pick the page count and planner, or open an archive.

import {
  MAX_ARCHIVE_BYTES,
  MigrationValidationError,
  StudioApiError,
  createProject,
  getPlanningOptions,
  importProject,
  queuePlanning,
} from "/static/api.js";
import { h, icon, replace, uid } from "../dom.js";
import { MAX_SOURCE_BYTES, formatBytes, utf8Length } from "../format.js";

const LANGUAGES = Object.freeze([
  ["en", "English"], ["id", "Indonesian"], ["ja", "Japanese"], ["ko", "Korean"],
  ["zh", "Chinese"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"],
]);
const MODES = Object.freeze([
  Object.freeze({
    value: "short_prompt",
    label: "Short prompt",
    hint: "A few lines about the idea. The planner invents the details.",
    placeholder: "Who is it about, what do they want, and what stands in the way?",
  }),
  Object.freeze({
    value: "pasted_story",
    label: "Full story",
    hint: "Paste a finished story or script. The planner adapts it into pages.",
    placeholder: "Paste your story or script here.",
  }),
]);
const SELF_PLANNED = "self";

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

function pagePicker() {
  const group = h("fieldset", { class: "page-picker" }, h("legend", { text: "Pages" }));
  const row = h("div", { class: "page-options" });
  for (let count = 1; count <= 4; count += 1) {
    const id = uid("pages");
    const input = h("input", {
      id,
      type: "radio",
      name: "page_count",
      value: String(count),
      class: "visually-hidden",
      checked: count === 2,
      required: true,
    });
    const sheets = h("span", { class: "page-sheets", "aria-hidden": "true" });
    for (let sheet = 0; sheet < count; sheet += 1) sheets.append(h("span", { class: "page-sheet" }));
    row.append(input, h("label", { for: id, class: "page-option" }, sheets, h("span", { text: `${count}` })));
  }
  group.append(row, h("p", { class: "field-help", text: "Comic Sol plans one to four pages per project." }));
  return group;
}

function composer(context) {
  const { store, announce, navigate, setFocusMode, sessionReady } = context;
  let retry = null;
  let mode = MODES[0];

  const title = h("input", {
    id: "project-title",
    name: "title",
    type: "text",
    class: "title-input",
    required: true,
    maxlength: "160",
    autocomplete: "off",
    placeholder: "Name your comic",
  });
  const source = h("textarea", {
    id: "project-source",
    name: "source",
    required: true,
    maxlength: String(MAX_SOURCE_BYTES),
    rows: "9",
    placeholder: mode.placeholder,
    "aria-describedby": "project-source-help project-source-meter",
  });
  const modeHint = h("p", { class: "field-help", id: "project-source-help", text: mode.hint });
  const meterFill = h("span", { class: "meter-fill" });
  const meterText = h("span", { class: "meter-text" });
  const meter = h(
    "div",
    { class: "meter", id: "project-source-meter" },
    h("span", { class: "meter-track", "aria-hidden": "true" }, meterFill),
    meterText,
  );

  function updateMeter() {
    const bytes = utf8Length(source.value.trim());
    const ratio = Math.min(1, bytes / MAX_SOURCE_BYTES);
    meterFill.style.setProperty("--ratio", String(ratio));
    meter.dataset.state = bytes > MAX_SOURCE_BYTES ? "over" : ratio > 0.85 ? "near" : "ok";
    meterText.textContent = `${formatBytes(bytes)} of ${formatBytes(MAX_SOURCE_BYTES)}`;
  }
  source.addEventListener("input", updateMeter);
  updateMeter();

  const modeGroup = h("fieldset", { class: "segmented" }, h("legend", { class: "visually-hidden", text: "Source format" }));
  for (const option of MODES) {
    const id = option.value === "short_prompt" ? "source-mode-prompt" : "source-mode-story";
    const input = h("input", {
      id,
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
    modeGroup.append(input, h("label", { for: id, text: option.label }));
  }

  const language = h("input", {
    id: "project-language",
    name: "language",
    type: "text",
    value: "en",
    required: true,
    maxlength: "16",
    list: "project-language-options",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "project-language-help",
  });
  const languages = h(
    "datalist",
    { id: "project-language-options" },
    LANGUAGES.map(([code, name]) => h("option", { value: code, text: name })),
  );

  const planner = h("select", { id: "project-planner", name: "planner", "aria-describedby": "project-planner-help" });
  const plannerHelp = h("p", { class: "field-help", id: "project-planner-help", text: "Loading planners…" });

  async function loadPlanners() {
    let options = [];
    await sessionReady;
    try {
      options = (await getPlanningOptions()).options;
    } catch {
      options = [];
    }
    const self = h("option", { value: SELF_PLANNED, text: "Write the plan myself (no planner call)" });
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
      ? "The planner drafts all four plan documents. It runs on your provider account."
      : "No planner key was found in the environment that launched Studio, so you will write the plan yourself. Set OPENAI_API_KEY or ANTHROPIC_API_KEY and restart to enable one.";
  }
  void loadPlanners();

  const submit = h("button", { type: "submit", class: "button button-primary button-large" }, "Create comic project");
  const focusButton = h(
    "button",
    { type: "button", class: "button button-quiet", on: { click: () => setFocusMode(document.body.dataset.focus !== "true") } },
    icon("focus"),
    "Focus",
  );

  const form = h(
    "form",
    { id: "create-project-form", class: "composer", novalidate: false },
    h(
      "div",
      { class: "field" },
      h("label", { for: "project-title", class: "visually-hidden", text: "Project title" }),
      title,
    ),
    modeGroup,
    h(
      "div",
      { class: "field field-source" },
      h("label", { for: "project-source", text: "Prompt or story" }),
      source,
      h("div", { class: "source-foot" }, modeHint, meter),
    ),
    h(
      "div",
      { class: "composer-grid" },
      pagePicker(),
      h(
        "div",
        { class: "field" },
        h("label", { for: "project-language", text: "Language code" }),
        language,
        languages,
        h("p", { class: "field-help", id: "project-language-help", text: "Lettering language, for example en, id, or ja." }),
      ),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "project-planner", text: "Planner" }),
      planner,
      plannerHelp,
    ),
    h(
      "div",
      { class: "composer-actions" },
      submit,
      h("p", { class: "hint" }, h("kbd", { text: "Ctrl Enter" }), " creates the project"),
      focusButton,
    ),
  );

  function setBusy(busy) {
    for (const control of form.elements) control.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    submit.textContent = busy ? "Creating…" : "Create comic project";
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
      page_count: Number(form.elements.page_count.value),
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
          outcome = "The planner is drafting your plan. This stage updates on its own.";
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

  return h(
    "section",
    { class: "panel panel-marked start-composer", "aria-labelledby": "compose-heading" },
    h(
      "header",
      { class: "panel-head" },
      h("p", { class: "eyebrow", text: "01 / Start" }),
      h("h1", { id: "compose-heading", text: "Write the pitch" }),
    ),
    form,
  );
}

function archivePanel({ store, announce, navigate }) {
  let retry = null;
  const archive = h("input", {
    id: "project-archive",
    name: "archive",
    type: "file",
    accept: ".comic-sol-handoff",
    required: true,
    class: "visually-hidden",
    "aria-describedby": "project-archive-help",
  });
  const fileLine = h("span", { class: "drop-file", text: "No archive chosen" });
  const drop = h(
    "label",
    { for: "project-archive", class: "dropzone" },
    icon("upload"),
    h("span", { class: "drop-title", text: "Drop a .comic-sol-handoff archive" }),
    h("span", { class: "drop-sub", text: "or click to choose one" }),
    fileLine,
  );
  const submit = h("button", { type: "submit", class: "button", disabled: true }, "Validate and import");

  function describe() {
    const file = archive.files?.[0];
    fileLine.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "No archive chosen";
    drop.dataset.filled = file ? "true" : "false";
    submit.disabled = !file;
  }
  archive.addEventListener("change", describe);
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.dataset.over = "true";
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, () => {
      drop.dataset.over = "false";
    });
  }
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    archive.files = files;
    describe();
  });

  const form = h(
    "form",
    { id: "import-project-form", class: "import-form" },
    archive,
    drop,
    h("p", {
      class: "field-help",
      id: "project-archive-help",
      text: "One portable archive at a time. Studio validates and migrates it on the server and never changes your original file.",
    }),
    h("div", { class: "actions" }, submit),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = archive.files?.[0];
    if (!file || !file.name.endsWith(".comic-sol-handoff")) {
      announce("Choose a .comic-sol-handoff archive.", "error");
      archive.focus();
      return;
    }
    if (file.size > MAX_ARCHIVE_BYTES) {
      announce("The archive is larger than the import limit.", "error");
      archive.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Validating…";
    announce("Validating and importing the archive…");
    try {
      retry = retryOperation(retry, file);
      const project = await importProject(file, retry.idempotencyKey);
      store.setProject(project);
      announce("Archive imported. Read the plan before you continue.", "success");
      navigate("plan");
    } catch (error) {
      announce(failureMessage(error), "error");
    } finally {
      if (form.isConnected) {
        submit.disabled = !archive.files?.length;
        submit.textContent = "Validate and import";
      }
    }
  });

  return h(
    "section",
    { class: "panel start-archive", "aria-labelledby": "archive-heading" },
    h(
      "header",
      { class: "panel-head" },
      h("p", { class: "eyebrow", text: "Or continue" }),
      h("h2", { id: "archive-heading", text: "Open an archive" }),
    ),
    form,
  );
}

function privacyNote() {
  return h(
    "section",
    { class: "panel panel-quiet start-note", "aria-labelledby": "note-heading" },
    h("h2", { id: "note-heading", class: "note-title", text: "Where your story goes" }),
    h(
      "ul",
      { class: "note-list" },
      h("li", { text: "Your text goes only to this Studio's project API and, if you pick one, the planner provider." }),
      h("li", { text: "Provider keys stay in the environment that launched Studio. This page never sees them." }),
      h("li", { text: "Nothing is published. Exports are private downloads." }),
    ),
  );
}

export function mountStartView(context) {
  // When a project is already open, say so before the creator starts a new one.
  const resume = h("div", { class: "resume-strip", hidden: true });
  const element = h(
    "div",
    { class: "view view-start" },
    resume,
    composer(context),
    h("div", { class: "start-side" }, archivePanel(context), privacyNote()),
  );
  let shownFor = null;
  return {
    element,
    supportsFocus: true,
    update(state) {
      const project = state.project;
      resume.hidden = !project;
      if (!project || shownFor === `${project.project_id}:${project.revision}`) return;
      shownFor = `${project.project_id}:${project.revision}`;
      const title = typeof project.summary?.title === "string" && project.summary.title ? project.summary.title : "Untitled comic";
      replace(
        resume,
        h("p", {}, "You are working on ", h("strong", { text: title }), ". Creating a new project switches to the new one."),
        h("button", { type: "button", class: "button", on: { click: () => context.navigate("plan") } }, "Continue in Plan"),
      );
    },
    dispose() {},
  };
}
