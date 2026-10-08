// Console entry: routing, the project being worked on, background-run polling, theme,
// the activity drawer, keyboard shortcuts, and the command palette.

import { api, loadSession } from "./api.js";
import { h, icon, mount } from "./dom.js";
import { STAGES, activeRuns, providerName, stageStates, statusLabel } from "./model.js";
import { dialog, errorState, loadingState, toast, toastError } from "./ui.js";
import { renderActivity } from "./views/activity.js";
import { renderFinish } from "./views/finish.js";
import { renderLibrary, resetLibrary } from "./views/library.js";
import { renderOverview } from "./views/overview.js";
import { renderPlan } from "./views/plan.js";
import { renderRender } from "./views/render.js";
import { renderReview } from "./views/review.js";

const BASE = "/studio";
const VIEWS = { overview: renderOverview, plan: renderPlan, render: renderRender, review: renderReview, finish: renderFinish };
const THEME_KEY = "comicsol-studio-theme";

const rail = document.querySelector("[data-rail]");
const view = document.querySelector("[data-view]");
const drawer = document.querySelector("[data-drawer]");

const state = {
  session: null,
  route: { name: "library" },
  projectId: null,
  project: null,
  loading: false,
  error: null,
  seenRuns: new Map(),
  pollTimer: null,
};

// Routing ---------------------------------------------------------------------------

export function parseRoute(pathname, search = "") {
  const path = pathname.replace(/\/+$/, "");
  if (path === BASE || path === "") return { name: "library", compose: false };
  if (path === `${BASE}/new`) return { name: "library", compose: true };
  const match = /^\/studio\/p\/([a-f0-9]{24})(?:\/(plan|render|review|finish))?$/.exec(path);
  if (match) {
    const params = new URLSearchParams(search);
    return { name: "project", id: match[1], stage: match[2] || "overview", panel: params.get("panel"), page: params.get("page") };
  }
  return { name: "missing" };
}

export function projectPath(id, stage = "overview", query = "") {
  return `${BASE}/p/${id}${stage === "overview" ? "" : `/${stage}`}${query}`;
}

function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  route();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", () => route());

// Project state ---------------------------------------------------------------------

function setProject(project) {
  if (!project || project.id !== state.projectId) return;
  const previous = state.project;
  // A slow poll can answer after an action already returned a newer revision; keep the newer.
  if (previous && previous.id === project.id && project.revision < previous.revision) return;
  state.project = project;
  state.error = null;
  let finishedRun = false;
  for (const run of project.runs || []) {
    const before = state.seenRuns.get(run.id);
    if (before && before !== run.status && (run.status === "succeeded" || run.status === "failed")) {
      announceRun(run);
      finishedRun = true;
    }
    state.seenRuns.set(run.id, run.status);
  }
  schedulePoll();
  const sameFiles = previous && previous.id === project.id && previous.revision === project.revision;
  if (sameFiles && !finishedRun && userIsWorking()) {
    // Only run progress changed while the creator is typing or waiting on a button:
    // refresh the rail and leave the form alone.
    renderRail();
    return;
  }
  render();
}

function userIsWorking() {
  const active = document.activeElement;
  const typing = active && view.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  return Boolean(typing || view.querySelector('[aria-busy="true"]'));
}

// Re-rendering replaces the DOM; put focus (and the caret) back where the creator was.
function focusKey(element) {
  if (!element || !view.contains(element)) return null;
  const key = element.id ? `#${CSS.escape(element.id)}` : element.dataset.path ? `[data-path="${CSS.escape(element.dataset.path)}"]` : element.getAttribute("aria-label") ? `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(element.getAttribute("aria-label"))}"]` : null;
  if (!key) return null;
  return { key, start: element.selectionStart, end: element.selectionEnd };
}

function restoreFocus(saved) {
  if (!saved) return;
  const element = view.querySelector(saved.key);
  if (!element) return;
  element.focus({ preventScroll: true });
  if (typeof saved.start === "number" && element.setSelectionRange) {
    try {
      element.setSelectionRange(saved.start, saved.end);
    } catch {
      // Some input types do not support a selection.
    }
  }
}

function announceRun(run) {
  const what = {
    "plan-draft": "Plan draft",
    render: "Render",
    "render-batch": "Rendering",
    "panel-review": `Review of ${run.subject}`,
    "page-review": `Review of page ${run.subject}`,
  }[run.kind] || "Background work";
  if (run.status === "succeeded") toast(`${what} with ${providerName(run.provider)} finished.`, { tone: "success" });
  else toast(`${what} with ${providerName(run.provider)} failed.`, { tone: "error", detail: run.message });
}

