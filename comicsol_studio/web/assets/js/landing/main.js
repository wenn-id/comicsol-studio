import { BOOK_VIEWS } from "./timeline.js";
import { LAYOUTS } from "./textures.js";

const hero = document.querySelector("[data-hero]");
const canvas = document.querySelector("[data-book-canvas]");
const stage = canvas.parentElement;
const controls = document.querySelector("[data-book-controls]");
const previous = document.querySelector("[data-book-prev]");
const next = document.querySelector("[data-book-next]");
const play = document.querySelector("[data-book-play]");
const label = document.querySelector("[data-book-label]");
const viewer = document.querySelector(".book-viewer");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch { return false; }
}

async function startBook() {
  const { createBook } = await import("./book.js");
  const book = await createBook(canvas);
  let index = reducedMotion.matches ? 2 : 0;
  let shown = reducedMotion.matches ? BOOK_VIEWS[index].progress : 0;
  let autoplay = !reducedMotion.matches;
  let direction = 1;
  let visible = true;
  let running = false;
  let last = performance.now();
  let dragStart = null;

  const updateControls = () => {
    label.textContent = BOOK_VIEWS[index].label;
    label.setAttribute("aria-live", autoplay ? "off" : "polite");
    previous.disabled = index === 0;
    next.disabled = index === BOOK_VIEWS.length - 1;
    play.hidden = reducedMotion.matches;
    play.textContent = autoplay ? "Pause" : "Play";
    play.setAttribute("aria-label", (autoplay ? "Pause" : "Play") + " book animation");
  };
  const tick = (now) => {
    running = false;
    if (!visible || document.hidden) return;
    const target = BOOK_VIEWS[index].progress;
    const dt = Math.min(.1, Math.max(0, (now - last) / 1000));
    last = now;
    shown = reducedMotion.matches ? target : shown + (target - shown) * (1 - Math.exp(-dt * 5));
    if (Math.abs(target - shown) < .0003) shown = target;
    book.setProgress(shown);
    book.frame();
    canvas.dataset.ready = "true";
    canvas.dataset.settled = String(shown === target && !book.loading);
    hero.dataset.mode = "book";
    if (shown !== target || book.loading) schedule();
  };
  const schedule = () => {
    if (running) return;
    canvas.dataset.settled = "false";
    last = performance.now();
    running = true;
    requestAnimationFrame(tick);
  };
  const move = (delta) => {
    autoplay = false;
    index = Math.max(0, Math.min(BOOK_VIEWS.length - 1, index + delta));
    updateControls();
    schedule();
  };
  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  play.addEventListener("click", () => { autoplay = !autoplay; updateControls(); schedule(); });
  viewer.tabIndex = 0;
  viewer.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(event.key === "ArrowRight" ? 1 : -1);
    }
  });
  stage.addEventListener("pointerdown", (event) => {
    dragStart = [event.clientX, event.clientY];
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const dx = event.clientX - dragStart[0], dy = event.clientY - dragStart[1];
    dragStart = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  });
  stage.addEventListener("pointercancel", () => { dragStart = null; });
  stage.addEventListener("pointermove", (event) => {
    if (reducedMotion.matches || event.pointerType !== "mouse") return;
    const rect = stage.getBoundingClientRect();
    book.setPointer((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1);
    schedule();
  });
  stage.addEventListener("pointerleave", () => { book.setPointer(0, 0); schedule(); });
  const resize = new ResizeObserver(() => { book.resize(canvas.clientWidth, canvas.clientHeight); schedule(); });
  resize.observe(canvas);
  const visibility = new IntersectionObserver((entries) => {
    visible = entries.at(-1).isIntersecting;
    if (visible) schedule();
  });
  visibility.observe(stage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) autoplay = false;
    updateControls();
    schedule();
  });
  const timer = setInterval(() => {
    if (!autoplay || !visible || document.hidden) return;
    if (index + direction < 0 || index + direction >= BOOK_VIEWS.length) direction *= -1;
    index += direction;
    updateControls();
    schedule();
  }, 3800);
  const stop = () => { clearInterval(timer); resize.disconnect(); visibility.disconnect(); book.dispose(); };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    visible = false;
    controls.hidden = true;
    hero.dataset.mode = "poster";
    stop();
  });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) stop(); });
  controls.hidden = false;
  updateControls();
  book.resize(canvas.clientWidth, canvas.clientHeight);
  schedule();
}

function renderLayouts(engine) {
  const row = document.querySelector("[data-layouts]");
  const layouts = engine?.layouts
    ? Object.entries(engine.layouts).map(([name, rects]) => [name, rects.map((r) => [r.x, r.y, r.width, r.height])])
    : Object.entries(LAYOUTS);
  const names = { "full-page": "Full page", "two-horizontal": "Two rows", "three-horizontal": "Three rows", "hero-top-two-bottom": "Wide panel above", "two-top-hero-bottom": "Wide panel below" };
  const svgNS = "http://www.w3.org/2000/svg";
  row.replaceChildren(...layouts.map(([name, rects]) => {
    const figure = document.createElement("figure");
    figure.className = "layout";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 1600 2400");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", (names[name] || name) + ", " + rects.length + (rects.length === 1 ? " panel" : " panels"));
    const frame = document.createElementNS(svgNS, "rect");
    frame.setAttribute("class", "layout__frame");
    frame.setAttribute("width", "1600");
    frame.setAttribute("height", "2400");
    svg.append(frame);
    rects.forEach(([x, y, w, h]) => {
      const panel = document.createElementNS(svgNS, "rect");
      panel.setAttribute("class", "layout__panel");
      Object.entries({ x, y, width: w, height: h }).forEach(([key, value]) => panel.setAttribute(key, value));
      svg.append(panel);
    });
    const caption = document.createElement("figcaption");
    caption.textContent = names[name] || name;
    figure.append(svg, caption);
    return figure;
  }));
}
async function loadEngineFacts() {
  try {
    const response = await fetch("/api/engine", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    renderLayouts(await response.json());
  } catch { renderLayouts(null); }
}
loadEngineFacts();
if (webglAvailable()) startBook().catch((error) => { console.warn("Book unavailable; showing its cover.", error); });
