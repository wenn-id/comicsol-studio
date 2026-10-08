// Render: the engine's handoff jobs. References come first (the creator approves each
// sheet), then one job per panel at the exact pixel size of its frame. Every job can take
// an uploaded image; a connected model can render them too.

import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { activeRuns, decisionLabel, jobStatusLabel, providerName } from "../model.js";
import { badge, busy, button, confirmDialog, emptyState, toast, toastError } from "../ui.js";

const PHASES = {
  reference: "Character references",
  panel: "Panels",
};

export function renderRender(container, ctx) {
  const project = ctx.project;
  const generation = project.generation;
  const renderers = ctx.session.providers.renderers;
  const runs = activeRuns(project);
  const busyJobs = new Set(runs.filter((run) => run.kind === "render").map((run) => run.subject));
  const batchRunning = runs.some((run) => run.kind === "render-batch");

  if (!project.plan?.storyboard) {
    mount(
      container,
      h(
        "div",
        { class: "page" },
        header(),
        emptyState("Save a plan first.", "Render jobs are written from the saved storyboard and cast.", h("a", { class: "btn btn--amber", href: ctx.projectPath(project.id, "plan"), "data-link": true }, "Open the plan")),
      ),
    );
    return;
  }

  const jobs = generation.jobs;
  const references = jobs.filter((job) => job.kind === "reference");
  const panels = jobs.filter((job) => job.kind === "panel");
  const ready = jobs.filter((job) => job.status === "ready" && !job.candidate);
  const prepare = button(generation.prepared ? "Refresh jobs" : "Prepare render jobs", { kind: generation.prepared ? "ghost" : "amber", size: generation.prepared ? "small" : undefined });
  prepare.addEventListener("click", async () => {
    try {
      await busy(prepare, () => ctx.act(() => api.prepare(project.id, project.revision)), "Preparing");
    } catch {
      // act() reported it
    }
  });

  const actions = [prepare];
  for (const renderer of renderers) {
    const all = button(`Render ${ready.length} with ${providerName(renderer.id)}`, { kind: "amber", disabled: !ready.length || batchRunning, iconName: "render" });
    all.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Render ${ready.length} ${ready.length === 1 ? "image" : "images"} with ${providerName(renderer.id)}?`,
        text: `Each job sends its prompt${ready.some((job) => job.references.length) ? " and its approved reference sheets" : ""} to ${renderer.model}. Every call is billed to the key you started Studio with. References come back for your approval; panels are accepted into the project and still need your review.`,
        confirmLabel: `Send ${ready.length} ${ready.length === 1 ? "job" : "jobs"}`,
      });
      if (!ok) return;
      try {
        await busy(all, () => api.renderReady(project.id, project.revision, renderer.id), "Starting");
        ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    });
    actions.push(all);
  }

  const batch = runs.find((run) => run.kind === "render-batch");
  mount(
    container,
    h(
      "div",
      { class: "page page--render" },
      header(h("div", { class: "page__tools" }, actions)),
      phaseBanner(project),
      batch ? h("div", { class: "banner", role: "status" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), h("p", {}, `${providerName(batch.provider)}: ${batch.message || "Queued"}`)) : null,
      !generation.prepared
        ? emptyState(
            "No render jobs yet.",
            "Preparing asks the engine to write one job per character reference sheet. After you approve those, it writes one job per panel, each carrying the identity lock and the approved references.",
          )
        : h(
            "div",
            { class: "job-sections" },
            references.length ? jobSection(ctx, "Character references", "Approve one reference sheet per character. Panels are drawn against them.", references, busyJobs) : null,
            panels.length
              ? jobSection(ctx, "Panels", "Each panel is rendered at the exact size of its frame. Uploads are center-cropped to that shape.", sortPanels(panels, project), busyJobs)
              : references.length
                ? h("p", { class: "muted" }, "Panel jobs appear after every reference sheet is approved and you refresh the jobs.")
                : null,
          ),
      renderers.length ? null : h("p", { class: "hint-line" }, "No image model is connected. Upload your own art for each job, or set OPENAI_API_KEY before starting Studio to render here."),
    ),
  );
}

function header(tools = null) {
  return h(
    "header",
    { class: "page__head" },
    h("div", {}, h("p", { class: "page__eyebrow" }, "Render"), h("h1", { class: "page__title" }, "References and panels")),
    tools,
  );
}

function phaseBanner(project) {
  const generation = project.generation;
  if (!generation.prepared) return null;
  const words = {
    "render-references": "Render and approve every character reference.",
    "render-panels": "Render every panel.",
    "visual-qa": "Every image is in. Review the panels next.",
  };
  const text = words[generation.nextAction] || (generation.nextAction ? `Engine says: ${generation.nextAction.replace(/-/g, " ")}.` : null);
  return h(
    "div",
    { class: "phase" },
    h("p", { class: "phase__name" }, `Now: ${(PHASES[generation.phase] || "rendering").toLowerCase()}`),
    text ? h("p", { class: "phase__text" }, text) : null,
    generation.scopeState && generation.scopeState !== "current" ? badge("Jobs are out of date: refresh them", "warn") : null,
  );
}

function sortPanels(jobs, project) {
  const order = new Map(project.panels.map((panel, index) => [panel.id, index]));
  return [...jobs].sort((a, b) => (order.get(a.subjectId) ?? 99) - (order.get(b.subjectId) ?? 99) || a.attempt - b.attempt);
}

function jobSection(ctx, title, text, jobs, busyJobs) {
  return h(
    "section",
    { class: "job-section", "aria-label": title },
    h("div", { class: "section-head" }, h("div", {}, h("h2", { class: "section-title" }, title), h("p", { class: "muted" }, text))),
    h("ul", { class: "jobs" }, jobs.map((job) => jobCard(ctx, job, busyJobs.has(job.jobId)))),
  );
}

function jobImage(ctx, job) {
  const project = ctx.project;
  if (job.candidate) return api.candidateUrl(project.id, job.jobId, project.revision);
  if (job.kind === "reference") return project.references.find((ref) => ref.characterId === job.subjectId)?.image || null;
  return project.panels.find((panel) => panel.id === job.subjectId)?.image || null;
}

function jobCard(ctx, job, rendering) {
  const project = ctx.project;
  const image = jobImage(ctx, job);
  const name = job.kind === "reference" ? project.references.find((ref) => ref.characterId === job.subjectId)?.name || job.subjectId : job.subjectId;
  const panel = job.kind === "panel" ? project.panels.find((entry) => entry.id === job.subjectId) : null;
  const tone = job.candidate ? "amber" : { ready: "neutral", completed: "ok", failed: "danger", stale: "warn" }[job.status] || "neutral";
  const fileInput = h("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp",
    class: "visually-hidden",
    onchange: (event) => event.target.files[0] && upload(ctx, job, event.target.files[0], card),
  });
  const card = h(
    "li",
    {
      class: `job${job.candidate ? " job--candidate" : ""}`,
      ondragover: (event) => {
        if (job.status !== "ready") return;
        event.preventDefault();
        card.dataset.over = "true";
      },
      ondragleave: () => delete card.dataset.over,
      ondrop: (event) => {
        event.preventDefault();
        delete card.dataset.over;
        const file = event.dataTransfer.files[0];
        if (file && job.status === "ready") upload(ctx, job, file, card);
      },
    },
    h(
      "div",
      { class: "job__art", style: { aspectRatio: `${job.width} / ${job.height}` } },
      image ? h("img", { src: image, alt: `${name} ${job.candidate ? "candidate" : "image"}`, loading: "lazy", decoding: "async" }) : h("span", { class: "job__empty" }, `${job.width} × ${job.height}`),
      rendering ? h("span", { class: "job__working" }, h("span", { class: "spinner spinner--small", "aria-hidden": "true" }), "Rendering") : null,
    ),
    h(
      "div",
      { class: "job__body" },
      h("div", { class: "job__head" }, h("p", { class: "job__title" }, name), badge(jobStatusLabel(job), tone)),
      h(
        "p",
        { class: "job__meta" },
        `Attempt ${job.attempt}`,
        job.attemptsRemaining !== undefined && job.attemptsRemaining !== null ? ` · ${job.attemptsRemaining} left` : "",
        panel?.decision ? ` · ${decisionLabel(panel.decision)}` : "",
      ),
      h("details", { class: "job__prompt" }, h("summary", {}, "Prompt"), h("pre", {}, job.prompt)),
      jobActions(ctx, job, rendering, fileInput),
    ),
  );
  return card;
}

function jobActions(ctx, job, rendering, fileInput) {
  const project = ctx.project;
  if (job.candidate) {
    const approve = button("Approve reference", { kind: "amber", size: "small", iconName: "check" });
    approve.addEventListener("click", async () => {
      try {
        await busy(approve, () => ctx.act(() => api.approveCandidate(project.id, project.revision, job.jobId)), "Approving");
      } catch {
        // reported
      }
    });
    const discard = button("Discard", { kind: "ghost", size: "small" });
    discard.addEventListener("click", async () => {
      try {
        await busy(discard, () => ctx.act(() => api.discardCandidate(project.id, job.jobId)));
      } catch {
        // reported
      }
    });
    return h("div", { class: "button-row" }, approve, discard);
  }
  if (job.status !== "ready") return null;
  const uploadLabel = h("label", { class: "btn btn--ghost btn--small" }, fileInput, icon("upload", 16), h("span", {}, "Upload image"));
  const renders = ctx.session.providers.renderers.map((renderer) => {
    const run = button(`Render with ${providerName(renderer.id)}`, { kind: "ghost", size: "small", disabled: rendering });
    run.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Render ${job.subjectId} with ${providerName(renderer.id)}?`,
        text: `Sends this job's prompt${job.references.length ? ` and ${job.references.length} approved reference ${job.references.length === 1 ? "sheet" : "sheets"}` : ""} to ${renderer.model}, billed to your key.`,
        confirmLabel: "Render",
      });
      if (!ok) return;
      try {
        await busy(run, () => api.renderJob(project.id, project.revision, job.jobId, renderer.id), "Starting");
        ctx.refresh();
      } catch (error) {
        toastError(error);
      }
    });
    return run;
  });
  return h("div", { class: "button-row" }, uploadLabel, renders);
}

async function upload(ctx, job, file, card) {
  const limit = ctx.session.upload.maxBytes;
  if (file.size > limit) {
    toast("That image is larger than 40 MB.", { tone: "error" });
    return;
  }
  card.setAttribute("aria-busy", "true");
  card.classList.add("job--uploading");
  try {
    await ctx.act(() => api.upload(ctx.project.id, ctx.project.revision, job.jobId, file), {
      success: job.kind === "reference" ? `Reference for ${job.subjectId} approved.` : `Panel ${job.subjectId} accepted. Review it next.`,
    });
  } catch {
    card.removeAttribute("aria-busy");
    card.classList.remove("job--uploading");
  }
}