async function loadProject(id, { quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    render();
  }
  try {
    const project = await api.project(id);
    if (id !== state.projectId) return;
    state.loading = false;
    for (const run of project.runs || []) if (!state.seenRuns.has(run.id)) state.seenRuns.set(run.id, run.status);
    setProject(project);
  } catch (error) {
    if (id !== state.projectId) return;
    state.loading = false;
    state.error = error;
    render();
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.project || !activeRuns(state.project).length) return;
  state.pollTimer = setTimeout(() => {
    if (state.projectId && !document.hidden) loadProject(state.projectId, { quiet: true });
    else schedulePoll();
  }, 1500);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.projectId) loadProject(state.projectId, { quiet: true });
});

// Run an action that returns a new snapshot; a stale revision reloads instead of losing work.
async function act(action, { success } = {}) {
  try {
    const result = await action();
    if (result && result.id === state.projectId && result.revision) setProject(result);
    if (success) toast(success, { tone: "success" });
    return result;
  } catch (error) {
    if (error.stale) {
      toast("This project changed in another window or by an agent.", { tone: "info", detail: "Studio reloaded the latest version. Check it, then try again." });
      await loadProject(state.projectId, { quiet: true });
    } else {
      toastError(error);
    }
    throw error;
  }
}

// Views keep this object in closures, so it always reads the live state rather than a copy.
function context() {
  return {
    get session() {
      return state.session;
    },
    get project() {
      return state.project;
    },
    get route() {
      return state.route;
    },
    navigate,
    projectPath,
    refresh: () => loadProject(state.projectId, { quiet: true }),
    setProject,
    act,
  };
}

// Rendering -------------------------------------------------------------------------

function renderRail() {
  const project = state.project && state.route.name === "project" ? state.project : null;
  const states = project ? stageStates(project) : null;
  const theme = document.documentElement.dataset.theme;
  mount(
    rail,
    h(
      "div",
      { class: "rail__top" },
      h("a", { class: "brand", href: "/", "aria-label": "Comic Sol Studio home" }, h("img", { src: "/assets/img/mark.svg", alt: "", width: 26, height: 26 }), h("span", { class: "brand__name" }, "Comic Sol"), h("span", { class: "brand__sub" }, "Studio")),
      h(
        "nav",
        { class: "rail__nav", "aria-label": "Library" },
        h("a", { href: `${BASE}/`, "data-link": true, class: "rail__link", "aria-label": "Library", "aria-current": state.route.name === "library" ? "page" : null }, icon("library"), h("span", {}, "Library")),
      ),
      project
        ? h(
            "div",
            { class: "rail__project" },
            h("p", { class: "rail__project-title", title: project.title }, project.title),
            h("p", { class: "rail__project-status" }, statusLabel(project.status)),
            h(
              "nav",
              { class: "rail__stages", "aria-label": "Project stages" },
              STAGES.map((stage) =>
                h(
                  "a",
                  {
                    href: projectPath(project.id, stage.id),
                    "data-link": true,
                    class: `rail__link rail__link--${states[stage.id]}`,
                    "aria-current": state.route.stage === stage.id ? "page" : null,
                  },
                  icon(stage.icon),
                  h("span", {}, stage.label),
                  h("span", { class: "rail__dot", "aria-label": { done: "done", current: "next", waiting: "waiting", locked: "locked" }[states[stage.id]] }),
                ),
              ),
            ),
          )
        : null,
    ),
    h(
      "div",
      { class: "rail__bottom" },
      project ? h("button", { type: "button", class: "rail__link", onclick: toggleDrawer, "aria-label": "Activity", "aria-expanded": String(!drawer.hidden) }, icon("activity"), h("span", {}, "Activity")) : null,
      h("button", { type: "button", class: "rail__link", onclick: toggleTheme, "aria-label": `Switch to ${theme === "day" ? "night" : "day"} theme` }, icon(theme === "day" ? "moon" : "sun"), h("span", {}, theme === "day" ? "Night" : "Day")),
      h("button", { type: "button", class: "rail__link", onclick: openPalette, "aria-label": "Commands" }, icon("search"), h("span", {}, "Commands"), h("kbd", {}, "Ctrl K")),
      state.session ? h("p", { class: "rail__engine" }, `Comic Sol engine ${state.session.engine.version}`) : null,
    ),
  );
}

function render() {
  renderRail();
  const route = state.route;
  if (route.name === "library") {
    document.title = "Library · Comic Sol Studio";
    renderLibrary(view, Object.assign(context(), { compose: route.compose }));
    return;
  }
  if (route.name === "missing") {
    document.title = "Not found · Comic Sol Studio";
    mount(view, h("div", { class: "page" }, errorState({ message: "This page does not exist in Studio.", hint: "Go back to your library." }), h("a", { href: `${BASE}/`, "data-link": true, class: "btn btn--ghost" }, "Open the library")));
    return;
  }
  if (state.error && (!state.project || state.project.id !== route.id)) {
    mount(view, h("div", { class: "page" }, errorState(state.error, () => loadProject(route.id)), h("a", { href: `${BASE}/`, "data-link": true, class: "btn btn--ghost" }, "Back to the library")));
    return;
  }
  if (!state.project || state.project.id !== route.id) {
    mount(view, h("div", { class: "page" }, loadingState("Opening the project")));
    return;
  }
  document.title = `${state.project.title} · Comic Sol Studio`;
  const saved = focusKey(document.activeElement);
  VIEWS[route.stage](view, context());
  restoreFocus(saved);
  if (!drawer.hidden) renderActivity(drawer, context(), toggleDrawer);
}

