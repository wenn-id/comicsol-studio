// Pure Plan helpers: document parsing, readable models, line diffs, and the
// revision-bound draft reconciliation the Plan stage relies on. No DOM access.

export const PLAN_DOCUMENTS = Object.freeze([
  Object.freeze({ key: "storyPlan", title: "Story plan", hint: "Logline, beats, and scenes" }),
  Object.freeze({ key: "characterBible", title: "Character bible", hint: "Who appears and how they look" }),
  Object.freeze({ key: "storyboard", title: "Storyboard", hint: "Pages, panels, and lettering" }),
  Object.freeze({
    key: "visualIdentityPack",
    title: "Visual identity",
    hint: "Reference identity for consistent art",
  }),
]);

export const PLAN_KEYS = Object.freeze(PLAN_DOCUMENTS.map((entry) => entry.key));
export const PAGE_WIDTH = 1600;
export const PAGE_HEIGHT = 2400;
const MAX_FIELD_LENGTH = 1048576;

const text = (value) => (typeof value === "string" ? value : "");
const array = (value) => (Array.isArray(value) ? value : []);
const list = (value) => array(value)
  .filter((item) => typeof item === "string" || typeof item === "number")
  .map(String)
  .filter(Boolean);

export function parseDocument(source) {
  const raw = typeof source === "string" ? source : "";
  if (!raw.trim()) return Object.freeze({ state: "empty" });
  try {
    return Object.freeze({ state: "valid", value: JSON.parse(raw) });
  } catch (error) {
    return Object.freeze({ state: "invalid", message: jsonErrorMessage(raw, error) });
  }
}

export function jsonErrorMessage(raw, error) {
  const message = String(error?.message || "The document is not valid JSON.");
  const lineColumn = message.match(/line (\d+) column (\d+)/i);
  if (lineColumn) return `JSON error on line ${lineColumn[1]}, column ${lineColumn[2]}.`;
  const position = message.match(/position (\d+)/i);
  if (position) {
    const before = raw.slice(0, Number(position[1]));
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    return `JSON error on line ${line}, column ${column}.`;
  }
  return "The document is not valid JSON.";
}

// The server accepts a plan only as four JSON objects. Catch the shape
// problems here so the creator learns which document to fix before saving.
export function planShapeIssues(plan) {
  const issues = [];
  for (const entry of PLAN_DOCUMENTS) {
    const parsed = parseDocument(plan?.[entry.key]);
    if (parsed.state === "empty") issues.push(Object.freeze({ key: entry.key, message: `${entry.title} is empty.` }));
    else if (parsed.state === "invalid") issues.push(Object.freeze({ key: entry.key, message: `${entry.title}: ${parsed.message}` }));
    else if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      issues.push(Object.freeze({ key: entry.key, message: `${entry.title} must be a JSON object.` }));
    }
  }
  return Object.freeze(issues);
}

export function tidyJson(source) {
  const parsed = parseDocument(source);
  if (parsed.state !== "valid") return null;
  return `${JSON.stringify(parsed.value, null, 2)}\n`;
}

export function storyOutline(value) {
  const story = value && typeof value === "object" ? value : {};
  return Object.freeze({
    title: text(story.title),
    logline: text(story.logline),
    setting: text(story.setting),
    theme: text(story.theme),
    rating: text(story.rating),
    tone: list(story.tone),
    beats: [
      ["Beginning", story.beginning],
      ["Turn", story.turn],
      ["Climax", story.climax],
      ["Ending", story.ending],
    ].map(([label, beat]) => Object.freeze({ label, text: text(beat) })),
    scenes: array(story.scenes).map((scene, index) => Object.freeze({
      id: text(scene?.id) || `scene-${index + 1}`,
      location: text(scene?.location),
      time: text(scene?.time),
      purpose: text(scene?.purpose),
      anchor: text(scene?.continuity_anchor),
      characters: list(scene?.characters),
    })),
  });
}

