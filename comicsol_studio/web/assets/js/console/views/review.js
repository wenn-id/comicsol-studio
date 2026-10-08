// Review: the creator (or a named vision model) judges every panel against its plan, the
// engine letters and composes the pages, and then each composed page is reviewed.
// Evidence is recorded as written; Studio never invents a judgement.

import { api } from "../api.js";
import { h, mount } from "../dom.js";
import { activeRuns, decisionLabel, providerName } from "../model.js";
import { badge, busy, button, confirmDialog, emptyState, errorState, loadingState, segmented, textArea, toast, toastError } from "../ui.js";

const RESULTS = [
  ["pass", "Pass", "ok"],
  ["warning", "Warning", "warn"],
  ["fail", "Fail", "danger"],
];
const PANEL_CHECKS = {
  "character-identity": { title: "Character identity", ask: "Does everyone look like their reference sheet?" },
  anatomy: { title: "Anatomy", ask: "Hands, limbs, faces, and proportions read correctly." },
  action: { title: "Action", ask: "The panel shows the planned action and beat." },
  composition: { title: "Composition", ask: "Shot and framing follow the plan, with room for the balloons." },
  continuity: { title: "Continuity", ask: "The listed facts and the scene anchor are visible." },
  "text-free": { title: "No generated text", ask: "No letters, balloons, logos, or watermarks in the art (authored sound effects aside)." },
  technical: { title: "Technical", ask: "Clean image: no artifacts, seams, blur, or bad crops." },
};
const PAGE_CHECKS = {
  "face-action-obstruction": { title: "Nothing covered", ask: "No balloon or caption covers a face or the key action." },
  "bubble-tail-direction": { title: "Balloon tails", ask: "Every tail points at the character who speaks." },
  "accidental-text-watermark": { title: "No stray text", ask: "No generated letters, signatures, or watermarks anywhere on the page." },
};
const TRAITS = {
  face: "Face",
  hair: "Hair",
  "age-appearance": "Age",
  clothing: "Clothing",
  accessories: "Accessories",
  proportions: "Proportions",
  "immutable-traits": "Always-visible facts",
};
const severityFor = (result) => (result === "warning" ? "warning" : "error");

const sessions = new Map();

function stateFor(ctx) {
  let state = sessions.get(ctx.project.id);
  if (!state) {
    state = { tab: "panels", panel: null, page: null, contexts: new Map(), sheets: new Map() };
    sessions.set(ctx.project.id, state);
  }
  // A ?panel= or ?page= link selects once; later choices in the view are the creator's.
  const routeKey = `${ctx.route.panel || ""}|${ctx.route.page || ""}`;
  if (routeKey !== state.routeKey) {
    state.routeKey = routeKey;
    if (ctx.route.panel) {
      state.tab = "panels";
      state.panel = ctx.route.panel;
    }
    if (ctx.route.page) {
      state.tab = "pages";
      state.page = Number(ctx.route.page);
    }
  }
  return state;
}

export function renderReview(container, ctx) {
  const project = ctx.project;
  const state = stateFor(ctx);
  const rerender = () => renderReview(container, ctx);
  const rendered = project.panels.filter((panel) => panel.image);
  if (!rendered.length) {
    mount(
      container,
      h(
        "div",
        { class: "page" },
        header(),
        emptyState("No panel art to review yet.", "Render or upload panels first; each one appears here for review.", h("a", { class: "btn btn--amber", href: ctx.projectPath(project.id, "render"), "data-link": true }, "Open Render")),
      ),
    );
    return;
  }
  const composedAny = project.pages.some((page) => page.image);
  const tabs = [
    ["panels", `Panels (${project.panels.filter((p) => p.decision === "accept" || p.decision === "accept-warning").length}/${project.panels.length})`],
    ["pages", `Pages${composedAny ? ` (${project.pages.filter((p) => p.decision === "accept" || p.decision === "accept-warning").length}/${project.pages.length})` : ""}`],
  ];
  mount(
    container,
    h(
      "div",
      { class: "page page--review" },
      header(),
      h(
        "div",
        { class: "tabs", role: "tablist", "aria-label": "Review" },
        tabs.map(([id, label]) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              class: "tabs__tab",
              id: `review-tab-${id}`,
              "aria-selected": String(state.tab === id),
              "aria-controls": "review-panel",
              tabindex: state.tab === id ? "0" : "-1",
              onclick: () => {
                state.tab = id;
                rerender();
              },
              onkeydown: (event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                state.tab = state.tab === "panels" ? "pages" : "panels";
                rerender();
                container.querySelector(`#review-tab-${state.tab}`)?.focus();
              },
            },
            label,
          ),
        ),
      ),
      h("div", { role: "tabpanel", id: "review-panel", "aria-labelledby": `review-tab-${state.tab}` }, state.tab === "panels" ? panelsTab(ctx, state, rerender) : pagesTab(ctx, state, rerender)),
    ),
  );
}

