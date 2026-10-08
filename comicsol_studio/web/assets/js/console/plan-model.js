// Pure editing helpers for the three plan documents. The engine stays the judge of
// validity; these helpers only keep derived fields (IDs, order, rectangles, text IDs,
// reference paths) consistent so the creator edits content, not bookkeeping.

export const ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
export const TEXT_KINDS = ["dialogue", "caption", "sfx"];
export const DEFAULT_NEGATIVE = ["generated text", "speech bubbles", "watermark"];
export const LAYOUT_LABELS = {
  "full-page": "Full page",
  "two-horizontal": "Two rows",
  "three-horizontal": "Three rows",
  "hero-top-two-bottom": "Hero top, two below",
  "two-top-hero-bottom": "Two on top, hero below",
};
const ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function slugify(text, fallback = "item") {
  const slug = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const candidate = /^[a-z]/.test(slug) ? slug : `${fallback}-${slug}`.replace(/-+$/, "");
  return ID_PATTERN.test(candidate) ? candidate : fallback;
}

export function uniqueId(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`.slice(0, 48);
    if (!used.has(candidate)) return candidate;
  }
}

export function isValidId(value) {
  return ID_PATTERN.test(String(value || ""));
}

export function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

export function newScene(id) {
  return { id, purpose: "", location: "", time: "", characters: [], continuity_anchor: "" };
}

export function newCharacter(id) {
  return {
    id,
    name: "",
    role: "",
    age_band: "",
    pronouns: "",
    personality: [],
    motivation: "",
    speech: "",
    reference_path: `references/characters/${id}.png`,
    visual_fingerprint: {
      silhouette: "",
      face: "",
      hair: "",
      wardrobe: "",
      palette: [],
      signature_props: [],
      invariants: [],
      avoid: ["generated text"],
    },
  };
}

export function newPanel(sceneId = "") {
  return {
    scene_id: sceneId,
    beat: "",
    characters: [],
    shot: "",
    composition: "",
    action: "",
    expression: "",
    lighting: "",
    continuity: [],
    negative: [...DEFAULT_NEGATIVE],
    text: [],
  };
}

export function newTextItem(kind = "dialogue", speaker = null) {
  const item = { kind, content: "", anchor: "top-left", speaker: kind === "dialogue" ? speaker : null };
  if (kind === "dialogue") {
    item.voice_source = "human";
    item.speaker_anchor = [0.5, 0.45];
  }
  return item;
}

// A complete, deliberately unfinished plan the creator fills in. Empty strings fail the
// engine's validation until they are written, so nothing placeholder can be saved.
export function emptyPlan({ title = "", pageCount = 2 } = {}, layouts) {
  const pages = [];
  for (let number = 1; number <= pageCount; number++) {
    pages.push({ number, layout: "two-horizontal", panels: [] });
  }
  const plan = {
    storyPlan: {
      schema_version: "1.0",
      title,
      logline: "",
      theme: "",
      tone: [],
      rating: "teen",
      setting: "",
      beginning: "",
      turn: "",
      climax: "",
      ending: "",
      scenes: [newScene("scene-one"), newScene("scene-two")],
    },
    characterBible: { schema_version: "1.0", characters: [] },
    storyboard: { schema_version: "1.0", pages },
  };
  return normalizePlan(plan, layouts);
}

export function layoutPanelCount(layouts, layout) {
  return (layouts?.[layout] || []).length || 1;
}

// Keep page numbers, panel IDs, order, rectangles, and text IDs in step with the layout.
export function normalizePlan(plan, layouts) {
  const next = clone(plan);
  const firstScene = next.storyPlan?.scenes?.[0]?.id || "";
  next.storyboard.pages = (next.storyboard.pages || []).map((page, pageIndex) => {
    const rects = layouts?.[page.layout] || [];
    const panels = [...(page.panels || [])];
    while (panels.length < rects.length) panels.push(newPanel(panels.at(-1)?.scene_id || firstScene));
    panels.length = rects.length || panels.length;
    return {
      number: pageIndex + 1,
      layout: page.layout,
      panels: panels.map((panel, panelIndex) => {
        const id = `p${String(pageIndex + 1).padStart(2, "0")}-${String(panelIndex + 1).padStart(2, "0")}`;
        const rect = rects[panelIndex];
        return {
          ...panel,
          id,
          order: panelIndex + 1,
          ...(rect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
          text: (panel.text || []).map((item, textIndex) => normalizeText(item, `${id}-t${String(textIndex + 1).padStart(2, "0")}`, textIndex + 1)),
        };
      }),
    };
  });
  next.characterBible.characters = (next.characterBible.characters || []).map((character) => ({
    ...character,
    reference_path: `references/characters/${character.id}.png`,
  }));
  return next;
}

function normalizeText(item, id, priority) {
  const text = { ...item, id, priority };
  if (text.kind !== "dialogue") {
    text.speaker = null;
    delete text.voice_source;
    delete text.speaker_anchor;
  } else {
    text.voice_source = text.voice_source || "human";
    text.speaker_anchor = Array.isArray(text.speaker_anchor) ? text.speaker_anchor : [0.5, 0.45];
  }
  if (text.kind !== "sfx") delete text.render_mode;
  return text;
}

export function setLayout(plan, pageIndex, layout, layouts) {
  const next = clone(plan);
  next.storyboard.pages[pageIndex].layout = layout;
  return normalizePlan(next, layouts);
}

export function addPage(plan, layouts, layout = "two-horizontal") {
  const next = clone(plan);
  if (next.storyboard.pages.length >= 4) return next;
  next.storyboard.pages.push({ number: next.storyboard.pages.length + 1, layout, panels: [] });
  return normalizePlan(next, layouts);
}

export function removePage(plan, pageIndex, layouts) {
  const next = clone(plan);
  if (next.storyboard.pages.length <= 1) return next;
  next.storyboard.pages.splice(pageIndex, 1);
  return normalizePlan(next, layouts);
}

export function panelCount(plan) {
  return (plan?.storyboard?.pages || []).reduce((sum, page) => sum + (page.panels || []).length, 0);
}

export function allPanels(plan) {
  return (plan?.storyboard?.pages || []).flatMap((page) => page.panels || []);
}

export function findPanel(plan, panelId) {
  for (const [pageIndex, page] of (plan?.storyboard?.pages || []).entries()) {
    const panelIndex = (page.panels || []).findIndex((panel) => panel.id === panelId);
    if (panelIndex >= 0) return { pageIndex, panelIndex, panel: page.panels[panelIndex] };
  }
  return null;
}

// Facts a panel may list in `continuity`: the exact invariants of its characters and the
// anchor of its scene, written `owner-id:fact` as the engine requires.
export function continuityOptions(plan, panel) {
  const options = [];
  const characters = plan.characterBible.characters || [];
  for (const id of panel.characters || []) {
    const character = characters.find((entry) => entry.id === id);
    for (const fact of character?.visual_fingerprint?.invariants || []) {
      if (fact) options.push({ value: `${id}:${fact}`, owner: character.name || id, fact });
    }
  }
  const scene = (plan.storyPlan.scenes || []).find((entry) => entry.id === panel.scene_id);
  if (scene?.continuity_anchor) {
    options.push({ value: `${scene.id}:${scene.continuity_anchor}`, owner: scene.id, fact: scene.continuity_anchor });
  }
  return options;
}

// Renaming an ID updates every reference to it, so the plan never points at a ghost.
export function renameCharacter(plan, oldId, newId) {
  const next = clone(plan);
  if (oldId === newId) return next;
  for (const character of next.characterBible.characters) {
    if (character.id === oldId) {
      character.id = newId;
      character.reference_path = `references/characters/${newId}.png`;
    }
  }
  for (const scene of next.storyPlan.scenes) {
    scene.characters = scene.characters.map((id) => (id === oldId ? newId : id));
  }
  for (const panel of allPanels(next)) {
    panel.characters = panel.characters.map((id) => (id === oldId ? newId : id));
    panel.continuity = panel.continuity.map((entry) => (entry.startsWith(`${oldId}:`) ? `${newId}:${entry.slice(oldId.length + 1)}` : entry));
    for (const item of panel.text) {
      if (item.speaker === oldId) item.speaker = newId;
    }
  }
  return next;
}

export function renameScene(plan, oldId, newId) {
  const next = clone(plan);
  if (oldId === newId) return next;
  for (const scene of next.storyPlan.scenes) if (scene.id === oldId) scene.id = newId;
  for (const panel of allPanels(next)) {
    if (panel.scene_id === oldId) panel.scene_id = newId;
    panel.continuity = panel.continuity.map((entry) => (entry.startsWith(`${oldId}:`) ? `${newId}:${entry.slice(oldId.length + 1)}` : entry));
  }
  return next;
}

export function removeCharacter(plan, id) {
  const next = clone(plan);
  next.characterBible.characters = next.characterBible.characters.filter((character) => character.id !== id);
  for (const scene of next.storyPlan.scenes) scene.characters = scene.characters.filter((entry) => entry !== id);
  for (const panel of allPanels(next)) {
    panel.characters = panel.characters.filter((entry) => entry !== id);
    panel.continuity = panel.continuity.filter((entry) => !entry.startsWith(`${id}:`));
    panel.text = panel.text.filter((item) => item.speaker !== id);
  }
  return next;
}

export function removeScene(plan, id) {
  const next = clone(plan);
  next.storyPlan.scenes = next.storyPlan.scenes.filter((scene) => scene.id !== id);
  const fallback = next.storyPlan.scenes[0]?.id || "";
  for (const panel of allPanels(next)) {
    if (panel.scene_id === id) panel.scene_id = fallback;
    panel.continuity = panel.continuity.filter((entry) => !entry.startsWith(`${id}:`));
  }
  return next;
}

export function panelWords(panel) {
  return (panel.text || []).reduce((sum, item) => sum + wordCount(item.content), 0);
}

// Engine issues read "plan/storyboard.json.pages[0].panels[1].action: must be ...".
const DOCUMENTS = {
  "plan/story-plan.json": "story",
  "plan/character-bible.json": "cast",
  "plan/storyboard.json": "storyboard",
  "character-identity-pack": "cast",
};

export function parseIssue(issue) {
  const text = String(issue);
  const colon = text.indexOf(": ");
  const location = colon >= 0 ? text.slice(0, colon) : "";
  const message = colon >= 0 ? text.slice(colon + 2) : text;
  for (const [prefix, doc] of Object.entries(DOCUMENTS)) {
    if (location.startsWith(prefix)) {
      const path = location.slice(prefix.length).replace(/^\./, "");
      const page = /pages\[(\d+)\]/.exec(path);
      const panel = /panels\[(\d+)\]/.exec(path);
      const character = /characters\[(\d+)\]/.exec(path);
      const scene = /scenes\[(\d+)\]/.exec(path);
      return {
        doc,
        path,
        message,
        text,
        pageIndex: page ? Number(page[1]) : null,
        panelIndex: panel ? Number(panel[1]) : null,
        characterIndex: doc === "cast" && character ? Number(character[1]) : null,
        sceneIndex: scene ? Number(scene[1]) : null,
        field: path.split(".").at(-1)?.replace(/\[\d+\]$/, "") || "",
      };
    }
  }
  return { doc: "other", path: location, message, text, pageIndex: null, panelIndex: null, characterIndex: null, sceneIndex: null, field: "" };
}

export function groupIssues(issues) {
  const groups = { story: [], cast: [], storyboard: [], other: [] };
  for (const issue of issues || []) {
    const parsed = parseIssue(issue);
    groups[parsed.doc].push(parsed);
  }
  return groups;
}

export function issuesFor(issues, predicate) {
  return (issues || []).map(parseIssue).filter(predicate);
}

export function planEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
