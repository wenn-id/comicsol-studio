// Landing page wiring: scroll progress drives the book and the chapter captions. With
// reduced motion the book is shown open as a still; without WebGL the cover is a poster.

import { chapterAt } from "./timeline.js";
import { LAYOUTS, drawCover, fontsReady } from "./textures.js";

const hero = document.querySelector("[data-hero]");
const canvas = document.querySelector("[data-book-canvas]");
const poster = document.querySelector("[data-poster]");
const progressFill = document.querySelector("[data-progress]");
const scrollHint = document.querySelector("[data-scroll-hint]");
const masthead = document.querySelector("[data-masthead]");
const copy = hero.querySelector(".hero__copy");
const chapters = [...hero.querySelectorAll(".chapter")];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(pointer: fine)");

function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

function heroProgress() {
  const rect = hero.getBoundingClientRect();
  const travel = hero.offsetHeight - window.innerHeight;
  return travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
}

function showChapter(index) {
  copy.dataset.active = String(index === 0);
  copy.toggleAttribute("inert", index !== 0);
  chapters.forEach((chapter) => {
    chapter.dataset.active = String(Number(chapter.dataset.chapter) === index);
    chapter.setAttribute("aria-hidden", String(Number(chapter.dataset.chapter) !== index));
  });
}

function updateMasthead() {
  masthead.dataset.solid = String(window.scrollY > hero.offsetHeight - window.innerHeight * 0.6);
}

async function showPoster() {
  hero.dataset.mode = "poster";
  await fontsReady();
  const image = new Image();
  image.alt = "";
  image.src = drawCover().toDataURL("image/jpeg", 0.88);
  poster.replaceChildren(image);
  showChapter(0);
}

// Keep a cover visible while WebGL loads, including devices without WebGL.
await showPoster();

async function startBook() {
  const { createBook } = await import("./book.js");
  const book = await createBook(canvas);
  const still = reducedMotion.matches;
  hero.dataset.mode = still ? "static" : "scroll";

  const resize = () => book.resize(canvas.clientWidth, canvas.clientHeight);
  new ResizeObserver(resize).observe(canvas);
  resize();

  if (still) {
    // Reduced motion: one composed frame of the open book, no scroll-linked motion.
    book.setProgress(0.6);
    showChapter(0);
    const settle = () => {
      book.frame();
      canvas.dataset.ready = "true";
      if (book.loading) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
    return;
  }

  let shown = heroProgress();
  let target = shown;
  let pointer = [0, 0];
  let visible = true;
  let running = false;

  let last = performance.now();
  const tick = (now) => {
    running = false;
    if (!visible) return;
    // Time-based easing keeps the same feel at 30, 60, or 120 frames per second.
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    shown += (target - shown) * (1 - Math.exp(-dt * 9));
    if (Math.abs(target - shown) < 0.0004) shown = target;
    book.setProgress(shown);
    book.setPointer(...pointer);
    book.frame();
    canvas.dataset.ready = "true";
    progressFill.style.transform = `scaleX(${shown})`;
    if (shown !== target || book.loading) schedule();
  };
  const schedule = () => {
    if (!running) {
      if (performance.now() - last > 100) last = performance.now();
      running = true;
      requestAnimationFrame(tick);
    }
  };

  const onScroll = () => {
    target = heroProgress();
    showChapter(chapterAt(target));
    scrollHint.style.opacity = target > 0.02 ? "0" : "1";
    updateMasthead();
    schedule();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  if (finePointer.matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        pointer = [(event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1];
        schedule();
      },
      { passive: true },
    );
  }
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) schedule();
  }).observe(hero);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });
  onScroll();
}

function renderLayouts(engine) {
  const row = document.querySelector("[data-layouts]");
  const layouts = engine?.layouts
    ? Object.entries(engine.layouts).map(([name, rects]) => [name, rects.map((r) => [r.x, r.y, r.width, r.height])])
    : Object.entries(LAYOUTS);
  const width = engine?.page?.width ?? 1600;
  const height = engine?.page?.height ?? 2400;
  const svgNS = "http://www.w3.org/2000/svg";
  row.replaceChildren(
    ...layouts.map(([name, rects]) => {
      const figure = document.createElement("figure");
      figure.className = "layout";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${name} layout, ${rects.length} ${rects.length === 1 ? "panel" : "panels"}`);
      const frame = document.createElementNS(svgNS, "rect");
      frame.setAttribute("class", "layout__frame");
      frame.setAttribute("width", width);
      frame.setAttribute("height", height);
      svg.append(frame);
      for (const [x, y, w, h] of rects) {
        const panel = document.createElementNS(svgNS, "rect");
        panel.setAttribute("class", "layout__panel");
        panel.setAttribute("x", x);
        panel.setAttribute("y", y);
        panel.setAttribute("width", w);
        panel.setAttribute("height", h);
        svg.append(panel);
      }
      const caption = document.createElement("figcaption");
      caption.className = "layout__name";
      caption.textContent = {
        "full-page": "Full page",
        "two-horizontal": "Two rows",
        "three-horizontal": "Three rows",
        "hero-top-two-bottom": "Wide panel above",
        "two-top-hero-bottom": "Wide panel below",
      }[name] || name;
      figure.append(svg, caption);
      return figure;
    }),
  );
}

async function loadEngineFacts() {
  try {
    const response = await fetch("/api/engine", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const engine = await response.json();
    renderLayouts(engine);
    const caption = document.getElementById("layouts-caption");
    caption.textContent += ` Read live from Comic Sol engine ${engine.engine.version}.`;
  } catch {
    renderLayouts(null);
  }
}

showChapter(0);
updateMasthead();
window.addEventListener("scroll", updateMasthead, { passive: true });
loadEngineFacts();

if (webglAvailable()) {
  startBook().catch((error) => {
    console.error("The 3D book could not start; showing the cover instead.", error);
    showPoster();
  });
}