function header() {
  return h("header", { class: "page__head" }, h("div", {}, h("p", { class: "page__eyebrow" }, "Review"), h("h1", { class: "page__title" }, "Judge every panel, then every page")));
}

function decisionTone(decision) {
  return { accept: "ok", "accept-warning": "warn", regenerate: "danger", stale: "warn" }[decision] || "neutral";
}

// Panels ------------------------------------------------------------------------------

function panelsTab(ctx, state, rerender) {
  const project = ctx.project;
  const rendered = project.panels.filter((panel) => panel.image);
  if (!state.panel || !rendered.some((panel) => panel.id === state.panel)) {
    state.panel = (rendered.find((panel) => !panel.decision || panel.decision === "stale") || rendered[0]).id;
  }
  const strip = h(
    "ol",
    { class: "filmstrip", "aria-label": "Panels" },
    project.panels.map((panel) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "filmstrip__item",
            "aria-pressed": String(panel.id === state.panel),
            disabled: !panel.image,
            onclick: () => {
              state.panel = panel.id;
              rerender();
            },
          },
          panel.image ? h("img", { src: panel.image, alt: "", loading: "lazy" }) : h("span", { class: "filmstrip__empty" }, "No art"),
          h("span", { class: "filmstrip__label" }, panel.id),
          h("span", { class: `dot dot--${decisionTone(panel.decision)}`, title: decisionLabel(panel.decision) }),
        ),
      ),
    ),
  );
  const holder = h("div", { class: "review-body" });
  loadPanel(ctx, state, holder, rerender);
  return h("div", {}, strip, holder, composeBar(ctx, state, rerender));
}

async function loadPanel(ctx, state, holder, rerender) {
  const project = ctx.project;
  const panelId = state.panel;
  const panel = project.panels.find((entry) => entry.id === panelId);
  const key = `${panelId}@${panel.image}`;
  let context = state.contexts.get(key);
  if (!context) {
    mount(holder, loadingState(`Reading panel ${panelId}`));
    try {
      context = await api.panelReview(project.id, panelId);
      state.contexts.set(key, context);
    } catch (error) {
      mount(holder, errorState(error, () => loadPanel(ctx, state, holder, rerender)));
      return;
    }
    if (state.panel !== panelId) return;
  }
  // Drafts follow the image's bytes, not the revision, so other work never wipes them.
  mount(holder, panelSheet(ctx, state, panel, context, `${panelId}#${context.rawSha256}`, rerender));
}

function planEvidence(context) {
  const panel = context.panel;
  const names = context.characters.map((c) => c.characterId).join(", ");
  return {
    "character-identity": names ? `${names} match their reference sheets in ${panel.id}` : `No recurring character appears in ${panel.id}, as planned`,
    anatomy: `Bodies, hands, and faces${names ? ` of ${names}` : ""} read correctly in ${panel.id}`,
    action: `Shows the planned action: ${panel.action}`,
    composition: `Framing follows the plan: ${panel.shot}; ${panel.composition}`,
    continuity: panel.continuity.length ? `Visible as planned: ${panel.continuity.join("; ")}` : `The ${panel.scene_id} scene anchor is consistent`,
    "text-free": `No generated letters, balloons, logos, or watermarks in ${panel.id}`,
    technical: `Clean ${panel.rect.width} × ${panel.rect.height} image without artifacts, seams, or bad crops`,
  };
}

