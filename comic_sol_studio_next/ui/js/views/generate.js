// Generate: pick a render route, sign the cost slate, and run the render board.

import {
  approveProposal,
  cancelGeneration,
  getGenerationOptions,
  getGenerationRecommendations,
  getProject,
  getWorkflow,
  listGenerationJobs,
  pauseForSwitch,
  pauseWorkflow,
  queueGeneration,
  rejectProposal,
  resumeWorkflow,
  retryGeneration,
  submitStagedRaster,
} from "/static/api.js";
import { h, icon, replace, uid } from "../dom.js";
import { WORKFLOW_PHASES, clockTime, humanize, phaseLabel, shortId, stateLabel } from "../format.js";
import {
  LANES,
  availableActions,
  costText,
  displayState,
  groupJobs,
  hasActiveJobs,
  routeFingerprint,
} from "../jobs-model.js";
import { confirmDialog } from "../dialogs.js";

const REFRESH_MS = 2000;
const UNKNOWN_COST = "Estimated cost is unknown. Confirm only if you accept that uncertainty.";

export function mountGenerateView({ store, announce, navigate }) {
  let options = [];
  let selected = null;
  let authMode = "";
  let confirmed = null;
  let disposed = false;
  let refreshTimer = null;
  let recommendationFor = null;
  const UNSET = Symbol("unset");
  let lastJobs = UNSET;
  let lastWorkflow = UNSET;

  // Route picker
  const routeList = h("div", { class: "route-list", role: "radiogroup", "aria-label": "Render route" });
  const authGroup = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Authentication mode" });
  const reasons = h("ul", { class: "reason-list", id: uid("reasons") });
  const costLine = h("p", { class: "slate-cost", id: "cost-guidance", text: UNKNOWN_COST });
  const costConfirmation = h("input", { id: "cost-confirmation", name: "cost_confirmation", type: "checkbox" });
  const confirmLabel = h("span", { text: "I accept this cost status for the selected route." });
  const submit = h("button", { type: "submit", class: "button button-primary", disabled: true }, "Queue generation");
  const routeEmpty = h("div", { class: "state-note", hidden: true });

  const form = h(
    "form",
    { class: "panel panel-marked route-panel", "aria-describedby": "cost-guidance" },
    h("header", { class: "panel-head" }, h("p", { class: "eyebrow", text: "Route / Cost" }), h("h2", { text: "Choose a render route" })),
    routeEmpty,
    routeList,
    h("div", { class: "field" }, h("p", { class: "field-label", text: "Authentication mode" }), authGroup),
    h(
      "div",
      { class: "slate" },
      h("p", { class: "slate-title", text: "Cost slate" }),
      costLine,
      h("details", { class: "reasons" }, h("summary", { text: "Why this route" }), reasons),
      h("label", { class: "confirm-row", for: "cost-confirmation" }, costConfirmation, confirmLabel),
      submit,
    ),
  );

  // Workflow strip
  const pipeline = h("ol", { class: "pipeline", "aria-label": "Production phases" });
  const workflowNote = h("p", { class: "field-help" });
  const pauseButton = h("button", { type: "button", class: "button", disabled: true }, icon("pause"), "Pause");
  const resumeButton = h("button", { type: "button", class: "button", disabled: true }, icon("play"), "Resume");
  const workflowPanel = h(
    "section",
    { class: "panel workflow-panel", "aria-labelledby": "workflow-strip-heading" },
    h(
      "header",
      { class: "panel-head panel-head-row" },
      h("div", {}, h("p", { class: "eyebrow", text: "Production" }), h("h2", { id: "workflow-strip-heading", text: "Workflow" })),
      h("div", { class: "actions" }, pauseButton, resumeButton),
    ),
    pipeline,
    workflowNote,
  );

  // Render board
  const liveStamp = h("p", { class: "live-stamp", "aria-live": "off" });
  const laneNodes = {};
  const board = h(
    "div",
    { class: "lanes", "aria-live": "polite" },
    LANES.map((lane) => {
      const count = h("span", { class: "lane-count", text: "0" });
      const list = h("ol", { class: "lane-list" });
      laneNodes[lane.key] = { count, list, lane };
      return h(
        "section",
        { class: `lane lane-${lane.key}`, "aria-label": lane.title },
        h("header", { class: "lane-head" }, h("h3", { text: lane.title }), count),
        list,
      );
    }),
  );
  const boardPanel = h(
    "section",
    { class: "panel board-panel", "aria-labelledby": "board-heading" },
    h(
      "header",
      { class: "panel-head panel-head-row" },
      h("div", {}, h("p", { class: "eyebrow", text: "Jobs" }), h("h2", { id: "board-heading", text: "Render board" })),
      liveStamp,
    ),
    board,
  );

  const element = h(
    "div",
    { class: "view view-generate" },
    h(
      "header",
      { class: "stage-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow", text: "03 / Generate" }),
        h("h1", { text: "Render the panels" }),
        h("p", { class: "stage-lede", text: "Pick one route, sign the cost slate, and watch the board. Results wait for your approval before they count." }),
      ),
      h("div", { class: "stage-tools" }, h("button", { type: "button", class: "button", on: { click: () => navigate("review") } }, "Open the light table")),
    ),
    h("div", { class: "generate-layout" }, form, h("div", { class: "generate-main" }, workflowPanel, boardPanel)),
  );

  // Route selection
  function renderAuthModes() {
    const modes = Array.isArray(selected?.auth_modes) ? selected.auth_modes : [];
    if (!modes.includes(authMode)) authMode = modes[0] || "";
    const name = uid("auth");
    replace(authGroup, modes.map((mode) => {
      const id = uid("auth-mode");
      const input = h("input", { id, type: "radio", name, value: mode, class: "visually-hidden", checked: mode === authMode });
      input.addEventListener("change", () => {
        authMode = mode;
        resetConfirmation();
      });
      return [input, h("label", { for: id, text: humanize(mode) })];
    }));
    if (!modes.length) authGroup.append(h("p", { class: "field-help", text: "Choose a route first." }));
  }

  function renderRoutes() {
    routeEmpty.hidden = options.length > 0;
    if (!options.length) {
      replace(routeEmpty, h("p", { text: "No render route can run in this Studio. Start Studio with an image provider key, or connect an agent session, then reload this stage." }));
    }
    const name = uid("route");
    replace(routeList, options.map((option) => {
      const id = uid("route-option");
      const input = h("input", { id, type: "radio", name, class: "visually-hidden", checked: option === selected });
      input.addEventListener("change", () => {
        selected = option;
        renderAuthModes();
        resetConfirmation();
      });
      return [
        input,
        h(
          "label",
          { for: id, class: "route-card" },
          h("span", { class: "route-provider", text: option.provider }),
          h("span", { class: "route-model", text: option.model }),
          h("span", { class: "route-caps", text: (option.capabilities || []).map(humanize).join(" · ") || "No capabilities declared" }),
        ),
      ];
    }));
  }

  function resetConfirmation() {
    costConfirmation.checked = false;
    costConfirmation.disabled = !selected || !authMode;
    confirmed = null;
    submit.disabled = true;
    confirmLabel.textContent = selected
      ? `I accept this cost status for ${selected.provider} / ${selected.model}${authMode ? ` (${humanize(authMode)})` : ""}.`
      : "I accept this cost status for the selected route.";
  }

  costConfirmation.addEventListener("change", () => {
    confirmed = costConfirmation.checked ? routeFingerprint(selected, authMode) : null;
    submit.disabled = !confirmed;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fingerprint = routeFingerprint(selected, authMode);
    if (!costConfirmation.checked || !fingerprint || confirmed !== fingerprint) {
      announce("Confirm the cost status for this exact route before queueing.", "error");
      resetConfirmation();
      costConfirmation.focus();
      return;
    }
    const project = store.getState().project;
    submit.disabled = true;
    submit.textContent = "Queueing…";
    try {
      await queueGeneration(project.project_id, project.revision, {
        provider: selected.provider,
        model: selected.model,
        auth_mode: authMode,
      });
      announce("Generation queued. It appears on the render board.", "success");
      resetConfirmation();
      await refresh();
    } catch (error) {
      announce(error.message, "error");
      submit.disabled = !confirmed;
    } finally {
      submit.textContent = "Queue generation";
    }
  });

  // Data
  async function syncProjectAndJobs() {
    const current = store.getState().project;
    const project = await getProject(current.project_id);
    const result = await listGenerationJobs(project.project_id, project.revision);
    if (disposed) return project;
    store.replaceProjectAndGenerationJobs(
      project,
      Array.isArray(result.jobs) ? result.jobs : [],
      result.accepted_job ?? null,
    );
    return project;
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    try {
      await syncProjectAndJobs();
      await syncWorkflow();
      liveStamp.textContent = `Updated ${clockTime(new Date())}`;
    } catch (error) {
      liveStamp.textContent = "Board could not refresh";
      announce(error.message, "error");
    }
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (disposed) return;
    const state = store.getState();
    const running = hasActiveJobs(state.generation.jobs) || state.workflow?.state === "running";
    if (running) refreshTimer = setTimeout(refresh, REFRESH_MS);
  }

  // A project without an approved workflow answers 404; ask once per visit
  // instead of on every board refresh.
  let workflowMissing = false;
  async function syncWorkflow() {
    const project = store.getState().project;
    if (workflowMissing) return null;
    try {
      const result = await getWorkflow(project.project_id);
      if (!disposed) store.setWorkflow(result.workflow);
      return result.workflow;
    } catch (error) {
      if (Number(error?.status) === 404) workflowMissing = true;
      return null;
    }
  }

  async function loadRecommendation(state) {
    const job = state.generation.jobs[0];
    if (!job || recommendationFor === job.job_id) return;
    recommendationFor = job.job_id;
    try {
      const result = await getGenerationRecommendations(state.project.project_id, state.project.revision, job.job_id);
      if (disposed) return;
      const recommendation = result.recommendations?.[0];
      if (!recommendation) return;
      replace(reasons, (recommendation.reasons || []).map((reason) => h("li", { text: reason })));
      costLine.textContent = costText(recommendation.estimated_cost)
        ? `Estimated cost: ${costText(recommendation.estimated_cost)}.`
        : UNKNOWN_COST;
    } catch {
      recommendationFor = null;
    }
  }

  // Workflow controls
  pauseButton.addEventListener("click", async () => {
    const project = store.getState().project;
    pauseButton.disabled = true;
    try {
      await pauseWorkflow(project.project_id, project.revision);
      announce("Workflow paused. Nothing new starts until you resume.", "success");
      await refresh();
    } catch (error) {
      announce(error.message, "error");
      renderWorkflow(store.getState());
    }
  });
  resumeButton.addEventListener("click", async () => {
    const project = store.getState().project;
    resumeButton.disabled = true;
    try {
      await resumeWorkflow(project.project_id, project.revision);
      announce("Workflow resumed.", "success");
      await refresh();
    } catch (error) {
      announce(error.message, "error");
      renderWorkflow(store.getState());
    }
  });

  function renderWorkflow(state) {
    const workflow = state.workflow;
    pauseButton.disabled = !workflow?.can_pause;
    resumeButton.disabled = !workflow?.can_resume;
    workflowPanel.dataset.state = workflow?.state || "none";
    if (!workflow) {
      replace(pipeline);
      workflowNote.textContent = "No production workflow yet. Approve the plan in Plan to run every phase in order, or queue a single route here.";
      return;
    }
    const currentIndex = WORKFLOW_PHASES.findIndex(([key]) => key === workflow.phase);
    const complete = workflow.state === "complete";
    replace(pipeline, WORKFLOW_PHASES.map(([key, label], index) => {
      let phaseState = "todo";
      if (complete || (currentIndex >= 0 && index < currentIndex)) phaseState = "done";
      else if (index === currentIndex) phaseState = workflow.state;
      return h(
        "li",
        { class: "phase", "data-state": phaseState, "aria-current": index === currentIndex && !complete ? "step" : null },
        h("span", { class: "phase-mark", "aria-hidden": "true" }),
        h("span", { class: "phase-name", text: label }),
      );
    }));
    const route = [workflow.image_provider, workflow.image_model].filter(Boolean).join(" / ");
    const parts = [`${stateLabel(workflow.state)}${currentIndex >= 0 && !complete ? `, ${phaseLabel(workflow.phase)}` : ""}.`];
    if (route) parts.push(`Images: ${route}.`);
    if (workflow.error_category) parts.push(`Reason: ${humanize(workflow.error_category)}.`);
    if (workflow.state === "blocked") parts.push("Fix the reason, then resume.");
    workflowNote.textContent = parts.join(" ");
  }

  // Board
  async function runAction(operation, success) {
    try {
      await operation();
      announce(success, "success");
      await refresh();
    } catch (error) {
      announce(error.message, "error");
    }
  }

  function jobCard(job, project) {
    const state = displayState(job);
    const actions = availableActions(job, project.revision);
    const buttons = actions.map((action) => {
      if (action === "promote") {
        return h("button", {
          type: "button",
          class: "button button-primary button-small",
          on: {
            click: (event) => confirmDialog({
              title: "Confirm promotion",
              body: [
                "Promote this staged raster as the accepted result for the current panel?",
                "The previously accepted raster stays on file until this promotion succeeds.",
              ],
              confirmText: "Promote staged raster",
              trigger: event.currentTarget,
              onConfirm: async (close) => {
                try {
                  await submitStagedRaster(job.job_id, project.revision);
                  close();
                  announce("Staged raster promoted.", "success");
                  await refresh();
                } catch (error) {
                  announce(error.message, "error");
                }
              },
            }),
          },
        }, "Promote");
      }
      if (action === "retry") {
        return h("button", {
          type: "button",
          class: "button button-small",
          on: { click: () => runAction(() => retryGeneration(job.job_id, project.revision), "Retry queued.") },
        }, "Retry");
      }
      if (action === "cancel") {
        return h("button", {
          type: "button",
          class: "button button-small button-quiet",
          on: { click: () => runAction(() => cancelGeneration(job.job_id, project.revision), "Generation cancelled.") },
        }, "Cancel");
      }
      return h("button", {
        type: "button",
        class: "button button-small",
        on: {
          click: async (event) => {
            const trigger = event.currentTarget;
            try {
              const proposal = await pauseForSwitch(job.job_id, project.revision);
              confirmDialog({
                title: "Confirm provider switch",
                body: `Switch this job from ${proposal.from_provider} to ${proposal.to_provider} / ${proposal.to_model}? The new route may cost differently.`,
                confirmText: "Switch provider",
                cancelText: "Keep current provider",
                trigger,
                onConfirm: async (close) => {
                  try {
                    await approveProposal(proposal.proposal_id, project.project_id, project.revision);
                    close();
                    announce("Provider switch approved.", "success");
                    await refresh();
                  } catch (error) {
                    announce(error.message, "error");
                  }
                },
                onCancel: async (close) => {
                  try {
                    await rejectProposal(proposal.proposal_id, project.project_id, project.revision);
                    close();
                    announce("Switch declined; the current provider stays.");
                    await refresh();
                  } catch (error) {
                    announce(error.message, "error");
                  }
                },
              });
            } catch (error) {
              announce(error.message, "error");
            }
          },
        },
      }, "Switch provider");
    });
    const historical = job.project_revision !== project.revision;
    // The agent route has no remote provider: the creator's own agent session supplies the raster.
    const waitingOnAgent = job.provider === "agent" && (state === "polling" || state === "running");
    return h(
      "li",
      { class: "job", "data-state": state },
      h(
        "div",
        { class: "job-top" },
        h("span", { class: "job-state", text: waitingOnAgent ? "Waiting for your agent" : stateLabel(state) }),
        h("span", { class: "job-id", text: `#${shortId(job.job_id)}` }),
      ),
      h("p", { class: "job-route", text: `${job.provider} / ${job.model}` }),
      h(
        "p",
        { class: "job-meta", text: [
          humanize(job.auth_mode),
          `attempt ${job.attempt || 1}`,
          `retries ${job.retry_count || 0} of ${job.max_retries || 0}`,
          historical ? `from revision ${job.project_revision}` : "",
        ].filter(Boolean).join(" · ") },
      ),
      buttons.length ? h("div", { class: "job-actions" }, buttons) : null,
    );
  }

  function renderBoard(state) {
    const lanes = groupJobs(state.generation.jobs, state.project.revision);
    for (const { lane, count, list } of Object.values(laneNodes)) {
      const jobs = lanes[lane.key];
      count.textContent = String(jobs.length);
      replace(list, jobs.length
        ? jobs.map((job) => jobCard(job, state.project))
        : h("li", { class: "lane-empty", text: lane.empty }));
    }
  }

  async function loadOptions() {
    try {
      const result = await getGenerationOptions();
      options = Array.isArray(result.options) ? result.options : [];
    } catch (error) {
      options = [];
      announce(error.message, "error");
    }
    if (disposed) return;
    selected = options[0] || null;
    renderRoutes();
    renderAuthModes();
    resetConfirmation();
  }

  function update(state) {
    if (state.generation.jobs !== lastJobs) {
      lastJobs = state.generation.jobs;
      renderBoard(state);
      void loadRecommendation(state);
    }
    if (state.workflow !== lastWorkflow) {
      lastWorkflow = state.workflow;
      renderWorkflow(state);
    }
    scheduleRefresh();
  }

  renderRoutes();
  renderAuthModes();
  void loadOptions();
  void refresh();

  return {
    element,
    update,
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
    },
  };
}
