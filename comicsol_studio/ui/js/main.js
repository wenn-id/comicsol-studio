// Studio shell: owns the store, mounts one stage view at a time, and keeps the
// chrome (stage track, project slate, log) in step with project state.
//
// Views are mounted once per stage and project, then receive every state
// change through update(), so typing, focus, and scroll survive refreshes.

import * as api from "/static/api.js";
import { createStore } from "/static/state.js";
import { registerWebMcp } from "/static/webmcp.js";
import { createProductionLog } from "./log.js";
import { openCommandPalette, openShortcutSheet } from "./palette.js";
import { initTheme } from "./theme.js";
import { createToaster } from "./toast.js";
import { humanize, phaseLabel, plural } from "./format.js";
import { groupJobs } from "./jobs-model.js";
import { PLAN_KEYS, documentIsBlank, parseDocument } from "./plan-model.js";
import { mountStartView } from "./views/start.js";
import { mountPlanView } from "./views/plan.js";
import { mountGenerateView } from "./views/generate.js";
import { mountReviewView } from "./views/review.js";

const STAGES = Object.freeze(["start", "plan", "generate", "review"]);
const MOUNTERS = Object.freeze({
  start: mountStartView,
  plan: mountPlanView,
  generate: mountGenerateView,
  review: mountReviewView,
});

const store = createStore();
const announce = createToaster(document.getElementById("toasts"));
const stage = document.getElementById("stage");
const outlet = document.getElementById("stage-view");
const slate = document.getElementById("project-slate");
const steps = Array.from(document.querySelectorAll(".stage-step"));
const paletteButton = document.getElementById("palette-button");
const focusExit = document.getElementById("focus-exit");
const theme = initTheme(document.getElementById("theme-button"));
const log = createProductionLog(
  document.getElementById("production-log"),
  document.getElementById("log-button"),
);

let mounted = null;
// Views wait for the loopback session cookie before their first API call.
let markSessionReady;
const sessionReady = new Promise((resolve) => {
  markSessionReady = resolve;
});

function navigate(view, { focus = true } = {}) {
  store.setView(view);
  if (focus) stage.focus({ preventScroll: true });
}

function setFocusMode(on) {
  document.body.dataset.focus = on ? "true" : "false";
  focusExit.hidden = !on;
  if (on) announce("Focus mode on. Press Esc to bring the studio back.");
}

async function refreshWorkflow() {
  const project = store.getState().project;
  if (!project) return null;
  try {
    const result = await api.getWorkflow(project.project_id);
    store.setWorkflow(result.workflow);
    return result.workflow;
  } catch {
    return null;
  }
}

const context = Object.freeze({ store, api, announce, navigate, setFocusMode, refreshWorkflow, sessionReady });

function planReady(state) {
  if (state.planning?.state === "ready_for_review") return true;
  return PLAN_KEYS.some((key) => !documentIsBlank(key, parseDocument(state.workingPlan?.[key])));
}

// Each stage reports a short status and a tone. The tone drives the dot in
// the navigation: busy (work running), attention (needs the creator),
// done, bad (failed or blocked), or idle.
function status(text, tone = "idle") {
  return Object.freeze({ text, tone });
}

function stageStatuses(state) {
  const project = state.project;
  if (!project) {
    const locked = status("Needs a project");
    return { start: status("Write the pitch"), plan: locked, generate: locked, review: locked };
  }
  let plan = planReady(state) ? status("Plan on file", "done") : status("Edit the plan");
  if (state.draft) plan = status(state.draft.origin === "agent" ? "Agent draft waiting" : "Draft waiting", "attention");
  else if (state.planning?.state === "queued" || state.planning?.state === "running") plan = status("Planner drafting", "busy");
  else if (state.planning?.state === "ready_for_review") plan = status("Ready for review", "attention");
  else if (state.planning?.state === "failed") plan = status("Planning failed", "bad");

  const generation = state.generation;
  const loaded = generation.loadedRevision === project.revision;
  let generate = state.workflow ? status(phaseLabel(state.workflow.phase), "busy") : status("Open to check");
  if (loaded) {
    const lanes = groupJobs(generation.jobs, project.revision);
    if (lanes.attention.length) generate = status(`${plural(lanes.attention.length, "job")} need you`, "attention");
    else if (lanes.active.length) generate = status(`${lanes.active.length} rendering`, "busy");
    else if (generation.accepted) generate = status("Result accepted", "done");
    else if (!generation.jobs.length && !state.workflow) generate = status("No jobs yet");
    else if (!state.workflow) generate = status(`${plural(generation.jobs.length, "job")} on the board`);
  }
  if (state.workflow?.state === "blocked") generate = status("Workflow blocked", "bad");
  if (state.workflow?.state === "complete") generate = status("Production complete", "done");

  const qa = generation.qa || project.summary?.qa;
  let review = status("Not reviewed");
  if (qa) review = qa.valid ? status("QA passed", "done") : status("QA findings", "attention");
  else if (generation.accepted) review = status("Result ready", "attention");
  if (state.workflow?.state === "complete") review = status("PDF ready", "done");
  return { start: status("Project open", "done"), plan, generate, review };
}