function panelSheet(ctx, state, panel, context, key, rerender) {
  const project = ctx.project;
  let sheet = state.sheets.get(key);
  if (!sheet) {
    sheet = { checks: {}, traits: {} };
    for (const id of context.checks) sheet.checks[id] = { result: null, evidence: "" };
    for (const character of context.characters) {
      for (const trait of character.traits) sheet.traits[`${character.characterId}/${trait.trait}`] = { result: null, evidence: "" };
    }
    state.sheets.set(key, sheet);
  }
  const hasCast = context.characters.length > 0;
  const runs = activeRuns(project).filter((run) => run.kind === "panel-review" && run.subject === panel.id);
  const plan = context.panel;

  const checkRows = context.checks.map((id) => {
    if (id === "character-identity" && hasCast) {
      return h("li", { class: "check-row" }, h("div", { class: "check-row__head" }, h("p", { class: "check-row__title" }, PANEL_CHECKS[id].title), h("p", { class: "check-row__ask" }, "Judged trait by trait below; the engine rolls the traits up into this check.")));
    }
    return checkRow(PANEL_CHECKS[id] || { title: id, ask: "" }, sheet.checks[id], rerender);
  });

  const traitTable = hasCast
    ? h(
        "section",
        { class: "traits", "aria-label": "Character traits" },
        context.characters.map((character) =>
          h(
            "div",
            { class: "trait-group" },
            h("h3", { class: "card__sub" }, character.characterId),
            h(
              "ul",
              { class: "check-rows" },
              character.traits.map((trait) =>
                checkRow(
                  { title: TRAITS[trait.trait] || trait.trait, ask: `Expected: ${formatExpected(trait.expected)}` },
                  sheet.traits[`${character.characterId}/${trait.trait}`],
                  rerender,
                ),
              ),
            ),
          ),
        ),
      )
    : null;

  const fill = button("Pass everything, with notes from the plan", { kind: "ghost", size: "small", iconName: "check" });
  fill.addEventListener("click", () => {
    const evidence = planEvidence(context);
    for (const [id, entry] of Object.entries(sheet.checks)) {
      if (!entry.result) Object.assign(entry, { result: "pass", evidence: entry.evidence || evidence[id] });
    }
    for (const character of context.characters) {
      for (const trait of character.traits) {
        const entry = sheet.traits[`${character.characterId}/${trait.trait}`];
        if (!entry.result) Object.assign(entry, { result: "pass", evidence: entry.evidence || `${character.characterId} ${TRAITS[trait.trait]?.toLowerCase() || trait.trait} matches: ${formatExpected(trait.expected)}` });
      }
    }
    rerender();
  });

  const submit = button("Record my review", { kind: "amber" });
  submit.addEventListener("click", async () => {
    const missing = [...Object.values(sheet.checks), ...Object.values(sheet.traits)].filter((entry) => !entry.result || !entry.evidence.trim());
    const relevant = hasCast ? missing.filter((entry) => entry !== sheet.checks["character-identity"]) : missing;
    if (relevant.length) {
      toast(`Give ${relevant.length} more ${relevant.length === 1 ? "item" : "items"} a result and a note.`, { tone: "error", detail: "Notes should say what you see, not just “ok”." });
      return;
    }
    const checks = context.checks.map((id) => {
      const entry = sheet.checks[id];
      if (id === "character-identity" && hasCast) {
        return { id, result: "pass", severity: "error", evidence: "Rolled up from the trait review", regions: [] };
      }
      return { id, result: entry.result, severity: severityFor(entry.result), evidence: entry.evidence.trim(), regions: [] };
    });
    const assessments = Object.entries(sheet.traits).map(([traitKey, entry]) => {
      const [characterId, trait] = traitKey.split("/");
      return { character_id: characterId, trait, result: entry.result, severity: severityFor(entry.result), evidence: entry.evidence.trim() };
    });
    try {
      const updated = await busy(submit, () => ctx.act(() => api.reviewPanel(project.id, project.revision, panel.id, { checks, assessments })), "Recording");
      const decision = updated.panels.find((entry) => entry.id === panel.id)?.decision;
      toast(`Panel ${panel.id}: ${decisionLabel(decision).toLowerCase()}.`, { tone: decision === "regenerate" ? "info" : "success", detail: decision === "regenerate" ? "Refresh the jobs on Render to get a new attempt." : null });
      state.sheets.delete(key);
      const next = updated.panels.find((entry) => entry.image && (!entry.decision || entry.decision === "stale"));
      if (next) {
        state.panel = next.id;
        rerender();
      }
    } catch {
      // reported
    }
  });

  const reviewers = ctx.session.providers.reviewers.map((reviewer) => {
    const run = button(`Review with ${providerName(reviewer.id)}`, { kind: "ghost", size: "small", iconName: "review", disabled: runs.length > 0 });
    run.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Ask ${providerName(reviewer.id)} to review ${panel.id}?`,
        text: `Studio sends the panel image and its storyboard entry to ${reviewer.model}, billed to your key. The model's judgement is recorded under its own name, and you can review again yourself at any time.`,
        confirmLabel: "Send for review",
      });
      if (!ok) return;
      try {
        await busy(run, () => api.autoReviewPanel(project.id, project.revision, panel.id, reviewer.id), "Starting");
        ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    });
    return run;
  });

  const record = context.record;
  return h(
    "div",
    { class: "review-grid" },
    h(
      "figure",
      { class: "review-art" },
      h("div", { class: "review-art__frame", style: { aspectRatio: `${plan.rect.width} / ${plan.rect.height}` } }, h("img", { src: panel.image, alt: `Panel ${panel.id}` })),
      h(
        "figcaption",
        { class: "plan-card" },
        h("p", { class: "plan-card__beat" }, plan.beat),
        h(
          "dl",
          {},
          [
            ["Shot", plan.shot],
            ["Action", plan.action],
            ["Expression", plan.expression],
            ["Lighting", plan.lighting],
            ["Continuity", plan.continuity.join("; ") || "None listed"],
          ].map(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]),
        ),
        plan.text.length ? h("p", { class: "muted" }, `Lettering added later: ${plan.text.map((item) => `“${item.content}”`).join(" ")}`) : null,
        h("a", { href: panel.image, target: "_blank", rel: "noopener", class: "text-link" }, "Open full size"),
      ),
    ),
    h(
      "div",
      { class: "review-sheet" },
      h(
        "div",
        { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, `Panel ${panel.id}`), panel.decision ? badge(decisionLabel(panel.decision), decisionTone(panel.decision)) : badge("Not reviewed", "neutral")),
        h("div", { class: "button-row" }, reviewers),
      ),
      runs.length ? h("div", { class: "banner", role: "status" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), h("p", {}, `${providerName(runs[0].provider)} is reviewing this panel.`)) : null,
      record && record.review ? h("p", { class: "muted" }, `Last review by ${record.review.reviewer} (${record.review.method}) on ${record.review.reviewed_at.replace("T", " ").replace("Z", " UTC")}.`) : null,
      fill,
      h("ul", { class: "check-rows" }, checkRows),
      traitTable,
      h("div", { class: "form-actions" }, submit),
    ),
  );
}

