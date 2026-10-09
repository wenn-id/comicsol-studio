// Finish: the engine exports and verifies the PDF, writes the QA report, and binds the
// project. The finished pages can be read here as spreads, and the project exported as a
// portable archive at any stage.

import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { busy, button, emptyState, toast, toastError } from "../ui.js";

const readers = new Map();

export function renderFinish(container, ctx) {
  const project = ctx.project;
  const finished = project.status === "COMPLETE" || project.status === "COMPLETE_WITH_WARNINGS";
  const composed = project.pages.length > 0 && project.pages.every((page) => page.image);

  const finalize = button("Finish the comic", { kind: "amber", disabled: !project.pagesReviewed || finished });
  finalize.addEventListener("click", async () => {
    try {
      await busy(finalize, () => ctx.act(() => api.finalize(project.id, project.revision), { success: "The engine exported and verified the PDF." }), "Binding");
    } catch {
      // reported
    }
  });

  const archive = button("Export a portable archive", { kind: "ghost", iconName: "download" });
  archive.addEventListener("click", async () => {
    try {
      const response = await busy(archive, () => api.exportArchive(project.id), "Exporting");
      const blob = await response.blob();
      const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || `comic${ctx.session.archiveSuffix}`;
      const url = URL.createObjectURL(blob);
      const link = h("a", { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`Saved ${name}.`, { tone: "success", detail: "Import it in any Comic Sol install, or give it to an agent to continue the work." });
    } catch (error) {
      toastError(error);
    }
  });

  let status;
  if (finished) status = h("p", { class: "next__detail" }, project.status === "COMPLETE" ? "PDF verified. No warnings in the review report." : `PDF verified with ${project.warnings.length} ${project.warnings.length === 1 ? "warning" : "warnings"} recorded in the QA report.`);
  else if (project.pagesReviewed) status = h("p", { class: "next__detail" }, "All pages are reviewed. Finish the comic to export a verified PDF and review report.");
  else status = h("p", { class: "next__detail" }, "Review and accept each composed page before exporting the PDF.");

  mount(
    container,
    h(
      "div",
      { class: "page page--finish" },
      h("header", { class: "page__head" }, h("div", {}, h("p", { class: "page__eyebrow" }, "Finish"), h("h1", { class: "page__title" }, finished ? "Ready to print" : "Export your comic"))),
      h(
        "section",
        { class: "next", "aria-label": "Binding" },
        status,
        h(
          "div",
          { class: "button-row" },
          finished ? null : finalize,
          project.exports.pdf ? h("a", { class: "btn btn--amber", href: `${project.exports.pdf}&download=1`, download: true }, icon("download", 16), h("span", {}, "Download the PDF")) : null,
          project.exports.pdf ? h("a", { class: "btn btn--ghost", href: project.exports.pdf, target: "_blank", rel: "noopener" }, "Open the PDF") : null,
          project.exports.report ? h("a", { class: "btn btn--ghost", href: project.exports.report, target: "_blank", rel: "noopener" }, "QA report") : null,
        ),
      ),
      composed ? reader(ctx) : emptyState("No composed pages yet.", "Pages appear here after the engine letters and composes them on the Review stage."),
      h(
        "section",
        { class: "panel-box", "aria-labelledby": "archive-title" },
        h("h2", { class: "section-title", id: "archive-title" }, "Take the project anywhere"),
        h("p", { class: "muted" }, `A ${ctx.session.archiveSuffix} archive holds the plan, the prompts, every accepted image, and the review records. The engine checks it again on import.`),
        archive,
      ),
      project.warnings.length
        ? h("section", { class: "panel-box panel-box--warn" }, h("h2", { class: "section-title" }, "Warnings"), h("ul", { class: "plain-list" }, project.warnings.map((warning) => h("li", {}, warning))))
        : null,
    ),
  );
}

// A spread reader: page 1 alone (like a cover), then pairs, as a printed comic reads.
function reader(ctx) {
  const pages = ctx.project.pages;
  const spreads = [[pages[0]]];
  for (let index = 1; index < pages.length; index += 2) spreads.push(pages.slice(index, index + 2));
  let current = Math.min(readers.get(ctx.project.id) || 0, spreads.length - 1);
  const stage = h("div", { class: "reader__stage", "aria-live": "polite" });
  const label = h("p", { class: "reader__label" });
  const prev = button("Previous", { kind: "ghost", size: "small", iconName: "arrowLeft" });
  const next = button("Next", { kind: "ghost", size: "small" });
  const draw = () => {
    readers.set(ctx.project.id, current);
    const spread = spreads[current];
    mount(stage, spread.map((page) => h("img", { class: "reader__page", src: page.image, alt: `Page ${page.number}` })));
    label.textContent = spread.length === 1 ? `Page ${spread[0].number} of ${pages.length}` : `Pages ${spread[0].number} and ${spread[1].number} of ${pages.length}`;
    prev.disabled = current === 0;
    next.disabled = current === spreads.length - 1;
  };
  prev.addEventListener("click", () => {
    current -= 1;
    draw();
  });
  next.addEventListener("click", () => {
    current += 1;
    draw();
  });
  const element = h(
    "section",
    {
      class: "reader",
      "aria-label": "Read the comic",
      tabindex: "0",
      onkeydown: (event) => {
        if (event.key === "ArrowRight" && current < spreads.length - 1) current += 1;
        else if (event.key === "ArrowLeft" && current > 0) current -= 1;
        else return;
        event.preventDefault();
        draw();
      },
    },
    stage,
    h("div", { class: "reader__controls" }, prev, label, next),
  );
  draw();
  return element;
}