function renderSlate(project) {
  if (!project) {
    slate.replaceChildren(Object.assign(document.createElement("span"), {
      className: "slate-empty",
      textContent: "No project open",
    }));
    document.title = "Comic Sol Studio";
    return;
  }
  const title = typeof project.summary?.title === "string" && project.summary.title
    ? project.summary.title
    : "Untitled comic";
  const name = document.createElement("span");
  name.className = "slate-title";
  name.textContent = title;
  const status = document.createElement("span");
  status.className = "slate-chip";
  status.textContent = humanize(project.status);
  const revision = document.createElement("span");
  revision.className = "slate-rev";
  revision.textContent = `rev ${project.revision}`;
  slate.replaceChildren(name, status, revision);
  document.title = `${title} · Comic Sol Studio`;
}

function renderChrome(state) {
  const statuses = stageStatuses(state);
  for (const step of steps) {
    const view = step.dataset.view;
    const current = view === state.view;
    if (current) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
    step.disabled = view !== "start" && !state.project;
    step.querySelector(".step-status").textContent = statuses[view].text;
    step.dataset.tone = statuses[view].tone;
    step.title = statuses[view].text;
  }
  renderSlate(state.project);
}

function sync(state) {
  const view = STAGES.includes(state.view) && (state.view === "start" || state.project) ? state.view : "start";
  // Start does not depend on the open project, so a restore never wipes a
  // pitch that is being typed.
  const projectId = view === "start" ? null : state.project?.project_id ?? null;
  if (!mounted || mounted.view !== view || mounted.projectId !== projectId) {
    mounted?.instance.dispose?.();
    const instance = MOUNTERS[view](context);
    outlet.replaceChildren(instance.element);
    outlet.dataset.view = view;
    outlet.classList.remove("stage-enter");
    void outlet.offsetWidth;
    outlet.classList.add("stage-enter");
    mounted = { view, projectId, instance };
    if (document.body.dataset.focus === "true" && !instance.supportsFocus) setFocusMode(false);
  }
  mounted.instance.update?.(state);
  renderChrome(state);
  log.sync(state);
}

for (const step of steps) {
  step.addEventListener("click", () => navigate(step.dataset.view));
}
document.querySelector(".stage-nav ol").addEventListener("keydown", (event) => {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  const enabled = steps.filter((step) => !step.disabled);
  const position = enabled.indexOf(document.activeElement);
  if (position < 0) return;
  let next = null;
  if (event.key === "ArrowRight") next = enabled[(position + 1) % enabled.length];
  if (event.key === "ArrowLeft") next = enabled[(position - 1 + enabled.length) % enabled.length];
  if (event.key === "Home") next = enabled[0];
  if (event.key === "End") next = enabled[enabled.length - 1];
  event.preventDefault();
  next?.focus();
});

