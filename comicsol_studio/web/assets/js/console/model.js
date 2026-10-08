// Pure project logic for the console: lifecycle, the next step, labels, and formatting.
// No DOM access, so Node tests exercise it directly.

export const LIFECYCLE = [
  "INIT",
  "PLANNED",
  "SCRIPTED",
  "STORYBOARDED",
  "REFERENCES_READY",
  "PANELS_READY",
  "QA_READY",
  "LETTERED",
  "COMPOSED",
  "EXPORTED",
  "COMPLETE",
];

const STATUS_LABELS = {
  INIT: "Needs a plan",
  PLANNED: "Planned",
  SCRIPTED: "Scripted",
  STORYBOARDED: "Ready to render",
  REFERENCES_READY: "References approved",
  PANELS_READY: "Panels rendered",
  QA_READY: "Panels accepted",
  LETTERED: "Lettered",
  COMPOSED: "Pages composed",
  EXPORTED: "Exported",
  COMPLETE: "Finished",
  COMPLETE_WITH_WARNINGS: "Finished with warnings",
  BLOCKED: "Blocked",
  UNREADABLE: "Files unreadable",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Unknown";
}

export function lifecycleIndex(status) {
  if (status === "COMPLETE_WITH_WARNINGS") return LIFECYCLE.length - 1;
  return LIFECYCLE.indexOf(status);
}

export const STAGES = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "plan", label: "Plan", icon: "plan" },
  { id: "render", label: "Render", icon: "render" },
  { id: "review", label: "Review", icon: "review" },
  { id: "finish", label: "Finish", icon: "finish" },
];

const finished = (status) => status === "COMPLETE" || status === "COMPLETE_WITH_WARNINGS";

// What each stage looks like right now: "done", "current", "waiting", or "locked".
export function stageStates(project) {
  const status = project.status;
  const hasPlan = Boolean(project.plan?.storyboard);
  const panels = project.panels || [];
  const accepted = panels.length > 0 && panels.every((panel) => panel.decision === "accept" || panel.decision === "accept-warning");
  const rendered = panels.length > 0 && panels.every((panel) => panel.image);
  const composed = (project.pages || []).length > 0 && project.pages.every((page) => page.image);
  return {
    overview: "done",
    plan: hasPlan ? "done" : "current",
    render: !hasPlan ? "locked" : rendered ? "done" : "current",
    review: !rendered ? (hasPlan ? "waiting" : "locked") : accepted && project.pagesReviewed ? "done" : "current",
    finish: finished(status) ? "done" : project.pagesReviewed ? "current" : "waiting",
  };
}

// The single most useful thing to do next, with the stage that does it.
export function nextStep(project) {
  const status = project.status;
  const panels = project.panels || [];
  const jobs = project.generation?.jobs || [];
  if (status === "BLOCKED") {
    return { stage: "overview", title: "The engine blocked this project", detail: project.blockedReason || "See the activity log for the reason." };
  }
  if (!project.plan?.storyboard) {
    return { stage: "plan", title: "Write the plan", detail: "Story, cast, and storyboard. The engine validates every field before anything renders." };
  }
  if (finished(status)) {
    return { stage: "finish", title: "Your comic is bound", detail: "Download the verified PDF or export a portable archive." };
  }
  const candidates = jobs.filter((job) => job.candidate);
  if (candidates.length) {
    return { stage: "render", title: `Approve ${candidates.length} reference ${candidates.length === 1 ? "sheet" : "sheets"}`, detail: "A model drew them; they are used only after you approve." };
  }
  const ready = jobs.filter((job) => job.status === "ready");
  const unreviewed = panels.filter((panel) => panel.image && !panel.decision);
  const stale = panels.filter((panel) => panel.decision === "stale");
  const rejected = panels.filter((panel) => panel.decision === "regenerate");
  if (unreviewed.length || stale.length) {
    const first = (unreviewed[0] || stale[0]).id;
    return { stage: "review", panel: first, title: `Review panel ${first}`, detail: `${unreviewed.length + stale.length} of ${panels.length} panels wait for your review.` };
  }
  if (!project.generation?.prepared || (!ready.length && (rejected.length || panels.some((panel) => !panel.image)))) {
    return { stage: "render", title: "Prepare render jobs", detail: "The engine writes one job per reference sheet, then one per panel." };
  }
  if (ready.length) {
    const kind = ready[0].kind === "reference" ? "reference sheets" : "panels";
    return { stage: "render", title: `Render ${ready.length} ${kind}`, detail: "Upload your own art or render with a connected model." };
  }
  if (status === "QA_READY" || status === "LETTERED") {
    return { stage: "review", title: "Letter and compose the pages", detail: "The engine draws every balloon and assembles the pages." };
  }
  const pageToReview = (project.pages || []).find((page) => page.image && !["accept", "accept-warning"].includes(page.decision));
  if (pageToReview) {
    return { stage: "review", page: pageToReview.number, title: `Review page ${pageToReview.number}`, detail: "Check balloons, tails, and stray text on the composed page." };
  }
  if (project.pagesReviewed) {
    return { stage: "finish", title: "Finish the comic", detail: "The engine exports the PDF, verifies every page, and writes the QA report." };
  }
  return { stage: "overview", title: "Check the project", detail: "Studio could not find an obvious next step." };
}

export function decisionLabel(decision) {
  return (
    {
      accept: "Accepted",
      "accept-warning": "Accepted with warnings",
      regenerate: "Sent back",
      stale: "Review outdated",
    }[decision] || "Not reviewed"
  );
}

export function jobStatusLabel(job) {
  if (job.candidate) return "Waiting for approval";
  return { ready: "Ready", completed: "Done", failed: "Failed", stale: "Outdated", missing: "Missing" }[job.status] || job.status;
}

export function relativeTime(seconds, now = Date.now() / 1000) {
  const delta = Math.max(0, now - seconds);
  if (delta < 45) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  if (delta < 86400 * 14) return `${Math.round(delta / 86400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

export function activeRuns(project) {
  return (project.runs || []).filter((run) => run.status === "queued" || run.status === "running");
}

export function providerName(id) {
  return { anthropic: "Claude", openai: "OpenAI" }[id] || id;
}
