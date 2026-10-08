// Pure generation-job helpers for the render board. No DOM access.

export const KNOWN_STATES = Object.freeze(new Set([
  "queued", "running", "polling", "validating", "accepted",
  "awaiting_provider_confirmation", "paused", "failed", "cancelled",
]));
export const ACTIVE_STATES = Object.freeze(new Set([
  "queued", "running", "polling", "awaiting_provider_confirmation",
]));

export const LANES = Object.freeze([
  Object.freeze({ key: "attention", title: "Needs you", empty: "Nothing is waiting on you." }),
  Object.freeze({ key: "active", title: "In progress", empty: "No job is running right now." }),
  Object.freeze({ key: "done", title: "Accepted", empty: "No accepted result yet." }),
  Object.freeze({ key: "history", title: "History", empty: "No stopped or older jobs." }),
]);

export function displayState(job) {
  return KNOWN_STATES.has(job?.state) ? job.state : "unknown";
}

export function isStaged(job) {
  return job?.state === "validating" && job?.artifact_state === "staged";
}

// A job only asks for a decision when it belongs to the current revision;
// older failures stay visible but read-only.
export function laneFor(job, revision) {
  const current = job?.project_revision === revision;
  if (isStaged(job)) return current ? "attention" : "history";
  if (job?.state === "failed" || job?.state === "paused") return current ? "attention" : "history";
  if (ACTIVE_STATES.has(job?.state)) return "active";
  if (job?.state === "accepted") return "done";
  return "history";
}

export function groupJobs(jobs, revision) {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane.key, []]));
  for (const job of jobs || []) lanes[laneFor(job, revision)].push(job);
  return lanes;
}

export function hasActiveJobs(jobs) {
  return (jobs || []).some((job) => ACTIVE_STATES.has(job?.state));
}

export function availableActions(job, revision) {
  const current = job?.project_revision === revision;
  if (!current) return Object.freeze([]);
  const actions = [];
  if (isStaged(job)) actions.push("promote");
  if (job.state === "failed") actions.push("retry");
  if (job.state === "failed" || job.state === "paused") actions.push("switch");
  if (job.can_cancel === true) actions.push("cancel");
  return Object.freeze(actions);
}

// The queue is idempotent per revision: asking again for the same route can
// return jobs that already ran or were cancelled. Only fresh work counts.
export function queueOutcome(jobs) {
  const all = Array.isArray(jobs) ? jobs : [];
  const fresh = all.filter((job) => ACTIVE_STATES.has(job?.state) || isStaged(job));
  const existingStates = [...new Set(all.filter((job) => !fresh.includes(job)).map((job) => displayState(job)))];
  return Object.freeze({ fresh: fresh.length, existing: all.length - fresh.length, existingStates });
}

export function routeFingerprint(option, authMode) {
  if (!option || !authMode) return null;
  return `${option.provider}\u0000${option.model}\u0000${authMode}`;
}

export function costText(estimate) {
  if (!estimate || typeof estimate !== "object") return null;
  const amount = estimate.amount;
  const currency = typeof estimate.currency === "string" ? estimate.currency : "";
  const unit = typeof estimate.unit === "string" ? estimate.unit : "";
  if (amount === undefined || amount === null || !currency) return null;
  return `${amount} ${currency}${unit ? ` per ${unit}` : ""}`;
}
