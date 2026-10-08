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
import { WORKFLOW_PHASES, clockTime, humanize, phaseLabel, plural, shortId, stateLabel } from "../format.js";
import {
  LANES,
  availableActions,
  costText,
  displayState,
  groupJobs,
  hasActiveJobs,
  queueOutcome,
  routeFingerprint,
} from "../jobs-model.js";
import { confirmDialog } from "../dialogs.js";

const REFRESH_MS = 2000;

function chip(label, control, extraClass = "") {
  return h("label", { class: `chip ${extraClass}`.trim() }, h("span", { class: "chip-label", text: label }), control);
}
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

  // Render bar: route, authentication, and the cost confirmation, docked to
  // the bottom of the screen like a prompt composer.
  const route = h("select", { id: "generation-route", name: "route" });
  const auth = h("select", { id: "generation-auth-mode", name: "auth_mode" });
  const reasons = h("ul", { class: "reason-list", id: uid("reasons") });
  const costLine = h("span", { class: "cost-line", id: "cost-guidance", text: UNKNOWN_COST });
  const costConfirmation = h("input", { id: "cost-confirmation", name: "cost_confirmation", type: "checkbox" });
  const confirmLabel = h("span", { text: "I accept this cost status for the selected route." });
  const submitLabel = h("span", { class: "generate-label", text: "Queue" });
  const submit = h("button", { type: "submit", class: "button-generate", disabled: true }, submitLabel, icon("play"));
  const routeEmpty = h("p", {
    class: "composer-help",
    hidden: true,
    text: "No render route can run in this Studio. Start Studio with an image provider key, or with --agent-images for an agent session, then reload this stage.",
  });

  const form = h(
    "form",
    { class: "composer render-bar", "aria-describedby": "cost-guidance" },
    h(
      "div",
      { class: "composer-bar" },
      chip("Route", route, "chip-wide"),
      chip("Auth", auth),
      h("details", { class: "why" }, h("summary", { text: "Why this route" }), reasons),
      h("span", { class: "composer-spacer" }),
      submit,
    ),
    h(
      "div",
      { class: "cost-row" },
      costLine,
      h("label", { class: "confirm-chip", for: "cost-confirmation" }, costConfirmation, confirmLabel),
    ),
    routeEmpty,
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
        h("h1", { class: "display display-md", text: "Render the panels" }),
        h("p", { class: "stage-lede", text: "Pick one route, confirm its cost, and watch the board. Results wait for your approval before they count." }),
      ),
      h("div", { class: "stage-tools" }, h("button", { type: "button", class: "button", on: { click: () => navigate("review") } }, "Open the light table")),
    ),
    workflowPanel,
    boardPanel,
    h("div", { class: "composer-dock" }, form),
  );

  // Route selection: changing the route or the authentication mode always
  // clears the cost confirmation, so it only ever covers the exact route shown.
  function renderAuthModes() {
    const modes = Array.isArray(selected?.auth_modes) ? selected.auth_modes : [];
    if (!modes.includes(authMode)) authMode = modes[0] || "";
    auth.replaceChildren(...modes.map((mode) => h("option", { value: mode, selected: mode === authMode, text: humanize(mode) })));
    if (!modes.length) auth.append(h("option", { value: "", text: "None" }));
    auth.disabled = !modes.length;
  }

  function renderRoutes() {
    routeEmpty.hidden = options.length > 0;
    route.replaceChildren(...options.map((option, index) => h("option", {
      value: String(index),
      selected: option === selected,
      text: `${option.provider} / ${option.model}`,
    })));
    if (!options.length) route.append(h("option", { value: "", text: "No route available" }));
    route.disabled = !options.length;
  }

  route.addEventListener("change", () => {
    selected = options[Number(route.value)] || null;
    renderAuthModes();
    resetConfirmation();
  });
  auth.addEventListener("change", () => {
    authMode = auth.value;
    resetConfirmation();
  });

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
    submitLabel.textContent = "Queueing…";
    try {
      const result = await queueGeneration(project.project_id, project.revision, {
        provider: selected.provider,
        model: selected.model,
        auth_mode: authMode,
      });
      const outcome = queueOutcome(result?.jobs);
      if (outcome.fresh) {
        announce(`Queued ${plural(outcome.fresh, "job")}. Watch it on the render board.`, "success");
      } else if (outcome.existing) {
        announce(
          `Nothing new was queued: this route already has ${plural(outcome.existing, "job")} for revision ${project.revision} (${outcome.existingStates.map((state) => stateLabel(state).toLowerCase()).join(", ")}). Retry a failed job from the board, or save a changed plan to start a new revision.`,
          "error",
        );
      } else {
        announce("The server queued nothing for this route.", "error");
      }
      resetConfirmation();
      await refresh();
    } catch (error) {
      announce(error.message, "error");
      submit.disabled = !confirmed;
    } finally {
      submitLabel.textContent = "Queue";
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
      count.dataset.count = String(jobs.length);
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