function formatExpected(value) {
  if (Array.isArray(value)) return value.join(", ") || "none";
  if (value && typeof value === "object") return [value.build, ...(value.notes || [])].filter(Boolean).join("; ");
  return String(value ?? "");
}

function checkRow(meta, entry, rerender) {
  const evidence = textArea(entry.evidence, (value) => (entry.evidence = value), { rows: 2, placeholder: "What you see in the image", "aria-label": `${meta.title} note` });
  return h(
    "li",
    { class: `check-row${entry.result ? ` check-row--${entry.result}` : ""}` },
    h("div", { class: "check-row__head" }, h("p", { class: "check-row__title" }, meta.title), meta.ask ? h("p", { class: "check-row__ask" }, meta.ask) : null),
    segmented(entry.result, RESULTS, (value) => {
      entry.result = value;
      rerender();
    }, { label: `${meta.title} result` }),
    evidence,
  );
}

function composeBar(ctx, state, rerender) {
  const project = ctx.project;
  const accepted = project.panels.every((panel) => panel.decision === "accept" || panel.decision === "accept-warning");
  if (!accepted) return null;
  const composed = project.pages.every((page) => page.image) && ["COMPOSED", "EXPORTED", "COMPLETE", "COMPLETE_WITH_WARNINGS"].includes(project.status);
  if (composed) {
    return h("div", { class: "banner banner--amber" }, h("p", {}, "Every panel is accepted and the pages are composed."), button("Review the pages", { kind: "amber", size: "small", onClick: () => {
      state.tab = "pages";
      rerender();
    } }));
  }
  return h("div", { class: "banner banner--amber" }, h("p", {}, "Every panel is accepted. The engine can now letter the balloons and compose the pages."), composeButton(ctx, state));
}

function composeButton(ctx, state) {
  const compose = button("Letter and compose pages", { kind: "amber", size: "small" });
  compose.addEventListener("click", async () => {
    const previous = state.tab;
    state.tab = "pages";
    try {
      await busy(compose, () => ctx.act(() => api.compose(ctx.project.id, ctx.project.revision), { success: "Pages lettered and composed." }), "Composing");
    } catch {
      state.tab = previous;
    }
  });
  return compose;
}

