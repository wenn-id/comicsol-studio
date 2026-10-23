// Finish: the engine exports and verifies the PDF, writes the QA report, and binds the
// project. The finished pages can be read here as spreads, and the project exported as a
// portable archive at any stage.

import { api } from "../api.js";
import { h, icon, mount } from "../dom.js";
import { busy, button, emptyState, toast, toastError } from "../ui.js";

const readers = new Map();
const FIBERS = 25;
// One live first-edition card at a time; the view re-renders on every project update,
// so the card (and its torn state) is kept and re-attached rather than rebuilt.
let edition = null;

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
      finished && project.exports.pdf ? firstEdition(project) : null,
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

// The first edition: a foil card printed with page one and the colophon, whose perforated
// stub holds the PDF. Tearing the stub off (by slicing the seam, pulling the stub, or the
// button) downloads the PDF. Without WebGL the card is a flat print and the button
// downloads directly.
function firstEdition(project) {
  const key = `${project.id}:${project.exports.pdf}`;
  if (edition?.key === key) {
    edition.controller?.wake();
    return edition.section;
  }
  edition?.controller?.dispose();
  edition = { key, controller: null, section: null };
  const current = edition;

  const pdf = project.exports.pdf;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fibers = Array.from({ length: FIBERS }, () => h("span", { class: "edition__fiber" }));
  const meter = h("p", { class: "edition__meter", role: "status" }, `0 of ${FIBERS} fibres torn`);
  const detail = h("p", { class: "next__detail" }, "Tear the stub off to release the PDF. Slice across the perforation, pull the stub down, or use the button.");
  const stage = h("div", { class: "edition__frame" }, h("div", { class: "state state--loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("p", {}, "Printing the first edition…")));
  const face = h("p", { class: "edition__face" }, "Front · page one");

  const tear = button("Tear the stub", { kind: "amber" });
  const flip = button("Flip the card", { kind: "ghost" });
  const fresh = button("Print a fresh copy", { kind: "ghost" });
  const sound = button("Sound on", { kind: "ghost", size: "small" });
  fresh.hidden = true;

  const showSevered = (intact) => {
    fibers.forEach((fiber, i) => fiber.classList.toggle("is-torn", !intact[i]));
    const severed = intact.filter((holds) => !holds).length;
    meter.textContent = severed >= FIBERS ? "Stub released" : `${severed} of ${FIBERS} fibres torn`;
  };

  const release = () => {
    const link = h("a", { href: `${pdf}&download=1`, download: true });
    document.body.append(link);
    link.click();
    link.remove();
    detail.textContent = "Released. The PDF is downloading, and the cover is yours to keep.";
    tear.hidden = true;
    fresh.hidden = false;
    current.section.classList.add("is-released");
    toast("First edition released.", { tone: "success", detail: "The PDF is downloading." });
  };

  current.section = h(
    "section",
    { class: "edition", "aria-labelledby": "edition-title" },
    h(
      "div",
      { class: "edition__copy" },
      h("p", { class: "next__label" }, "First edition"),
      h("h2", { class: "next__title", id: "edition-title" }, "Tear it to release it"),
      detail,
      h("div", { class: "edition__fibers", "aria-hidden": "true" }, fibers),
      meter,
      h("div", { class: "button-row" }, tear, fresh, flip),
      h("div", { class: "edition__meta" }, face, sound),
    ),
    stage,
  );

  const webgl = (() => {
    try {
      const probe = document.createElement("canvas");
      return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
    } catch {
      return false;
    }
  })();

  (async () => {
    const [{ drawFront, formatDate }, { TearSound }] = await Promise.all([import("../edition/textures.js"), import("../edition/sound.js")]);
    const tearSound = new TearSound();
    const paintSound = () => {
      sound.querySelector("span").textContent = tearSound.enabled ? "Sound on" : "Sound off";
      sound.setAttribute("aria-pressed", String(tearSound.enabled));
    };
    paintSound();
    sound.addEventListener("click", () => {
      tearSound.setEnabled(!tearSound.enabled);
      paintSound();
    });

    const cover = await loadImage(project.pages[0]?.image);
    await Promise.race([
      Promise.all([document.fonts.load('800 80px "Manrope"'), document.fonts.load('700 20px "Manrope"')]),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (edition !== current) return;
    const printed = {
      title: project.title || project.engineTitle || "Untitled",
      serial: project.id,
      pages: project.pages.length,
      panels: project.panels.length,
      language: project.source?.language,
      bound: formatDate(project.updatedAt),
      warnings: project.warnings.length,
      cover,
    };

    if (!webgl) {
      const flat = drawFront(printed).color;
      flat.classList.add("edition__flat");
      flat.setAttribute("role", "img");
      flat.setAttribute("aria-label", `First edition card for ${printed.title}`);
      mount(stage, flat);
      flip.hidden = true;
      face.hidden = true;
      tear.addEventListener("click", () => {
        showSevered(new Array(FIBERS).fill(false));
        release();
      });
      fresh.addEventListener("click", () => {
        showSevered(new Array(FIBERS).fill(true));
        tear.hidden = false;
        fresh.hidden = true;
        current.section.classList.remove("is-released");
        detail.textContent = "Tear the stub off to release the PDF.";
      });
      return;
    }

    const { createEdition } = await import("../edition/edition.js");
    if (edition !== current) return;
    const controller = createEdition(printed, {
      still,
      sound: tearSound,
      onSnap: showSevered,
      onRelease: release,
      onFace: (side) => {
        face.textContent = side === "front" ? "Front · page one" : "Back · colophon";
      },
    });
    current.controller = controller;
    mount(stage, controller.element);
    controller.wake();
    tear.addEventListener("click", () => controller.tear());
    flip.addEventListener("click", () => controller.flip());
    fresh.addEventListener("click", () => {
      controller.reset();
      tear.hidden = false;
      fresh.hidden = true;
      current.section.classList.remove("is-released");
      detail.textContent = "A fresh copy. Tear the stub off again to download the PDF once more.";
    });
  })().catch((error) => {
    mount(stage, emptyState("The first edition could not be printed.", error?.message || "Use Download the PDF above instead."));
  });

  return current.section;
}

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