let lastViewKey = "";
function route() {
  state.route = parseRoute(location.pathname, location.search);
  const key = `${state.route.name}:${state.route.id || ""}:${state.route.stage || ""}`;
  if (state.route.name === "project") {
    if (state.projectId !== state.route.id) {
      state.projectId = state.route.id;
      state.project = null;
      state.error = null;
      loadProject(state.route.id);
    }
  } else {
    if (key !== lastViewKey) resetLibrary();
    state.projectId = null;
    state.project = null;
    clearTimeout(state.pollTimer);
    if (!drawer.hidden) toggleDrawer();
  }
  render();
  if (key !== lastViewKey) {
    lastViewKey = key;
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });
  }
}

// Theme, drawer, palette ------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "day" ? "#f3eee3" : "#08090b";
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage can be unavailable (private windows); the theme still applies for this visit.
  }
  renderRail();
}

function toggleDrawer() {
  drawer.hidden = !drawer.hidden;
  document.body.classList.toggle("has-drawer", !drawer.hidden);
  if (!drawer.hidden && state.project) {
    renderActivity(drawer, context(), toggleDrawer);
    drawer.querySelector("button")?.focus();
  }
  renderRail();
}

function commands() {
  const list = [
    { label: "Open the library", run: () => navigate(`${BASE}/`) },
    { label: "Start a new comic", run: () => navigate(`${BASE}/new`) },
    { label: "Switch theme", run: toggleTheme },
    { label: "Open the landing page", run: () => (location.href = "/") },
  ];
  if (state.project) {
    for (const stage of STAGES) list.push({ label: `Go to ${stage.label}`, hint: state.project.title, run: () => navigate(projectPath(state.project.id, stage.id)) });
    list.push({ label: "Show activity", run: () => drawer.hidden && toggleDrawer() });
  }
  return list;
}

function openPalette() {
  const all = commands();
  const input = h("input", { class: "input palette__input", type: "search", placeholder: "Type a command", "aria-label": "Command", autocomplete: "off" });
  const list = h("ul", { class: "palette__list", role: "listbox", "aria-label": "Commands" });
  let selected = 0;
  let filtered = all;
  const draw = () => {
    const query = input.value.trim().toLowerCase();
    filtered = all.filter((item) => `${item.label} ${item.hint || ""}`.toLowerCase().includes(query));
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    mount(
      list,
      filtered.length
        ? filtered.map((item, index) =>
            h(
              "li",
              {
                role: "option",
                class: "palette__item",
                "aria-selected": String(index === selected),
                onclick: () => choose(item),
                onmousemove: () => {
                  if (selected !== index) {
                    selected = index;
                    draw();
                  }
                },
              },
              h("span", {}, item.label),
              item.hint ? h("span", { class: "palette__hint" }, item.hint) : null,
            ),
          )
        : h("li", { class: "palette__empty" }, "No command matches."),
    );
  };
  const handle = dialog({ title: "Commands", body: h("div", { class: "palette" }, input, list) });
  const choose = (item) => {
    handle.close();
    item.run();
  };
  input.addEventListener("input", () => {
    selected = 0;
    draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") selected = Math.min(filtered.length - 1, selected + 1);
    else if (event.key === "ArrowUp") selected = Math.max(0, selected - 1);
    else if (event.key === "Enter" && filtered[selected]) return choose(filtered[selected]);
    else return;
    event.preventDefault();
    draw();
  });
  draw();
  input.focus();
}

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!document.querySelector("dialog[open]")) openPalette();
  } else if (event.altKey && /^[1-5]$/.test(event.key) && state.project && !typing) {
    event.preventDefault();
    navigate(projectPath(state.project.id, STAGES[Number(event.key) - 1].id));
  } else if (event.key === "Escape" && !drawer.hidden && !document.querySelector("dialog[open]")) {
    toggleDrawer();
  }
});

// Boot ------------------------------------------------------------------------------

(async function boot() {
  try {
    applyTheme(localStorage.getItem(THEME_KEY) === "day" ? "day" : "night");
  } catch {
    applyTheme("night");
  }
  try {
    state.session = await loadSession();
  } catch (error) {
    mount(view, h("div", { class: "page" }, errorState(error, () => location.reload())));
    return;
  }
  route();
})();