export function characterCards(value) {
  return array(value?.characters).map((character, index) => {
    const look = character?.visual_fingerprint && typeof character.visual_fingerprint === "object"
      ? character.visual_fingerprint
      : {};
    return Object.freeze({
      id: text(character?.id) || `character-${index + 1}`,
      name: text(character?.name) || text(character?.id) || `Character ${index + 1}`,
      role: text(character?.role),
      pronouns: text(character?.pronouns),
      ageBand: text(character?.age_band),
      motivation: text(character?.motivation),
      speech: text(character?.speech),
      personality: list(character?.personality),
      look: [
        ["Face", look.face],
        ["Hair", look.hair],
        ["Wardrobe", look.wardrobe],
        ["Silhouette", look.silhouette],
      ].map(([label, detail]) => [label, text(detail)]).filter(([, detail]) => detail),
      palette: list(look.palette),
      props: list(look.signature_props),
      invariants: list(look.invariants),
      avoid: list(look.avoid),
    });
  });
}

function panelBox(rect) {
  const values = [rect?.x, rect?.y, rect?.width, rect?.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  const clamp = (number) => Math.min(100, Math.max(0, number));
  const round = (number) => Math.round(number * 1000) / 1000;
  return Object.freeze({
    left: round(clamp((values[0] / PAGE_WIDTH) * 100)),
    top: round(clamp((values[1] / PAGE_HEIGHT) * 100)),
    width: round(clamp((values[2] / PAGE_WIDTH) * 100)),
    height: round(clamp((values[3] / PAGE_HEIGHT) * 100)),
  });
}

export function storyboardPages(value) {
  return array(value?.pages).map((page, pageIndex) => Object.freeze({
    number: Number.isInteger(page?.number) ? page.number : pageIndex + 1,
    layout: text(page?.layout),
    panels: array(page?.panels)
      .map((panel, panelIndex) => Object.freeze({
        id: text(panel?.id) || `panel-${pageIndex + 1}-${panelIndex + 1}`,
        order: Number.isInteger(panel?.order) ? panel.order : panelIndex + 1,
        shot: text(panel?.shot),
        beat: text(panel?.beat),
        action: text(panel?.action),
        composition: text(panel?.composition),
        lighting: text(panel?.lighting),
        expression: text(panel?.expression),
        sceneId: text(panel?.scene_id),
        characters: list(panel?.characters),
        lettering: array(panel?.text).map((item) => Object.freeze({
          kind: text(item?.kind) || "text",
          speaker: text(item?.speaker),
          content: text(item?.content),
        })).filter((item) => item.content),
        box: panelBox(panel?.rect),
      }))
      .sort((left, right) => left.order - right.order),
  }));
}

const OUTLINE_SKIP = new Set(["schema_version"]);

export function outlineEntries(value, depth = 0) {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item, index) => outlineNode(`${index + 1}`, item, depth));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !OUTLINE_SKIP.has(key))
      .slice(0, 200)
      .map(([key, item]) => outlineNode(key, item, depth));
  }
  return [];
}

function outlineNode(key, value, depth) {
  const label = String(key).replace(/[_-]+/g, " ");
  if (value && typeof value === "object") {
    return Object.freeze({ label, children: outlineEntries(value, depth + 1) });
  }
  return Object.freeze({ label, text: value === null ? "" : String(value) });
}

export function documentIsBlank(key, parsed) {
  if (parsed.state === "empty") return true;
  if (parsed.state !== "valid") return false;
  const value = parsed.value;
  if (key === "storyPlan") {
    const story = storyOutline(value);
    return !story.title && !story.logline && !story.setting && !story.theme
      && story.beats.every((beat) => !beat.text) && !story.scenes.length;
  }
  if (key === "storyboard") return !storyboardPages(value).length;
  if (key === "characterBible" || key === "visualIdentityPack") {
    return !array(value?.characters).length && !outlineEntries(value).some(nodeHasContent);
  }
  return !outlineEntries(value).some(nodeHasContent);
}

function nodeHasContent(node) {
  if (node.children) return node.children.some(nodeHasContent);
  return Boolean(node.text);
}

// Line diff with common prefix and suffix trimmed before the LCS table, so a
// local edit inside a long document stays cheap. Returns null when the
// remaining region is too large to diff in the browser.
const MAX_DIFF_CELLS = 1_500_000;

// An empty document has no lines, not one empty line.
const lines = (value) => {
  const text = String(value ?? "");
  return text === "" ? [] : text.split("\n");
};

