// Overview: where the project stands in the engine's lifecycle and the one next step.

import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { LIFECYCLE, activeRuns, lifecycleIndex, nextStep, providerName, relativeTime, statusLabel } from "../model.js";
import { busy, button, confirmDialog, dialog, field, textInput, toastError } from "../ui.js";

const STAGE_NAMES = {
  planning: "Planning",
  storyboard: "Storyboard",
  generation: "Rendering and review",
  lettering: "Lettering",
  composition: "Composition",
  export: "Export",
};
const STATE_WORDS = { complete: "Done", stale: "Needs work", pending: "Not started", missing: "Not started" };

export function renderOverview(container, ctx) {
  const project = ctx.project;
  const step = nextStep(project);
  const query = step.panel ? `?panel=${step.panel}` : step.page ? `?page=${step.page}` : "";
  const current = lifecycleIndex(project.status);
  const runs = activeRuns(project);

  mount(
    container,
    h(
      "div",
      { class: "page page--overview" },
      h(
        "header",
        { class: "page__head" },
        h(
          "div",
          {},
          h("p", { class: "page__eyebrow" }, statusLabel(project.status)),
          h("h1", { class: "page__title" }, project.title),
          project.engineTitle && project.engineTitle !== project.title ? h("p", { class: "page__sub" }, `Engine title: ${project.engineTitle}`) : null,
        ),
        h("div", { class: "page__tools" }, renameButton(ctx), deleteButton(ctx)),
      ),

      h(
        "section",
        { class: "next", "aria-labelledby": "next-title" },
        h("p", { class: "next__label" }, "Next step"),
        h("h2", { class: "next__title", id: "next-title" }, step.title),
        h("p", { class: "next__detail" }, step.detail),
        step.stage !== "overview" ? h("a", { class: "btn btn--amber", href: ctx.projectPath(project.id, step.stage, query), "data-link": true }, h("span", {}, { plan: "Open plan", render: "Open render jobs", review: "Open review", finish: "Open export" }[step.stage])) : null,
      ),

      runs.length
        ? h(
            "section",
            { class: "panel-box", "aria-label": "Work in progress" },
            h("h2", { class: "section-title" }, "Working now"),
            h("ul", { class: "runs" }, runs.map((run) => h("li", { class: "run" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), h("span", {}, `${providerName(run.provider)}: ${run.message || "Queued"}`)))),
          )
        : null,

      h(
        "details",
        { class: "lifecycle-strip", "aria-labelledby": "lifecycle-title" },
        h("summary", { class: "section-title", id: "lifecycle-title" }, "Engine lifecycle"),
        h(
          "ol",
          { class: "steps" },
          LIFECYCLE.map((status, index) =>
            h(
              "li",
              { class: `steps__item${index < current ? " steps__item--done" : ""}${index === current ? " steps__item--current" : ""}`, "aria-current": index === current ? "step" : null },
              h("span", { class: "steps__mark", "aria-hidden": "true" }),
              h("span", { class: "steps__name" }, status.replace(/_/g, " ").toLowerCase()),
            ),
          ),
        ),
      ),

      h(
        "div",
        { class: "overview-grid" },
        h(
          "section",
          { class: "panel-box", "aria-labelledby": "stages-title" },
          h("h2", { class: "section-title", id: "stages-title" }, "Project progress"),
          h(
            "dl",
            { class: "stage-list" },
            (project.summary?.stages || []).map((stage) => [
              h("dt", {}, STAGE_NAMES[stage.stage] || stage.stage),
              h("dd", { class: `stage-state stage-state--${stage.state}` }, STATE_WORDS[stage.state] || stage.state),
            ]),
          ),
          project.summary?.panels
            ? h(
                "p",
                { class: "muted" },
                `${project.summary.panels.accepted} accepted, ${project.summary.panels.pending} pending, ${project.summary.panels.failed} sent back.`,
              )
            : null,
        ),
        h(
          "section",
          { class: "panel-box", "aria-labelledby": "source-title" },
          h("h2", { class: "section-title", id: "source-title" }, project.source.mode === "pasted_story" ? "The story" : "The idea"),
          h("p", { class: "source-text" }, project.source.text || "No source text."),
          h(
            "p",
            { class: "muted" },
            `Language ${project.source.language || "en"} · ${project.settings?.page_count || 0} ${project.settings?.page_count === 1 ? "page" : "pages"}${project.settings?.panel_count ? ` · ${project.settings.panel_count} panels` : ""} · revision ${project.revision} · changed ${relativeTime(project.updatedAt)}`,
          ),
        ),
      ),

      project.warnings.length
        ? h(
            "section",
            { class: "panel-box panel-box--warn", "aria-labelledby": "warnings-title" },
            h("h2", { class: "section-title", id: "warnings-title" }, icon("warn", 16), " Warnings carried into the final report"),
            h("ul", { class: "plain-list" }, project.warnings.map((warning) => h("li", {}, warning))),
          )
        : null,
      validationBox(ctx),
    ),
  );
}

function validationBox(ctx) {
  const output = h("div", { class: "validation-output", "aria-live": "polite" });
  const run = button("Run engine validation", { kind: "ghost", size: "small" });
  run.addEventListener("click", async () => {
    try {
      const { issues } = await busy(run, () => api.validation(ctx.project.id), "Validating");
      mount(
        output,
        issues.length
          ? h("ul", { class: "issue-list" }, issues.map((issue) => h("li", {}, issue)))
          : h("p", { class: "ok-line" }, icon("check", 16), " The engine found no problems at this stage."),
      );
    } catch (error) {
      toastError(error);
    }
  });
  return h(
    "section",
    { class: "panel-box", "aria-labelledby": "validation-title" },
    h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "validation-title" }, "Check the whole project"), run),
    h("p", { class: "muted" }, "Checks the saved project files. Unfinished stages may still have issues."),
    output,
  );
}

function renameButton(ctx) {
  return button("Rename", {
    kind: "ghost",
    size: "small",
    onClick: () => {
      let title = ctx.project.title;
      const save = button("Save title", { kind: "amber" });
      const handle = dialog({
        title: "Rename the comic",
        body: h(
          "form",
          {
            onsubmit: (event) => {
              event.preventDefault();
              save.click();
            },
          },
          field("Title", textInput(title, (value) => (title = value), { maxlength: 120, required: true }), {
            hint: "Changes the title in Studio. The engine keeps the title it was created with.",
          }),
        ),
        actions: [button("Cancel", { kind: "ghost", onClick: () => handle.close() }), save],
      });
      save.addEventListener("click", async () => {
        if (!title.trim()) return;
        try {
          await busy(save, () => ctx.act(() => api.rename(ctx.project.id, ctx.project.revision, title.trim())), "Saving");
          handle.close();
        } catch {
          // act() already reported the error
        }
      });
      handle.element.querySelector("input").select();
    },
  });
}

function deleteButton(ctx) {
  return button("Move to trash", {
    kind: "ghost",
    size: "small",
    iconName: "trash",
    onClick: async () => {
      const ok = await confirmDialog({
        title: "Move this comic to the trash?",
        text: `“${ctx.project.title}” leaves your library. Its folder moves to the trash folder inside the Studio data directory, where you can still recover it by hand.`,
        confirmLabel: "Move to trash",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api.remove(ctx.project.id);
        ctx.navigate("/studio/");
      } catch (error) {
        toastError(error);
      }
    },
  });
}