// Pages -------------------------------------------------------------------------------

function pagesTab(ctx, state, rerender) {
  const project = ctx.project;
  const composed = project.pages.some((page) => page.image) && ["COMPOSED", "EXPORTED", "COMPLETE", "COMPLETE_WITH_WARNINGS"].includes(project.status);
  if (!composed) {
    const accepted = project.panels.every((panel) => panel.decision === "accept" || panel.decision === "accept-warning");
    return accepted
      ? emptyState("The pages are not composed yet.", "Let the engine letter the balloons and compose the pages.", composeButton(ctx, state))
      : emptyState("Accept every panel first.", "Pages are lettered and composed from accepted panels only.");
  }
  if (!state.page || !project.pages.some((page) => page.number === state.page)) {
    state.page = (project.pages.find((page) => !["accept", "accept-warning"].includes(page.decision)) || project.pages[0]).number;
  }
  const picker = h(
    "ol",
    { class: "filmstrip filmstrip--pages", "aria-label": "Pages" },
    project.pages.map((page) =>
      h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: "filmstrip__item", "aria-pressed": String(page.number === state.page), onclick: () => {
            state.page = page.number;
            rerender();
          } },
          h("img", { src: page.image, alt: "", loading: "lazy" }),
          h("span", { class: "filmstrip__label" }, `Page ${page.number}`),
          h("span", { class: `dot dot--${decisionTone(page.decision)}`, title: decisionLabel(page.decision) }),
        ),
      ),
    ),
  );
  const holder = h("div", { class: "review-body" });
  loadPage(ctx, state, holder, rerender);
  return h("div", {}, picker, holder);
}

async function loadPage(ctx, state, holder, rerender) {
  const project = ctx.project;
  const number = state.page;
  const page = project.pages.find((entry) => entry.number === number);
  const key = `page-${number}@${page.image}`;
  let context = state.contexts.get(key);
  if (!context) {
    mount(holder, loadingState(`Reading page ${number}`));
    try {
      context = await api.pageReview(project.id, number);
      state.contexts.set(key, context);
    } catch (error) {
      mount(holder, errorState(error, () => loadPage(ctx, state, holder, rerender)));
      return;
    }
    if (state.page !== number) return;
  }
  mount(holder, pageSheet(ctx, state, page, context, `page-${number}#${context.pageSha256}`, rerender));
}