export function lineDiff(before, after) {
  const left = lines(before);
  const right = lines(after);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const middleLeft = left.slice(start, endLeft);
  const middleRight = right.slice(start, endRight);
  const rows = middleLeft.length + 1;
  const columns = middleRight.length + 1;
  if (rows * columns > MAX_DIFF_CELLS) return null;

  const table = new Uint32Array(rows * columns);
  for (let i = middleLeft.length - 1; i >= 0; i -= 1) {
    for (let j = middleRight.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = middleLeft[i] === middleRight[j]
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const result = left.slice(0, start).map((line) => ({ type: "same", text: line }));
  let i = 0;
  let j = 0;
  while (i < middleLeft.length && j < middleRight.length) {
    if (middleLeft[i] === middleRight[j]) {
      result.push({ type: "same", text: middleLeft[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
      result.push({ type: "del", text: middleLeft[i] });
      i += 1;
    } else {
      result.push({ type: "add", text: middleRight[j] });
      j += 1;
    }
  }
  while (i < middleLeft.length) result.push({ type: "del", text: middleLeft[i++] });
  while (j < middleRight.length) result.push({ type: "add", text: middleRight[j++] });
  for (const line of left.slice(endLeft)) result.push({ type: "same", text: line });
  return result;
}

// Collapse unchanged runs longer than the context window into a single
// "skip" row so a reviewer reads only what changed.
// Compare valid JSON documents in a stable formatted shape so a one-line
// document still diffs line by line. Display only: the saved text is untouched.
export function comparableText(source) {
  const parsed = parseDocument(source);
  if (parsed.state !== "valid") return String(source ?? "");
  return JSON.stringify(parsed.value, null, 2);
}

export function documentDiff(before, after) {
  const left = comparableText(before);
  const right = comparableText(after);
  return Object.freeze({
    diff: lineDiff(left, right),
    formattingOnly: left === right && String(before ?? "") !== String(after ?? ""),
  });
}

export function diffHunks(diff, context = 2) {
  const keep = new Array(diff.length).fill(false);
  diff.forEach((row, index) => {
    if (row.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k += 1) {
      keep[k] = true;
    }
  });
  const rows = [];
  let skipped = 0;
  diff.forEach((row, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ type: "skip", count: skipped });
      skipped = 0;
      rows.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped) rows.push({ type: "skip", count: skipped });
  return rows;
}

export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const row of diff || []) {
    if (row.type === "add") added += 1;
    if (row.type === "del") removed += 1;
  }
  return Object.freeze({ added, removed });
}

export function changedKeys(current, proposed) {
  return PLAN_KEYS.filter((key) => (current?.[key] ?? "") !== (proposed?.[key] ?? ""));
}

export function safeProposal(detail) {
  if (!detail || typeof detail !== "object" || !Number.isInteger(detail.expectedRevision)) return null;
  const changes = detail.changes;
  if (!changes || typeof changes !== "object" || !PLAN_KEYS.every((key) => typeof changes[key] === "string")) {
    return null;
  }
  return Object.freeze({
    expectedRevision: detail.expectedRevision,
    changes: Object.freeze(Object.fromEntries(
      PLAN_KEYS.map((key) => [key, changes[key].slice(0, MAX_FIELD_LENGTH)]),
    )),
  });
}

export function responseMatchesProject(requestedProjectId, currentProject, responseProject) {
  return responseProject?.project_id === requestedProjectId
    && currentProject?.project_id === requestedProjectId;
}

// Persist a reviewed draft, then reconcile with whatever happened while the
// request was in flight: another project, or a newer draft, is never lost.
export async function persistReviewedDraft(store, draft, persist) {
  const submittedProjectId = store.getState().project?.project_id;
  const persisted = await persist();
  const current = store.getState();
  if (persisted.project_id !== submittedProjectId || current.project?.project_id !== submittedProjectId) {
    return Object.freeze({ outcome: "project-changed", persisted });
  }
  const currentDraft = current.draft;
  if (currentDraft !== draft) {
    store.replaceProject(persisted);
    if (currentDraft) store.createDraft(currentDraft.changes, currentDraft.origin);
    return Object.freeze({ outcome: "replacement-preserved", persisted });
  }
  const outcome = store.promoteDraft(persisted) ? "promoted" : "not-promoted";
  return Object.freeze({ outcome, persisted });
}