function commands() {
  const state = store.getState();
  const hasProject = Boolean(state.project);
  const focusable = Boolean(mounted?.instance.supportsFocus);
  const go = (view, label, key) => ({
    label: `Go to ${label}`,
    keywords: `stage ${view} navigate`,
    shortcut: `Alt ${key}`,
    enabled: view === "start" || hasProject,
    reason: "Create or open a project first",
    run: () => navigate(view),
  });
  return [
    go("start", "Start", 1),
    go("plan", "Plan", 2),
    go("generate", "Generate", 3),
    go("review", "Review", 4),
    {
      label: document.body.dataset.focus === "true" ? "Leave focus mode" : "Enter focus mode",
      keywords: "writing distraction quiet zen",
      enabled: focusable || document.body.dataset.focus === "true",
      reason: "Available on Start and Plan",
      run: () => setFocusMode(document.body.dataset.focus !== "true"),
    },
    {
      label: theme.current() === "dark" ? "Switch to day shift (light theme)" : "Switch to night shift (dark theme)",
      keywords: "theme light dark color mode",
      enabled: true,
      run: () => theme.toggle(),
    },
    {
      label: log.isOpen() ? "Hide production log" : "Show production log",
      keywords: "events timeline activity workflow",
      enabled: true,
      run: () => log.toggle(),
    },
    {
      label: "Reload project from server",
      keywords: "refresh revision sync",
      enabled: hasProject,
      reason: "No project open",
      run: async () => {
        try {
          const project = await api.getProject(state.project.project_id);
          if (store.getState().project?.project_id !== project.project_id) return;
          if (project.revision !== store.getState().project.revision) store.clearDraft();
          store.replaceProject(project);
          await refreshWorkflow();
          announce(`Project reloaded at revision ${project.revision}.`, "success");
        } catch (error) {
          announce(error.message || "The project could not be reloaded.", "error");
        }
      },
    },
    {
      label: "Keyboard shortcuts",
      keywords: "help keys",
      shortcut: "?",
      enabled: true,
      run: () => openShortcutSheet(),
    },
  ];
}

paletteButton.addEventListener("click", () => openCommandPalette({ commands, trigger: paletteButton }));
focusExit.addEventListener("click", () => setFocusMode(false));

function typingTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandPalette({ commands, trigger: document.activeElement });
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-4]$/.test(event.code)) {
    const view = STAGES[Number(event.code.slice(-1)) - 1];
    if (view === "start" || store.getState().project) {
      event.preventDefault();
      navigate(view);
    }
    return;
  }
  if (event.key === "Escape" && document.body.dataset.focus === "true") {
    setFocusMode(false);
    return;
  }
  if (event.key === "?" && !typingTarget(event.target)) {
    event.preventDefault();
    openShortcutSheet({ trigger: document.activeElement });
  }
});

function validEnvelope(project) {
  return Boolean(project && typeof project.project_id === "string" && Number.isInteger(project.revision));
}

// WebMCP lifecycle results land in the same page-owned store.
document.addEventListener("comic-sol:project-selected", (event) => {
  const project = event.detail?.project;
  if (!validEnvelope(project)) return;
  store.setProject(project);
  event.detail.accepted = true;
  announce("Project opened. The plan is ready for review.", "success");
  void refreshWorkflow();
});
document.addEventListener("comic-sol:qa-completed", (event) => {
  const project = event.detail?.project;
  const current = store.getState().project;
  if (!validEnvelope(project) || current?.project_id !== project.project_id || current.revision !== project.revision) {
    return;
  }
  store.setQa(project);
  event.detail.accepted = true;
  announce("QA completed.", "success");
});
document.addEventListener("comic-sol:generation-refreshed", (event) => {
  const project = event.detail?.project;
  const current = store.getState().project;
  if (!validEnvelope(project) || current?.project_id !== project.project_id) return;
  store.replaceProjectAndGenerationJobs(
    project,
    Array.isArray(event.detail.jobs) ? event.detail.jobs : [],
    event.detail.acceptedJob ?? undefined,
  );
  event.detail.accepted = true;
  announce("Generation queued and refreshed.", "success");
});

store.subscribe(sync);
sync(store.getState());
void registerWebMcp();

// Reopen the session's current project unless the creator opened another one
// meanwhile. Someone already typing a new pitch stays on Start.
async function restoreProject() {
  const before = store.getState().project;
  const project = await api.getCurrentProject();
  const now = store.getState();
  if (!project || now.project !== before || now.project) return false;
  const composing = now.view === "start" && ["project-title", "project-source"].some(
    (id) => document.getElementById(id)?.value.trim(),
  );
  if (composing) store.replaceProject(project);
  else store.setProject(project);
  return true;
}

async function start() {
  try {
    await api.bootstrapLocalSession();
  } catch {
    // Hosted deployments do not expose the loopback-only session route.
  } finally {
    markSessionReady();
  }
  try {
    if (await restoreProject()) {
      announce("Welcome back. Your current project is open.", "success");
      await refreshWorkflow();
    }
  } catch (error) {
    if (Number(error?.status || 0) !== 404) {
      announce("Your saved project could not be restored safely.", "error");
    }
  }
}

void start();
