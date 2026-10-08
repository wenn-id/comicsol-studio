// Review: the light table. Inspect the accepted raster, promote a staged one,
// run QA, repair failures, and take a private export.

import {
  acceptedRasterUrl,
  exportProject,
  getProject,
  getWorkflow,
  listGenerationJobs,
  retryGeneration,
  runQa,
  submitStagedRaster,
} from "/static/api.js";
import { h, icon, replace, uid } from "../dom.js";
import { humanize, phaseLabel, shortId, stateLabel } from "../format.js";
import { hasActiveJobs } from "../jobs-model.js";
import { groupIssues } from "../qa-model.js";
import { confirmDialog, openDialog } from "../dialogs.js";

const REFRESH_MS = 2000;
const FORMATS = Object.freeze([
  Object.freeze({
    value: "archive",
    label: "Portable archive",
    detail: "A .comic-sol-handoff file you can import into any Comic Sol surface.",
    filename: "comic-sol-export.comic-sol-handoff",
  }),
  Object.freeze({
    value: "pdf",
    label: "PDF",
    detail: "The composed comic as a private PDF.",
    filename: "comic-sol-export.pdf",
  }),
]);

export function mountReviewView({ store, announce, navigate }) {
  let disposed = false;
  let refreshTimer = null;
  let objectUrl = null;
  // Sentinel so the first update always renders, even when a value is undefined.
  const UNSET = Symbol("unset");
  let lastGeneration = UNSET;
  let lastQa = UNSET;
  let lastWorkflow = UNSET;
  let format = FORMATS[0];

  function revokeUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  // Light table
  const table = h("div", { class: "light-table" });
  const stagedSlot = h("div", { class: "staged-slot" });
  const tablePanel = h(
    "section",
    { class: "panel panel-marked table-panel", "aria-labelledby": "table-heading" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Accepted / Staged" }), h("h2", { id: "table-heading", text: "Light table" })),
    table,
    stagedSlot,
  );

  // QA
  const qaResult = h("div", { class: "qa-result", "aria-live": "polite" });
  const qaButton = h("button", { type: "button", class: "button button-primary" }, "Run QA");
  const qaPanel = h(
    "section",
    { class: "panel qa-panel", "aria-labelledby": "qa-heading" },
    h(
      "header",
      { class: "panel-head panel-head-row" },
      h("div", {}, h("p", { class: "eyebrow", text: "Checks" }), h("h2", { id: "qa-heading", text: "QA findings" })),
      qaButton,
    ),
    qaResult,
  );

  // Repair
  const repairList = h("div", { class: "repair-list" });
  const repairPanel = h(
    "section",
    { class: "panel repair-panel", "aria-labelledby": "repair-heading" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Fix" }), h("h2", { id: "repair-heading", text: "Repair or rerender" })),
    repairList,
  );

  // Production result
  const workflowLine = h("p", { class: "field-help", role: "status" });
  const pdfSlot = h("div", { class: "pdf-slot" });
  const resultPanel = h(
    "section",
    { class: "panel result-panel", "aria-labelledby": "result-heading" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Workflow" }), h("h2", { id: "result-heading", text: "Production result" })),
    workflowLine,
    pdfSlot,
  );

  // Export
  const formatGroup = h("div", { class: "format-list", role: "radiogroup", "aria-label": "Export format" });
  const formatName = uid("format");
  for (const option of FORMATS) {
    const id = uid("format-option");
    const input = h("input", {
      id,
      type: "radio",
      name: formatName,
      value: option.value,
      class: "visually-hidden",
      checked: option === format,
    });
    input.addEventListener("change", () => {
      format = option;
    });
    formatGroup.append(input, h(
      "label",
      { for: id, class: "format-card" },
      h("span", { class: "format-name", text: option.label }),
      h("span", { class: "format-detail", text: option.detail }),
    ));
  }
  const overwrite = h("input", { id: "export-overwrite", name: "overwrite_confirmation", type: "checkbox" });
  const exportButton = h("button", { type: "button", class: "button button-primary" }, icon("download"), "Create private export");
  const downloadSlot = h("div", { class: "download-slot" });
  const exportPanel = h(
    "section",
    { class: "panel export-panel", "aria-labelledby": "export-heading", "aria-describedby": "export-guidance" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Private / Download" }), h("h2", { id: "export-heading", text: "Export" })),
    formatGroup,
    h("label", { class: "confirm-row", for: "export-overwrite" }, overwrite, h("span", { text: "Replace any earlier export of this project." })),
    h("p", { class: "field-help", id: "export-guidance", text: "Exports are private downloads. Nothing is published or uploaded." }),
    h("div", { class: "actions" }, exportButton),
    downloadSlot,
  );

  const element = h(
    "div",
    { class: "view view-review" },
    h(
      "header",
      { class: "stage-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow", text: "04 / Review" }),
        h("h1", { class: "display display-md", text: "Check the pages" }),
        h("p", { class: "stage-lede", text: "Results stay exactly as the server stored them. This page never edits raster bytes." }),
      ),
      h("div", { class: "stage-tools" }, h("button", { type: "button", class: "button", on: { click: () => navigate("generate") } }, "Back to the render board")),
    ),
    h(
      "div",
      { class: "review-layout" },
      tablePanel,
      h("div", { class: "review-side" }, qaPanel, resultPanel, exportPanel, repairPanel),
    ),
  );

  // Data
  async function refresh() {
    clearTimeout(refreshTimer);
    try {
      const current = store.getState().project;
      const project = await getProject(current.project_id);
      const result = await listGenerationJobs(project.project_id, project.revision);
      if (disposed) return;
      store.replaceProjectAndGenerationJobs(project, Array.isArray(result.jobs) ? result.jobs : [], result.accepted_job ?? null);
      await loadWorkflow();
    } catch (error) {
      announce(error.message, "error");
    }
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!disposed && hasActiveJobs(store.getState().generation.jobs)) refreshTimer = setTimeout(refresh, REFRESH_MS);
  }

  let workflowMissing = false;
  async function loadWorkflow() {
    if (workflowMissing) return;
    try {
      const result = await getWorkflow(store.getState().project.project_id);
      if (!disposed) store.setWorkflow(result.workflow);
    } catch (error) {
      if (Number(error?.status) === 404) workflowMissing = true;
    }
  }

  function openViewer(src, trigger) {
    openDialog({
      title: "Accepted raster",
      className: "sheet-viewer",
      trigger,
      build: () => {
        const image = h("img", { src, alt: "Accepted raster at full size", class: "viewer-image" });
        const fit = h("button", { type: "button", class: "button button-small", "aria-pressed": "true" }, "Fit to screen");
        fit.addEventListener("click", () => {
          const fitted = fit.getAttribute("aria-pressed") === "true";
          fit.setAttribute("aria-pressed", String(!fitted));
          fit.textContent = fitted ? "Actual size" : "Fit to screen";
          image.dataset.fit = String(!fitted);
        });
        image.dataset.fit = "true";
        return h("div", { class: "viewer" }, h("div", { class: "actions" }, fit), h("div", { class: "viewer-frame" }, image));
      },
    });
  }

  function renderTable(state) {
    const { project, generation } = state;
    if (generation.accepted?.artifact_job_id) {
      const src = acceptedRasterUrl(project.project_id, project.revision, generation.accepted.artifact_job_id);
      const image = h("img", { src, alt: "Last accepted raster for the current panel", class: "table-image", loading: "lazy" });
      const frame = h(
        "figure",
        { class: "table-frame" },
        h(
          "button",
          { type: "button", class: "table-zoom", "aria-label": "Open the accepted raster at full size" },
          image,
          h("span", { class: "zoom-hint" }, icon("expand"), "Full size"),
        ),
        h(
          "figcaption",
          {},
          h("strong", { text: "Accepted" }),
          ` · ${generation.accepted.provider} / ${generation.accepted.model} · job #${shortId(generation.accepted.job_id)}`,
        ),
      );
      frame.querySelector("button").addEventListener("click", (event) => openViewer(src, event.currentTarget));
      image.addEventListener("error", () => {
        replace(frame, h("div", { class: "state-note state-note-error" }, icon("alert"), h("p", { text: "The accepted raster could not be loaded. Refresh the board, then try again." })));
      });
      replace(table, frame);
    } else {
      const loaded = generation.loadedRevision === project.revision;
      replace(table, h(
        "div",
        { class: "table-empty" },
        h("span", { class: "table-empty-sheet", "aria-hidden": "true" }),
        h("p", { class: "table-empty-title", text: loaded ? "Nothing on the light table yet" : "Loading results…" }),
        loaded
          ? h("p", { text: "Accepted rasters appear here after you promote a staged result in Generate." })
          : null,
      ));
    }

    const staged = generation.staged;
    if (!staged) {
      replace(stagedSlot);
      return;
    }
    const current = staged.project_revision === project.revision;
    replace(stagedSlot, h(
      "div",
      { class: "staged-card" },
      h("p", {}, h("strong", { text: "Staged result waiting. " }), `${staged.provider} / ${staged.model} has not replaced the accepted raster.`),
      current
        ? h("button", {
          type: "button",
          class: "button button-primary",
          on: {
            click: (event) => confirmDialog({
              title: "Confirm promotion",
              body: "Promote this staged raster through the server as the accepted result?",
              confirmText: "Promote staged raster",
              trigger: event.currentTarget,
              onConfirm: async (close) => {
                try {
                  await submitStagedRaster(staged.job_id, project.revision);
                  close();
                  announce("Staged raster promoted.", "success");
                  await refresh();
                } catch (error) {
                  announce(error.message, "error");
                }
              },
            }),
          },
        }, "Promote staged raster")
        : h("p", { class: "field-help", text: "It belongs to an earlier revision, so it cannot be promoted." }),
    ));
  }

  function renderQa(state) {
    const qa = state.generation.qa || state.project.summary?.qa;
    if (!qa) {
      replace(qaResult, h("p", { class: "field-help", text: `QA has not run for revision ${state.project.revision}.` }));
      return;
    }
    const issues = Array.isArray(qa.issues) ? qa.issues : [];
    replace(
      qaResult,
      h(
        "p",
        { class: `qa-verdict qa-${qa.valid ? "pass" : "fail"}` },
        icon(qa.valid ? "check" : "alert"),
        qa.valid ? "QA passed." : `QA reported ${issues.length} finding${issues.length === 1 ? "" : "s"}.`,
      ),
      issues.length ? h("div", { class: "qa-groups" }, groupIssues(issues).map(([area, items], index) => h(
        "details",
        { class: "qa-group", open: index === 0 },
        h("summary", {}, h("code", { text: area }), h("span", { class: "qa-count", text: String(items.length) })),
        h(
          "ol",
          { class: "qa-issues" },
          items.map((issue) => h("li", {}, h("code", { text: String(issue.path ?? "") }), h("span", { text: String(issue.message ?? "") }))),
        ),
      ))) : null,
    );
  }

  qaButton.addEventListener("click", async () => {
    const project = store.getState().project;
    qaButton.disabled = true;
    qaButton.textContent = "Running QA…";
    try {
      const checked = await runQa(project.project_id, project.revision);
      if (!disposed) store.setQa(checked);
      announce("QA completed.", "success");
    } catch (error) {
      announce(error.message, "error");
    } finally {
      qaButton.disabled = false;
      qaButton.textContent = "Run QA";
    }
  });

  function renderRepair(state) {
    const failed = state.generation.jobs.filter((job) => job.state === "failed");
    const actionable = failed.filter((job) => job.project_revision === state.project.revision);
    repairPanel.hidden = !failed.length;
    if (!failed.length) return;
    if (!actionable.length) {
      replace(repairList, h("p", { class: "field-help", text: "Failed results from earlier revisions are read-only." }));
      return;
    }
    replace(repairList, actionable.map((job) => h(
      "div",
      { class: "repair-row" },
      h("p", {}, h("strong", { text: `${job.provider} / ${job.model}` }), ` · job #${shortId(job.job_id)}`),
      h("button", {
        type: "button",
        class: "button button-small",
        on: {
          click: async (event) => {
            const control = event.currentTarget;
            control.disabled = true;
            try {
              await retryGeneration(job.job_id, state.project.revision);
              announce("Rerender queued.", "success");
              await refresh();
            } catch (error) {
              control.disabled = false;
              announce(error.message, "error");
            }
          },
        },
      }, "Retry"),
    )));
  }

  function attachDownload(slot, result, option) {
    if (disposed) return null;
    revokeUrl();
    objectUrl = URL.createObjectURL(result.blob);
    const link = h("a", { href: objectUrl, download: option.filename, class: "download-link" }, icon("download"), `Download ${option.label}`);
    replace(slot, link);
    announce("Your private export is ready to download.", "success");
    return link;
  }

  function startExport(option, overwriteConfirmed, slot, trigger) {
    const project = store.getState().project;
    confirmDialog({
      title: "Confirm private export",
      body: [
        `Create a ${option.label} for revision ${project.revision}?`,
        overwriteConfirmed ? "Any earlier export of this project is replaced." : "",
      ].filter(Boolean),
      confirmText: "Create export",
      trigger,
      onConfirm: async (close) => {
        try {
          const result = await exportProject(project.project_id, project.revision, option.value, overwriteConfirmed);
          close();
          if (disposed) return;
          const link = attachDownload(slot, result, option);
          if (result.revision !== project.revision) await refresh();
          link?.focus();
        } catch (error) {
          announce(error.message, "error");
        }
      },
    });
  }

  exportButton.addEventListener("click", (event) => {
    if (!overwrite.checked) {
      announce("Tick the replace box first: Studio asks before replacing an export.", "error");
      overwrite.focus();
      return;
    }
    startExport(format, true, downloadSlot, event.currentTarget);
  });

  function renderWorkflow(state) {
    const workflow = state.workflow;
    replace(pdfSlot);
    if (!workflow) {
      workflowLine.textContent = "No production workflow for this project. Export works from whatever is accepted.";
      return;
    }
    const parts = [stateLabel(workflow.state)];
    if (workflow.state !== "complete") parts.push(phaseLabel(workflow.phase));
    if (workflow.state === "blocked") parts.push("blocked");
    if (workflow.error_category) parts.push(`reason: ${humanize(workflow.error_category)}`);
    workflowLine.textContent = `${parts.join(", ")}.`;
    if (workflow.pdf_available === true && workflow.state === "complete") {
      const pdf = FORMATS.find((option) => option.value === "pdf");
      pdfSlot.append(h("button", {
        type: "button",
        class: "button button-primary",
        on: { click: (event) => startExport(pdf, true, pdfSlot, event.currentTarget) },
      }, icon("download"), "Download composed PDF"));
    }
  }

  // An agent can stage an export request; the creator still confirms it here.
  const exportRequestHandler = (event) => {
    const requested = FORMATS.find((option) => option.value === event.detail?.format);
    if (!requested || disposed) {
      event.preventDefault();
      return;
    }
    format = requested;
    for (const input of formatGroup.querySelectorAll("input")) input.checked = input.value === requested.value;
    overwrite.checked = false;
    event.detail.accepted = true;
    announce("Your agent asked for an export. Check the settings, then confirm the download.");
    exportButton.focus();
  };
  document.addEventListener("comic-sol:export-request", exportRequestHandler);

  function update(state) {
    if (state.generation !== lastGeneration) {
      lastGeneration = state.generation;
      renderTable(state);
      renderRepair(state);
    }
    const qa = state.generation.qa || state.project.summary?.qa;
    if (qa !== lastQa) {
      lastQa = qa;
      renderQa(state);
    }
    if (state.workflow !== lastWorkflow) {
      lastWorkflow = state.workflow;
      renderWorkflow(state);
    }
    scheduleRefresh();
  }

  void refresh();

  return {
    element,
    update,
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      revokeUrl();
      document.removeEventListener("comic-sol:export-request", exportRequestHandler);
    },
  };
}