function pageSheet(ctx, state, page, context, key, rerender) {
  const project = ctx.project;
  let sheet = state.sheets.get(key);
  if (!sheet) {
    sheet = { checks: {}, balloons: {} };
    for (const id of context.checks) sheet.checks[id] = { result: null, evidence: "" };
    for (const balloon of context.balloons) sheet.balloons[`${balloon.panelId}/${balloon.textId}`] = null;
    state.sheets.set(key, sheet);
  }
  const runs = activeRuns(project).filter((run) => run.kind === "page-review" && run.subject === String(page.number));

  const balloonList = context.balloons.length
    ? h(
        "ul",
        { class: "balloons" },
        context.balloons.map((balloon) => {
          const id = `${balloon.panelId}/${balloon.textId}`;
          return h(
            "li",
            { class: "balloon-row" },
            h("p", { class: "balloon-row__text" }, h("strong", {}, balloon.speaker), ` in ${balloon.panelId}: `, h("span", { class: "lettering" }, `“${balloon.content}”`)),
            segmented(sheet.balloons[id], [["pass", "Points at speaker", "ok"], ["fail", "Wrong speaker", "danger"]], (value) => {
              sheet.balloons[id] = value;
              rerender();
            }, { label: `Tail of ${balloon.speaker}'s line in ${balloon.panelId}` }),
          );
        }),
      )
    : h("p", { class: "muted" }, "This page has no dialogue balloons.");

  const fill = button("Mark everything as passing", { kind: "ghost", size: "small", iconName: "check" });
  fill.addEventListener("click", () => {
    const notes = {
      "face-action-obstruction": `No balloon or caption covers a face or the key action on page ${page.number}`,
      "bubble-tail-direction": context.balloons.length ? `All ${context.balloons.length} dialogue tails on page ${page.number} point at their speakers` : `Page ${page.number} has no dialogue tails to check`,
      "accidental-text-watermark": `No stray generated text, signature, or watermark on page ${page.number}`,
    };
    for (const [id, entry] of Object.entries(sheet.checks)) if (!entry.result) Object.assign(entry, { result: "pass", evidence: entry.evidence || notes[id] });
    for (const id of Object.keys(sheet.balloons)) if (!sheet.balloons[id]) sheet.balloons[id] = "pass";
    rerender();
  });

  const submit = button("Record my review", { kind: "amber" });
  submit.addEventListener("click", async () => {
    const missingChecks = Object.values(sheet.checks).filter((entry) => !entry.result || !entry.evidence.trim()).length;
    const missingTails = Object.values(sheet.balloons).filter((value) => !value).length;
    if (missingChecks || missingTails) {
      toast("Finish the review first.", { tone: "error", detail: `${missingChecks} checks and ${missingTails} balloon tails still need an answer.` });
      return;
    }
    const failedTails = Object.values(sheet.balloons).filter((value) => value === "fail").length;
    const tail = sheet.checks["bubble-tail-direction"];
    if (failedTails && tail.result === "pass") {
      toast("A tail is marked wrong, so the balloon-tail check cannot pass.", { tone: "error" });
      return;
    }
    if (!failedTails && tail.result !== "pass" && context.balloons.length) {
      toast("Mark which tail is wrong, or let the balloon-tail check pass.", { tone: "error" });
      return;
    }
    const checks = context.checks.map((id) => ({ id, result: sheet.checks[id].result, severity: severityFor(sheet.checks[id].result), evidence: sheet.checks[id].evidence.trim() }));
    try {
      const updated = await busy(submit, () => ctx.act(() => api.reviewPage(project.id, project.revision, page.number, { checks, balloons: sheet.balloons })), "Recording");
      const decision = updated.pages.find((entry) => entry.number === page.number)?.decision;
      toast(`Page ${page.number}: ${decisionLabel(decision).toLowerCase()}.`, { tone: decision === "regenerate" ? "info" : "success" });
      state.sheets.delete(key);
      const next = updated.pages.find((entry) => !["accept", "accept-warning"].includes(entry.decision));
      if (next) {
        state.page = next.number;
        rerender();
      } else if (updated.pagesReviewed) ctx.navigate(ctx.projectPath(project.id, "finish"));
    } catch {
      // reported
    }
  });

  const reviewers = ctx.session.providers.reviewers.map((reviewer) => {
    const run = button(`Review with ${providerName(reviewer.id)}`, { kind: "ghost", size: "small", iconName: "review", disabled: runs.length > 0 });
    run.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Ask ${providerName(reviewer.id)} to review page ${page.number}?`,
        text: `Sends the composed page and its balloon list to ${reviewer.model}, billed to your key. The result is recorded under the model's name.`,
        confirmLabel: "Send for review",
      });
      if (!ok) return;
      try {
        await busy(run, () => api.autoReviewPage(project.id, project.revision, page.number, reviewer.id), "Starting");
        ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    });
    return run;
  });

  return h(
    "div",
    { class: "review-grid review-grid--page" },
    h("figure", { class: "review-art" }, h("div", { class: "review-art__frame review-art__frame--page" }, h("img", { src: page.image, alt: `Composed page ${page.number}` })), h("figcaption", {}, h("a", { href: page.image, target: "_blank", rel: "noopener", class: "text-link" }, "Open full size"))),
    h(
      "div",
      { class: "review-sheet" },
      h(
        "div",
        { class: "section-head" },
        h("div", {}, h("h2", { class: "section-title" }, `Page ${page.number}`), page.decision ? badge(decisionLabel(page.decision), decisionTone(page.decision)) : badge("Not reviewed", "neutral")),
        h("div", { class: "button-row" }, reviewers),
      ),
      runs.length ? h("div", { class: "banner", role: "status" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), h("p", {}, `${providerName(runs[0].provider)} is reviewing this page.`)) : null,
      h("p", { class: "muted" }, "The engine has already measured clipped text, overlaps, reading order, borders, and crowding. These three checks need eyes."),
      fill,
      h("ul", { class: "check-rows" }, context.checks.map((id) => checkRow(PAGE_CHECKS[id] || { title: id }, sheet.checks[id], rerender))),
      h("h3", { class: "card__sub" }, "Balloon tails"),
      balloonList,
      h("div", { class: "form-actions" }, submit),
    ),
  );
}

