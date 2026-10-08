// Studio API client. Every write carries the CSRF token; project writes carry the revision
// the creator was looking at, so a stale view gets a conflict instead of overwriting work.

export class ApiError extends Error {
  constructor(status, body) {
    const error = body?.error || {};
    super(error.message || `Studio returned ${status}.`);
    this.status = status;
    this.code = error.code || "http_error";
    this.hint = error.hint || null;
    this.details = Array.isArray(error.details) ? error.details : [];
  }

  get stale() {
    return this.code === "stale_revision";
  }
}

let session = null;
let sessionPromise = null;

export async function loadSession(force = false) {
  if (session && !force) return session;
  if (!sessionPromise || force) {
    sessionPromise = fetch("/api/session", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new ApiError(response.status, body);
        session = body;
        return body;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

export function currentSession() {
  return session;
}

export function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function request(method, path, { body, form, revision, idempotencyKey, raw = false } = {}, retried = false) {
  const headers = { accept: "application/json" };
  if (method !== "GET") {
    const { csrfToken } = await loadSession();
    headers["x-csrf-token"] = csrfToken;
  }
  if (revision !== undefined) headers["x-revision"] = String(revision);
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, { error: { code: "offline", message: "Studio is not reachable.", hint: "Check that the Studio process is still running." } });
  }
  if (raw && response.ok) return response;
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new ApiError(response.status, data);
    if (error.code === "csrf_failed" && !retried) {
      await loadSession(true);
      return request(method, path, { body, form, revision, idempotencyKey, raw }, true);
    }
    throw error;
  }
  return data;
}

const project = (id) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  starters: () => request("GET", "/api/starters"),
  projects: () => request("GET", "/api/projects"),
  project: (id) => request("GET", project(id)),
  create: (body, idempotencyKey) => request("POST", "/api/projects", { body, idempotencyKey }),
  importArchive(file, idempotencyKey) {
    const form = new FormData();
    form.append("archive", file, file.name);
    return request("POST", "/api/projects/import", { form, idempotencyKey });
  },
  rename: (id, revision, title) => request("PATCH", project(id), { body: { title }, revision }),
  remove: (id) => request("DELETE", project(id)),
  validatePlan: (id, plan) => request("POST", `${project(id)}/plan/validate`, { body: { plan } }),
  savePlan: (id, revision, plan) => request("PUT", `${project(id)}/plan`, { body: { plan }, revision }),
  draftPlan: (id, revision, provider) => request("POST", `${project(id)}/plan/draft`, { body: { provider }, revision }),
  prepare: (id, revision) => request("POST", `${project(id)}/render/prepare`, { revision }),
  upload(id, revision, jobId, file) {
    const form = new FormData();
    form.append("image", file, file.name || "image.png");
    return request("POST", `${project(id)}/render/jobs/${jobId}/upload`, { form, revision });
  },
  renderJob: (id, revision, jobId, provider) =>
    request("POST", `${project(id)}/render/jobs/${jobId}/render`, { body: { provider }, revision }),
  renderReady: (id, revision, provider) => request("POST", `${project(id)}/render/ready`, { body: { provider }, revision }),
  approveCandidate: (id, revision, jobId) =>
    request("POST", `${project(id)}/render/jobs/${jobId}/candidate/approve`, { revision }),
  discardCandidate: (id, jobId) => request("DELETE", `${project(id)}/render/jobs/${jobId}/candidate`),
  candidateUrl: (id, jobId, nonce) => `${project(id)}/render/jobs/${jobId}/candidate.png?n=${nonce}`,
  panelReview: (id, panelId) => request("GET", `${project(id)}/panels/${panelId}/review`),
  reviewPanel: (id, revision, panelId, body) => request("POST", `${project(id)}/panels/${panelId}/review`, { body, revision }),
  autoReviewPanel: (id, revision, panelId, provider) =>
    request("POST", `${project(id)}/panels/${panelId}/review/auto`, { body: { provider }, revision }),
  compose: (id, revision) => request("POST", `${project(id)}/pages/compose`, { revision }),
  pageReview: (id, number) => request("GET", `${project(id)}/pages/${number}/review`),
  reviewPage: (id, revision, number, body) => request("POST", `${project(id)}/pages/${number}/review`, { body, revision }),
  autoReviewPage: (id, revision, number, provider) =>
    request("POST", `${project(id)}/pages/${number}/review/auto`, { body: { provider }, revision }),
  finalize: (id, revision) => request("POST", `${project(id)}/finalize`, { revision }),
  exportArchive: (id) => request("POST", `${project(id)}/exports/archive`, { raw: true }),
  run: (id, runId) => request("GET", `${project(id)}/runs/${runId}`),
  activity: (id) => request("GET", `${project(id)}/activity`),
  validation: (id) => request("GET", `${project(id)}/validation`),
};
