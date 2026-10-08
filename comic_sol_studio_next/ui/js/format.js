// Pure formatting helpers. No DOM access, so they run under Node in tests.

export const MAX_SOURCE_BYTES = 200 * 1024;

const encoder = new TextEncoder();

export function utf8Length(text) {
  return encoder.encode(String(text ?? "")).byteLength;
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    const kib = value / 1024;
    return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
  }
  const mib = value / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}

const STATE_LABELS = Object.freeze({
  queued: "Queued",
  running: "Rendering",
  polling: "Waiting on provider",
  validating: "Checking result",
  accepted: "Accepted",
  awaiting_provider_confirmation: "Needs provider confirmation",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  ready_for_review: "Ready for review",
  blocked: "Blocked",
  complete: "Complete",
  completed: "Complete",
});

export function stateLabel(state) {
  return STATE_LABELS[state] || "Unknown state";
}

export const WORKFLOW_PHASES = Object.freeze([
  Object.freeze(["references", "Character references"]),
  Object.freeze(["panels", "Panels"]),
  Object.freeze(["panel-qa", "Panel QA"]),
  Object.freeze(["lettering", "Lettering"]),
  Object.freeze(["composition", "Page composition"]),
  Object.freeze(["export", "Export"]),
]);

export function phaseLabel(phase) {
  const known = WORKFLOW_PHASES.find(([key]) => key === phase);
  return known ? known[1] : humanize(phase);
}

export function humanize(value) {
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export function shortId(value, length = 8) {
  const text = String(value ?? "");
  return text.length > length ? text.slice(0, length) : text;
}

export function clockTime(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
