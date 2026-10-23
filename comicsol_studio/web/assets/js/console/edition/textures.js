// Front and back of the first-edition card, drawn on canvas. Each face gives a colour
// image whose alpha cuts the rounded corners, side notches and punched seam holes, and a
// mask where red = foil, green = emboss height and blue = rainbow phase offset.

export const TEX_W = 1024;
export const TEX_H = 1740;
export const SEAM_PX = Math.round(TEX_H * 0.72);
const HOLE_COUNT = 24;

const SANS = '"Manrope", "Segoe UI", system-ui, sans-serif';

// Main's print palette: card stock a shade brighter than the page, charcoal ink, print red.
const PAPER = "#fdfbf6";
const INK = "#25282b";
const INK_2 = "#454747";
const INK_3 = "#64615b";
const RED = "#b43928";
const ON_RED = "#ffffff";
const LINE = "rgba(180, 57, 40, 0.75)";
const RULE = "rgba(37, 40, 43, 0.14)";

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gray = (v) => {
  const g = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${g},${g},${g})`;
};

function canvas() {
  const element = document.createElement("canvas");
  element.width = TEX_W;
  element.height = TEX_H;
  return element;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, value, x, y, font, fill, align = "left", spacing = 0) {
  ctx.font = font;
  ctx.fillStyle = fill;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(value, x, y);
  ctx.letterSpacing = "0px";
}

// The largest size, up to `size`, at which a line fits the width.
function fitted(ctx, value, weight, size, maxWidth) {
  ctx.font = `${weight} ${size}px ${SANS}`;
  const width = ctx.measureText(value).width;
  return width > maxWidth ? Math.floor((size * maxWidth) / width) : size;
}

// Split a title into at most two lines of roughly equal length.
function titleLines(title) {
  const words = title.trim().split(/\s+/);
  if (title.length < 18 || words.length < 2) return [title];
  let best = [title];
  let bestGap = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const gap = Math.abs(a.length - b.length);
    if (gap < bestGap) {
      bestGap = gap;
      best = [a, b];
    }
  }
  return best;
}

function foilGradient(ctx, x0, x1) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  ["#7d2418", "#d4563f", "#9e2c1d", "#e8806a", "#873021"].forEach((c, i, all) => g.addColorStop(i / (all.length - 1), c));
  return g;
}

function cutShape(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  roundRect(ctx, 0, 0, TEX_W, TEX_H, 20);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  for (const x of [0, TEX_W]) {
    ctx.beginPath();
    ctx.arc(x, SEAM_PX, 30, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < HOLE_COUNT; i++) {
    ctx.beginPath();
    ctx.arc(((i + 0.5) / HOLE_COUNT) * TEX_W, SEAM_PX, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function perforation(ctx, fill) {
  ctx.strokeStyle = fill;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(40, SEAM_PX);
  ctx.lineTo(TEX_W - 40, SEAM_PX);
  ctx.stroke();
  ctx.setLineDash([]);
}

function frame(ctx, fill) {
  ctx.strokeStyle = fill;
  ctx.lineWidth = 3;
  roundRect(ctx, 30, 30, TEX_W - 60, TEX_H - 60, 8);
  ctx.stroke();
}

function barcode(ctx, x, y, w, h, seed, fill) {
  const next = random(hash(`${seed}bar`));
  ctx.fillStyle = fill;
  let cx = x;
  let black = true;
  while (cx < x + w) {
    const bw = 2 + Math.floor(next() * 4) * 2.2;
    if (black) ctx.fillRect(cx, y, Math.min(bw, x + w - cx), h);
    cx += bw;
    black = !black;
  }
}

// Cover-fit an image into a box.
function drawCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

// Each op is drawn three times: in colour, then into the foil and emboss layers if it has
// a weight there. Layers get flat grays so the shader can read them as masks. A knockout
// op clears the foil under it, so lettering printed on a foil block stays readable.
function paint(ops) {
  const color = canvas();
  const cctx = color.getContext("2d");
  cctx.fillStyle = PAPER;
  cctx.fillRect(0, 0, TEX_W, TEX_H);
  for (const op of ops) op.draw(cctx, op.color, "color");
  cutShape(cctx);

  const foil = canvas();
  const emboss = canvas();
  const fctx = foil.getContext("2d");
  const ectx = emboss.getContext("2d");
  for (const layerCtx of [fctx, ectx]) {
    layerCtx.fillStyle = "#000";
    layerCtx.fillRect(0, 0, TEX_W, TEX_H);
  }
  for (const op of ops) {
    if (op.foil) op.draw(fctx, gray(op.foil), "foil");
    if (op.knockout) op.draw(fctx, "#000", "foil");
    if (op.emboss) op.draw(ectx, gray(op.emboss), "emboss");
  }
  // Soften the emboss so the shader's finite differences give a rounded bevel.
  const soft = canvas();
  const sctx = soft.getContext("2d");
  sctx.filter = "blur(2.5px)";
  sctx.drawImage(emboss, 0, 0);

  const mask = canvas();
  const mctx = mask.getContext("2d");
  const out = mctx.createImageData(TEX_W, TEX_H);
  const f = fctx.getImageData(0, 0, TEX_W, TEX_H).data;
  const e = sctx.getImageData(0, 0, TEX_W, TEX_H).data;
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const p = (y * TEX_W + x) * 4;
      const phase = (x * 0.6 + y * 0.4) / 900;
      out.data[p] = f[p];
      out.data[p + 1] = e[p];
      out.data[p + 2] = Math.round((phase - Math.floor(phase)) * 255);
      out.data[p + 3] = 255;
    }
  }
  mctx.putImageData(out, 0, 0);
  return { color, mask };
}

// Studio timestamps are Unix seconds.
export function formatDate(seconds) {
  const date = typeof seconds === "number" ? new Date(seconds * 1000) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

/**
 * @param {object} edition
 * @param {string} edition.title
 * @param {string} edition.serial
 * @param {number} edition.pages
 * @param {number} edition.panels
 * @param {string} edition.bound
 * @param {HTMLImageElement | null} edition.cover
 */
export function drawFront(edition) {
  const W = TEX_W;
  const ops = [];
  const op = (entry) => ops.push(entry);

  op({ color: LINE, foil: 0.9, draw: (c, fill) => frame(c, fill) });
  op({
    color: RED,
    foil: 1,
    draw: (c, fill, layer) => {
      c.fillStyle = layer === "color" ? foilGradient(c, 50, W - 50) : fill;
      c.fillRect(50, 52, W - 100, 46);
    },
  });
  op({
    color: ON_RED,
    knockout: true,
    emboss: 0.6,
    draw: (c, fill) => text(c, "FIRST EDITION · COMIC SOL STUDIO", W / 2, 84, `700 21px ${SANS}`, fill, "center", 5),
  });

  // The cover art is page one of the comic.
  const art = { x: 64, y: 130, w: W - 128, h: 760 };
  op({
    color: "#e5dfd4",
    draw: (c, fill, layer) => {
      if (layer !== "color") return;
      if (edition.cover) drawCover(c, edition.cover, art.x, art.y, art.w, art.h);
      else {
        c.fillStyle = fill;
        c.fillRect(art.x, art.y, art.w, art.h);
        text(c, "PAGE ONE", W / 2, art.y + art.h / 2, `800 56px ${SANS}`, INK_3, "center", 6);
      }
    },
  });
  op({
    color: RED,
    foil: 1,
    emboss: 0.8,
    draw: (c, fill) => {
      c.strokeStyle = fill;
      c.lineWidth = 6;
      c.strokeRect(art.x - 3, art.y - 3, art.w + 6, art.h + 6);
    },
  });

  const lines = titleLines(edition.title);
  op({
    color: INK,
    emboss: 1,
    draw: (c, fill) => {
      const size = Math.min(...lines.map((line) => fitted(c, line, 800, lines.length === 1 ? 88 : 70, W - 140)));
      lines.forEach((line, i) => text(c, line, W / 2, 990 + i * size * 1.02 + (lines.length === 1 ? 20 : 0), `800 ${size}px ${SANS}`, fill, "center", -1));
    },
  });
  op({
    color: INK_2,
    draw: (c, fill) =>
      text(c, `${edition.pages} ${edition.pages === 1 ? "PAGE" : "PAGES"} · ${edition.panels} PANELS · BOUND ${edition.bound}`, W / 2, 1168, `700 20px ${SANS}`, fill, "center", 3),
  });
  op({
    color: INK_3,
    draw: (c, fill) => text(c, "SLICE THE PERFORATION OR PULL THE STUB TO RELEASE THE PDF", W / 2, SEAM_PX - 24, `600 15px ${SANS}`, fill, "center", 2),
  });
  op({ color: LINE, foil: 0.5, draw: (c, fill) => perforation(c, fill) });

  // Stub
  const sy = SEAM_PX + 40;
  op({ color: INK_3, draw: (c, fill) => text(c, "READER'S STUB · ADMIT ONE", 70, sy + 40, `700 17px ${SANS}`, fill, "left", 3) });
  op({
    color: RED,
    foil: 0.9,
    emboss: 1,
    draw: (c, fill, layer) => text(c, "EDITION 001 / 001", 70, sy + 116, `800 60px ${SANS}`, layer === "color" ? foilGradient(c, 70, 640) : fill, "left", 1),
  });
  op({
    color: INK_2,
    draw: (c, fill) => {
      const size = fitted(c, edition.title.toUpperCase(), 700, 20, 560);
      text(c, edition.title.toUpperCase(), 70, sy + 162, `700 ${size}px ${SANS}`, fill, "left", 2);
    },
  });
  op({ color: INK, draw: (c, fill) => barcode(c, 70, sy + 190, 600, 110, edition.serial, fill) });
  op({ color: INK_3, draw: (c, fill) => text(c, `SERIAL CS-${edition.serial.slice(0, 12).toUpperCase()}`, 70, sy + 330, `600 16px ${SANS}`, fill, "left", 2) });
  op({
    color: RED,
    foil: 1,
    emboss: 0.9,
    draw: (c, fill, layer) => {
      c.fillStyle = layer === "color" ? foilGradient(c, 760, 960) : fill;
      c.beginPath();
      c.arc(860, sy + 180, 104, 0, Math.PI * 2);
      c.fill();
    },
  });
  op({
    color: ON_RED,
    knockout: true,
    emboss: 0.3,
    draw: (c, fill) => {
      text(c, "PDF", 860, sy + 176, `800 46px ${SANS}`, fill, "center", 4);
      text(c, "VERIFIED", 860, sy + 214, `700 18px ${SANS}`, fill, "center", 3);
    },
  });
  op({
    color: RED,
    foil: 1,
    draw: (c, fill, layer) => {
      c.fillStyle = layer === "color" ? foilGradient(c, W - 50, 50) : fill;
      c.fillRect(50, TEX_H - 104, W - 100, 40);
    },
  });
  op({
    color: ON_RED,
    knockout: true,
    draw: (c, fill) => text(c, "TEAR HERE TO RELEASE THE PDF · KEEP THE COVER", W / 2, TEX_H - 77, `700 17px ${SANS}`, fill, "center", 3),
  });
  return paint(ops);
}

export function drawBack(edition) {
  const W = TEX_W;
  const ops = [];
  const op = (entry) => ops.push(entry);

  op({ color: LINE, foil: 0.8, draw: (c, fill) => frame(c, fill) });
  op({ color: INK_3, draw: (c, fill) => text(c, "COLOPHON", W / 2, 120, `700 20px ${SANS}`, fill, "center", 6) });
  op({
    color: INK,
    emboss: 0.8,
    draw: (c, fill) => {
      const size = fitted(c, edition.title, 800, 76, W - 160);
      text(c, edition.title, W / 2, 230, `800 ${size}px ${SANS}`, fill, "center", -1);
    },
  });
  op({
    color: LINE,
    draw: (c, fill) => {
      c.fillStyle = fill;
      c.fillRect(W / 2 - 60, 272, 120, 3);
    },
  });

  const rows = [
    ["Pages", String(edition.pages)],
    ["Panels", String(edition.panels)],
    ["Language", edition.language || "Not set"],
    ["Bound", edition.bound],
    ["Checked by", "Comic Sol engine"],
    ["Warnings", edition.warnings ? String(edition.warnings) : "None"],
    ["Serial", `CS-${edition.serial.slice(0, 12).toUpperCase()}`],
  ];
  rows.forEach(([key, value], i) => {
    const y = 380 + i * 92;
    op({ color: INK_3, draw: (c, fill) => text(c, key.toUpperCase(), 110, y, `700 20px ${SANS}`, fill, "left", 3) });
    op({
      color: INK,
      draw: (c, fill) => {
        const size = fitted(c, value, 600, 34, 480);
        text(c, value, W - 110, y, `600 ${size}px ${SANS}`, fill, "right");
      },
    });
    op({
      color: RULE,
      draw: (c, fill) => {
        c.fillStyle = fill;
        c.fillRect(110, y + 30, W - 220, 2);
      },
    });
  });

  op({ color: LINE, foil: 0.5, draw: (c, fill) => perforation(c, fill) });
  const sx = W / 2;
  const sy = SEAM_PX + 245;
  op({
    color: RED,
    foil: 1,
    emboss: 0.9,
    draw: (c, fill, layer) => {
      if (layer === "color") {
        const g = c.createRadialGradient(sx - 50, sy - 50, 10, sx, sy, 150);
        ["#e8806a", "#b43928", "#6e1f14"].forEach((stop, i) => g.addColorStop(i / 2, stop));
        c.fillStyle = g;
      } else c.fillStyle = fill;
      c.beginPath();
      c.arc(sx, sy, 140, 0, Math.PI * 2);
      c.fill();
    },
  });
  op({
    color: ON_RED,
    knockout: true,
    emboss: 0.3,
    draw: (c, fill) => {
      text(c, "BOUND", sx, sy - 6, `800 30px ${SANS}`, fill, "center", 4);
      text(c, "AND VERIFIED", sx, sy + 28, `800 22px ${SANS}`, fill, "center", 3);
    },
  });
  op({ color: INK_3, draw: (c, fill) => text(c, "MADE WITH COMIC SOL STUDIO", W / 2, TEX_H - 82, `700 15px ${SANS}`, fill, "center", 3) });
  return paint(ops);
}
