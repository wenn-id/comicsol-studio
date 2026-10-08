import { workflowEventsUrl } from "/static/api.js";
import { h, icon } from "./dom.js";
import { clockTime, humanize, phaseLabel } from "./format.js";

const OPEN_KEY = "comic-sol-studio-next:log-open";
const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;
const MAX_EVENTS = 200;

function readOpen() {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
}

function writeOpen(value) {
  try {
    localStorage.setItem(OPEN_KEY, String(value));
  } catch {
    // The log still toggles without storage.
  }
}

const FAILED_STATUSES = new Set(["failed", "blocked", "error", "rejected"]);

// Production log: the workflow event stream for the open project, newest first.
// It polls the JSON form of the events route and pauses while the tab is hidden.
export function createProductionLog(aside, toggleButton) {
  const preferred = readOpen();
  let open = preferred === null ? window.matchMedia("(min-width: 80rem)").matches : preferred;
  let projectId = null;
  let polling = false;
  let lastId = 0;
  let timer = null;
  let delay = POLL_MS;
  let unseen = 0;
  const events = [];

  const status = h("p", { class: "log-status", text: "Open a project to follow its production." });
  const list = h("ol", { class: "log-list", "aria-label": "Workflow events, newest first" });
  const closeButton = h(
    "button",
    { type: "button", class: "icon-button", "aria-label": "Hide production log" },
    icon("close"),
  );
  aside.append(
    h(
      "header",
      { class: "log-head" },
      h("div", {}, h("p", { class: "eyebrow", text: "Live / Workflow" }), h("h2", { text: "Production log" })),
      closeButton,
    ),
    status,
    list,
  );

  function setOpen(value) {
    open = value;
    writeOpen(open);
    aside.hidden = !open;
    document.body.dataset.log = open ? "open" : "closed";
    toggleButton.setAttribute("aria-expanded", String(open));
    if (open) unseen = 0;
    updateBadge();
  }

  function updateBadge() {
    toggleButton.dataset.unseen = unseen && !open ? String(Math.min(unseen, 99)) : "";
  }

  function renderEvent(event) {
    const failed = FAILED_STATUSES.has(String(event.status || "").toLowerCase());
    const created = Number(event.created_at);
    const meta = [
      event.phase ? phaseLabel(event.phase) : "",
      event.status ? humanize(event.status) : "",
      [event.provider, event.model].filter(Boolean).join(" / "),
      Number.isInteger(event.attempt) && event.attempt > 0 ? `attempt ${event.attempt}` : "",
    ].filter(Boolean).join(" · ");
    return h(
      "li",
      { class: `log-event${failed ? " log-event-failed" : ""}` },
      h("time", { text: Number.isFinite(created) ? clockTime(created * 1000) : "" }),
      h("p", { class: "log-summary", text: event.summary || humanize(event.type) || "Workflow event" }),
      meta ? h("p", { class: "log-meta", text: meta }) : null,
    );
  }

  function render() {
    list.replaceChildren(...events.map(renderEvent));
    if (!projectId) status.textContent = "Open a project to follow its production.";
    else if (!polling) status.textContent = "Events appear here once you approve production.";
    else if (!events.length) status.textContent = "Waiting for the first workflow event.";
    else status.textContent = `${events.length} event${events.length === 1 ? "" : "s"} so far.`;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!projectId || !polling) return;
    if (document.hidden) {
      schedule(POLL_MS);
      return;
    }
    const requested = projectId;
    try {
      const response = await fetch(workflowEventsUrl(requested, lastId), {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (requested !== projectId) return;
      if (response.status === 404) {
        polling = false;
        render();
        return;
      }
      if (!response.ok) throw new Error("event request failed");
      const body = await response.json();
      const incoming = Array.isArray(body?.events) ? body.events : [];
      for (const event of incoming) {
        if (!event || typeof event !== "object") continue;
        const id = Number(event.event_id);
        if (Number.isInteger(id)) lastId = Math.max(lastId, id);
        events.unshift(event);
      }
      events.splice(MAX_EVENTS);
      if (incoming.length && !open) unseen += incoming.length;
      delay = POLL_MS;
      updateBadge();
      render();
      schedule(POLL_MS);
    } catch {
      if (requested !== projectId) return;
      status.textContent = "The log lost its connection. Retrying shortly.";
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      schedule(delay);
    }
  }

  function sync(state) {
    const nextId = state.project?.project_id ?? null;
    if (nextId !== projectId) {
      projectId = nextId;
      polling = false;
      lastId = 0;
      unseen = 0;
      events.length = 0;
      clearTimeout(timer);
      updateBadge();
      render();
    }
    const hasWorkflow = Boolean(state.workflow && state.workflow.project_id === projectId);
    if (projectId && hasWorkflow && !polling) {
      polling = true;
      render();
      schedule(0);
    }
  }

  toggleButton.addEventListener("click", () => setOpen(!open));
  closeButton.addEventListener("click", () => {
    setOpen(false);
    toggleButton.focus();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && polling) schedule(0);
  });
  setOpen(open);
  render();
  return Object.freeze({ sync, toggle: () => setOpen(!open), isOpen: () => open });
}
