// Procedural print art for the landing book: a softcover cover, interior comic pages laid
// out on the engine's five page layouts, and paper edges. Everything is drawn on canvas at
// load, so the hero ships no image files and no third-party artwork.

export const PAGE_RATIO = 2400 / 1600;
const W = 1024;
const H = Math.round(W * PAGE_RATIO);

// Mirrors the engine's layout registry (layouts.py, version 1). A test keeps them in step.
export const LAYOUTS = {
  "full-page": [[64, 64, 1472, 2272]],
  "two-horizontal": [[64, 64, 1472, 1120], [64, 1216, 1472, 1120]],
  "three-horizontal": [[64, 64, 1472, 736], [64, 832, 1472, 736], [64, 1600, 1472, 736]],
  "hero-top-two-bottom": [[64, 64, 1472, 1176], [64, 1272, 720, 1064], [816, 1272, 720, 1064]],
  "two-top-hero-bottom": [[64, 64, 720, 1064], [816, 64, 720, 1064], [64, 1160, 1472, 1176]],
};

const INK = "#141210";
const PAPER = "#f2ebdc";
const PAPER_SHADE = "#e4dac6";
const AMBER = "#d9a441";
const AMBER_DEEP = "#9a6b1f";
const OBSIDIAN = "#08090b";

function canvas(width = W, height = H) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}

function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

let noiseTile = null;
function grain(ctx, width, height, alpha, seed = 7) {
  if (!noiseTile) {
    noiseTile = canvas(256, 256);
    const tileCtx = noiseTile.getContext("2d");
    const image = tileCtx.createImageData(256, 256);
    const random = rng(seed);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = 110 + random() * 145;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    tileCtx.putImageData(image, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = ctx.createPattern(noiseTile, "repeat");
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function paper(ctx, width = W, height = H, tone = PAPER) {
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, width, height);
  const edge = ctx.createRadialGradient(width / 2, height / 2, width * 0.3, width / 2, height / 2, width * 0.9);
  edge.addColorStop(0, "rgba(255,255,255,0)");
  edge.addColorStop(1, "rgba(120,96,60,0.16)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, width, height);
}

// Halftone dots whose radius follows `density(nx, ny)` in 0..1.
function halftone(ctx, x, y, width, height, { spacing = 9, color = INK, angle = 0.4, density }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = color;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.hypot(width, height);
  const cx = x + width / 2;
  const cy = y + height / 2;
  for (let gy = -reach / 2; gy < reach / 2; gy += spacing) {
    for (let gx = -reach / 2; gx < reach / 2; gx += spacing) {
      const px = cx + gx * cos - gy * sin;
      const py = cy + gx * sin + gy * cos;
      if (px < x - spacing || px > x + width + spacing || py < y - spacing || py > y + height + spacing) continue;
      const value = density((px - x) / width, (py - y) / height);
      if (value <= 0.02) continue;
      ctx.beginPath();
      ctx.arc(px, py, (spacing / 2) * Math.min(1.15, Math.sqrt(value)) * 1.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function figure(ctx, x, y, scale, { lean = 0, arm = 0.4, scarf = true, color = INK } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // legs
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(-8, -70);
  ctx.lineTo(-18, -2);
  ctx.moveTo(8, -70);
  ctx.lineTo(22, -4);
  ctx.stroke();
  // coat
  ctx.beginPath();
  ctx.moveTo(-26, -150);
  ctx.quadraticCurveTo(-34, -96, -30, -58);
  ctx.lineTo(30, -58);
  ctx.quadraticCurveTo(34, -100, 24, -150);
  ctx.closePath();
  ctx.fill();
  // arms
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(-22, -142);
  ctx.lineTo(-40 - arm * 30, -108 + arm * -40);
  ctx.moveTo(22, -142);
  ctx.lineTo(36, -96);
  ctx.stroke();
  // head
  ctx.beginPath();
  ctx.arc(0, -172, 19, 0, Math.PI * 2);
  ctx.fill();
  if (scarf) {
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(-14, -152);
    ctx.bezierCurveTo(30, -160, 70, -148, 112, -170);
    ctx.bezierCurveTo(90, -146, 56, -138, 10, -140);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function skyline(ctx, x, y, width, height, random, color = INK) {
  ctx.fillStyle = color;
  let cursor = x - 10;
  while (cursor < x + width) {
    const towerWidth = 30 + random() * 70;
    const towerHeight = height * (0.25 + random() * 0.75);
    ctx.fillRect(cursor, y + height - towerHeight, towerWidth, towerHeight);
    if (random() > 0.6) ctx.fillRect(cursor + towerWidth * 0.4, y + height - towerHeight - 26, 5, 26);
    cursor += towerWidth + random() * 6;
  }
}

function sun(ctx, cx, cy, radius) {
  const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.2);
  glow.addColorStop(0, "rgba(233,187,94,0.85)");
  glow.addColorStop(0.5, "rgba(217,164,65,0.25)");
  glow.addColorStop(1, "rgba(217,164,65,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius * 2.4, cy - radius * 2.4, radius * 4.8, radius * 4.8);
  ctx.fillStyle = AMBER;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Panel scenes ----------------------------------------------------------------

const scenes = {
  dusk(ctx, x, y, w, h, random) {
    const sky = ctx.createLinearGradient(0, y, 0, y + h);
    sky.addColorStop(0, "#f1e2c0");
    sky.addColorStop(1, "#e3b765");
    ctx.fillStyle = sky;
    ctx.fillRect(x, y, w, h);
    sun(ctx, x + w * 0.66, y + h * 0.5, Math.min(w, h) * 0.2);
    halftone(ctx, x, y, w, h * 0.7, { spacing: 10, color: AMBER_DEEP, density: (nx, ny) => 0.55 * (1 - ny) * (0.6 + 0.4 * nx) });
    skyline(ctx, x, y + h * 0.48, w, h * 0.52, random);
    figure(ctx, x + w * 0.27, y + h * 0.66, h / 560, { arm: 0.9 });
  },
  portrait(ctx, x, y, w, h) {
    ctx.fillStyle = "#e9dcc1";
    ctx.fillRect(x, y, w, h);
    halftone(ctx, x, y, w, h, { spacing: 9, density: (nx) => Math.max(0, nx - 0.35) * 0.9 });
    const cx = x + w * 0.42;
    const cy = y + h * 0.58;
    const s = h / 700;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 120 * s, 150 * s, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 230 * s, y + h);
    ctx.quadraticCurveTo(cx - 200 * s, cy + 170 * s, cx, cy + 150 * s);
    ctx.quadraticCurveTo(cx + 210 * s, cy + 170 * s, cx + 250 * s, y + h);
    ctx.fill();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 9 * s;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 120 * s, 150 * s, -0.08, -1.2, 0.5);
    ctx.stroke();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(cx - 160 * s, cy + 160 * s);
    ctx.bezierCurveTo(cx, cy + 220 * s, cx + 170 * s, cy + 150 * s, cx + 320 * s, cy + 120 * s);
    ctx.lineTo(cx + 300 * s, cy + 190 * s);
    ctx.bezierCurveTo(cx + 140 * s, cy + 240 * s, cx, cy + 260 * s, cx - 170 * s, cy + 200 * s);
    ctx.fill();
  },
  speed(ctx, x, y, w, h, random) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(x, y, w, h);
    const cx = x + w * 0.55;
    const cy = y + h * 0.5;
    ctx.strokeStyle = INK;
    for (let i = 0; i < 140; i++) {
      const angle = random() * Math.PI * 2;
      const inner = 70 + random() * 120;
      const outer = Math.hypot(w, h);
      ctx.lineWidth = 1 + random() * 5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
    figure(ctx, cx, cy + h * 0.28, h / 470, { lean: -0.5, arm: 1.2 });
  },
  rooftop(ctx, x, y, w, h, random) {
    ctx.fillStyle = "#1d1f24";
    ctx.fillRect(x, y, w, h);
    halftone(ctx, x, y, w, h, { spacing: 8, color: "#3a3d45", density: (nx, ny) => 0.4 + ny * 0.5 });
    ctx.fillStyle = "#f4e8cc";
    ctx.beginPath();
    ctx.arc(x + w * 0.8, y + h * 0.24, Math.min(w, h) * 0.09, 0, Math.PI * 2);
    ctx.fill();
    skyline(ctx, x, y + h * 0.4, w, h * 0.6, random, "#0b0b0d");
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = random() > 0.4 ? AMBER : "#f1d9a2";
      ctx.fillRect(x + random() * w, y + h * (0.55 + random() * 0.4), 5, 7);
    }
    figure(ctx, x + w * 0.2, y + h * 0.93, h / 420, { arm: 0.2 });
  },
  eye(ctx, x, y, w, h) {
    ctx.fillStyle = PAPER_SHADE;
    ctx.fillRect(x, y, w, h);
    halftone(ctx, x, y, w, h, { spacing: 8, density: (nx, ny) => 0.25 + 0.5 * Math.abs(ny - 0.5) * 2 });
    const cx = x + w * 0.5;
    const cy = y + h * 0.52;
    ctx.fillStyle = PAPER;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.34, h * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.arc(cx, cy, h * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(cx, cy, h * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.34, h * 0.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(cx + h * 0.05, cy - h * 0.05, h * 0.03, 0, Math.PI * 2);
    ctx.fill();
  },
  sea(ctx, x, y, w, h, random) {
    const sky = ctx.createLinearGradient(0, y, 0, y + h);
    sky.addColorStop(0, "#f3e5c5");
    sky.addColorStop(0.55, "#ecc173");
    sky.addColorStop(0.56, "#1f2127");
    sky.addColorStop(1, "#0e0f12");
    ctx.fillStyle = sky;
    ctx.fillRect(x, y, w, h);
    sun(ctx, x + w * 0.5, y + h * 0.56, Math.min(w, h) * 0.18);
    ctx.fillStyle = "#121318";
    ctx.fillRect(x, y + h * 0.56, w, h * 0.44);
    ctx.strokeStyle = AMBER;
    for (let i = 0; i < 26; i++) {
      const yy = y + h * (0.6 + i * 0.015);
      const half = w * (0.04 + i * 0.012) * (0.6 + random() * 0.6);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.5 - half, yy);
      ctx.lineTo(x + w * 0.5 + half, yy);
      ctx.stroke();
    }
    figure(ctx, x + w * 0.22, y + h * 0.95, h / 600, { arm: 0.6 });
  },
  lamp(ctx, x, y, w, h) {
    ctx.fillStyle = "#24262c";
    ctx.fillRect(x, y, w, h);
    const glow = ctx.createRadialGradient(x + w * 0.5, y + h * 0.35, 10, x + w * 0.5, y + h * 0.35, h * 0.7);
    glow.addColorStop(0, "rgba(233,187,94,0.9)");
    glow.addColorStop(1, "rgba(233,187,94,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = INK;
    ctx.fillRect(x + w * 0.48, y + h * 0.35, w * 0.04, h * 0.65);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.36, y + h * 0.36);
    ctx.lineTo(x + w * 0.64, y + h * 0.36);
    ctx.lineTo(x + w * 0.56, y + h * 0.2);
    ctx.lineTo(x + w * 0.44, y + h * 0.2);
    ctx.closePath();
    ctx.fill();
  },
  hands(ctx, x, y, w, h) {
    ctx.fillStyle = "#efe3c8";
    ctx.fillRect(x, y, w, h);
    halftone(ctx, x, y, w, h, { spacing: 8, density: (nx, ny) => 0.15 + ny * 0.45 });
    ctx.save();
    ctx.translate(x + w * 0.5, y + h * 0.6);
    ctx.rotate(-0.12);
    ctx.fillStyle = PAPER;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6;
    ctx.fillRect(-w * 0.28, -h * 0.3, w * 0.56, h * 0.5);
    ctx.strokeRect(-w * 0.28, -h * 0.3, w * 0.56, h * 0.5);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-w * 0.28, -h * 0.05);
    ctx.lineTo(w * 0.28, -h * 0.05);
    ctx.moveTo(0, -h * 0.05);
    ctx.lineTo(0, h * 0.2);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.ellipse(-w * 0.32, h * 0.12, w * 0.1, h * 0.08, 0.5, 0, Math.PI * 2);
    ctx.ellipse(w * 0.33, h * 0.1, w * 0.1, h * 0.08, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};

// Lettering --------------------------------------------------------------------

function wrap(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function balloon(ctx, text, x, y, maxWidth, tail) {
  ctx.font = '700 30px "Comic Neue", "Comic Sans MS", cursive';
  const lines = wrap(ctx, text.toUpperCase(), maxWidth);
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 64;
  const height = lines.length * 34 + 40;
  const cx = x + width / 2;
  const cy = y + height / 2;
  ctx.fillStyle = "#fffdf6";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - width * 0.12, cy + height * 0.38);
  ctx.quadraticCurveTo(tail[0] - 8, tail[1] - 30, tail[0], tail[1]);
  ctx.quadraticCurveTo(cx + width * 0.02, cy + height * 0.4, cx + width * 0.1, cy + height * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, index) => ctx.fillText(line, cx, cy + (index - (lines.length - 1) / 2) * 34 + 2));
}

function caption(ctx, text, x, y, maxWidth) {
  ctx.font = '700 26px "Comic Neue", "Comic Sans MS", cursive';
  const lines = wrap(ctx, text.toUpperCase(), maxWidth);
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 36;
  const height = lines.length * 30 + 24;
  ctx.fillStyle = "#f6d68d";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((line, index) => ctx.fillText(line, x + 18, y + 14 + index * 30));
}

function sfx(ctx, text, x, y, size, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.font = `700 ${size}px "Comic Neue", "Comic Sans MS", cursive`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = INK;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = AMBER;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// Pages ------------------------------------------------------------------------

const PAGES = [
  {
    layout: "hero-top-two-bottom",
    panels: ["dusk", "portrait", "hands"],
    text: [
      { kind: "caption", panel: 0, text: "Every comic starts as one sentence.", at: [0.05, 0.06] },
      { kind: "balloon", panel: 1, text: "Then who is in it?", at: [0.42, 0.06], tail: [0.4, 0.42] },
      { kind: "balloon", panel: 2, text: "And where every panel goes.", at: [0.06, 0.05], tail: [0.4, 0.4] },
    ],
  },
  {
    layout: "two-horizontal",
    panels: ["rooftop", "eye"],
    text: [
      { kind: "caption", panel: 0, text: "The city keeps its lights on for her.", at: [0.04, 0.06] },
      { kind: "balloon", panel: 1, text: "I remember every face.", at: [0.05, 0.08], tail: [0.3, 0.3] },
    ],
  },
  {
    layout: "three-horizontal",
    panels: ["speed", "dusk", "rooftop"],
    text: [
      { kind: "sfx", panel: 0, text: "WHOOSH", at: [0.24, 0.42], size: 120, angle: -0.18 },
      { kind: "balloon", panel: 2, text: "Made it.", at: [0.55, 0.1], tail: [0.24, 0.5] },
    ],
  },
  {
    layout: "two-top-hero-bottom",
    panels: ["lamp", "portrait", "sea"],
    text: [
      { kind: "caption", panel: 0, text: "Night shift.", at: [0.08, 0.06] },
      { kind: "balloon", panel: 2, text: "Morning, at last.", at: [0.56, 0.07], tail: [0.25, 0.6] },
    ],
  },
  {
    layout: "full-page",
    panels: ["sea"],
    text: [{ kind: "caption", panel: 0, text: "Chapter one: the bound book.", at: [0.05, 0.05] }],
  },
  {
    layout: "hero-top-two-bottom",
    panels: ["speed", "eye", "lamp"],
    text: [
      { kind: "sfx", panel: 0, text: "FWUMP", at: [0.74, 0.3], size: 110, angle: 0.14 },
      { kind: "balloon", panel: 1, text: "Who drew that?", at: [0.08, 0.06], tail: [0.4, 0.35] },
    ],
  },
];

export const PAGE_COUNT = PAGES.length;

export function drawPage(index, { mirrored = false } = {}) {
  const spec = PAGES[index % PAGES.length];
  const element = canvas();
  const ctx = element.getContext("2d");
  if (mirrored) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  paper(ctx);
  const scale = W / 1600;
  const random = rng(31 + index * 97);
  const rects = LAYOUTS[spec.layout].map(([x, y, w, h]) => [x * scale, y * scale, w * scale, h * scale]);
  rects.forEach(([x, y, w, h], panelIndex) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    scenes[spec.panels[panelIndex]](ctx, x, y, w, h, random);
    ctx.restore();
  });
  for (const item of spec.text) {
    const [x, y, w, h] = rects[item.panel];
    if (item.kind === "caption") caption(ctx, item.text, x + w * item.at[0], y + h * item.at[1], w * 0.7);
    if (item.kind === "balloon") {
      balloon(ctx, item.text, x + w * item.at[0], y + h * item.at[1], w * 0.55, [x + w * item.tail[0], y + h * item.tail[1]]);
    }
    if (item.kind === "sfx") sfx(ctx, item.text, x + w * item.at[0], y + h * item.at[1], item.size * scale * 1.5, item.angle);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  rects.forEach(([x, y, w, h]) => ctx.strokeRect(x, y, w, h));
  ctx.font = '600 20px "Manrope", sans-serif';
  ctx.fillStyle = "#6f6656";
  ctx.textAlign = "center";
  ctx.fillText(String(index + 3), W / 2, H - 16);
  grain(ctx, W, H, 0.09);
  return element;
}

export function drawCover() {
  const element = canvas();
  const ctx = element.getContext("2d");
  const random = rng(4242);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#0d0e12");
  sky.addColorStop(0.55, "#2a2218");
  sky.addColorStop(1, "#0a0a0c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // light rays from the sun
  const sx = W * 0.62;
  const sy = H * 0.5;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2 + 0.1;
    ctx.fillStyle = `rgba(217,164,65,${0.035 + (i % 2) * 0.03})`;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(angle) * 1800, sy + Math.sin(angle) * 1800);
    ctx.lineTo(sx + Math.cos(angle + 0.12) * 1800, sy + Math.sin(angle + 0.12) * 1800);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  sun(ctx, sx, sy, 220);
  halftone(ctx, sx - 260, sy - 260, 520, 520, {
    spacing: 14,
    color: AMBER_DEEP,
    angle: 0.3,
    density: (nx, ny) => Math.max(0, 0.9 - Math.hypot(nx - 0.5, ny - 0.5) * 2.2) * (ny > 0.45 ? 0.9 : 0.25),
  });

  skyline(ctx, 0, H * 0.62, W, H * 0.24, random, "#060607");
  ctx.fillStyle = "#060607";
  ctx.fillRect(0, H * 0.84, W, H * 0.16);
  // ledge and hero
  ctx.fillStyle = "#121214";
  ctx.beginPath();
  ctx.moveTo(0, H * 0.82);
  ctx.lineTo(W * 0.55, H * 0.78);
  ctx.lineTo(W * 0.58, H * 0.8);
  ctx.lineTo(0, H * 0.86);
  ctx.fill();
  figure(ctx, W * 0.36, H * 0.795, 2.1, { arm: 1.1, color: "#050506" });
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = random() > 0.5 ? AMBER : "#f3dfae";
    ctx.globalAlpha = 0.5 + random() * 0.5;
    ctx.fillRect(random() * W, H * (0.66 + random() * 0.16), 4, 6);
  }
  ctx.globalAlpha = 1;

  // masthead
  ctx.fillStyle = "#eee7d8";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = '400 214px "Instrument Serif", Georgia, serif';
  ctx.fillText("Comic Sol", 52, 232);
  ctx.fillStyle = AMBER;
  ctx.fillRect(58, 262, W - 116, 4);
  ctx.font = '700 26px "Manrope", sans-serif';
  ctx.fillStyle = "#eee7d8";
  ctx.fillText("STUDIO EDITION", 60, 312);
  ctx.textAlign = "right";
  ctx.fillText("No. 01", W - 60, 312);
  ctx.font = 'italic 400 64px "Instrument Serif", Georgia, serif';
  ctx.textAlign = "left";
  ctx.fillText("Every page,", 60, H - 190);
  ctx.fillText("bound by you.", 60, H - 124);
  // barcode
  ctx.fillStyle = "#eee7d8";
  ctx.fillRect(W - 210, H - 200, 150, 120);
  ctx.fillStyle = INK;
  for (let i = 0, x = W - 198; x < W - 74; i++) {
    const bar = 2 + Math.floor(random() * 4);
    if (i % 2 === 0) ctx.fillRect(x, H - 188, bar, 84);
    x += bar + 2;
  }
  grain(ctx, W, H, 0.12);
  return element;
}

export function drawBackCover() {
  const element = canvas();
  const ctx = element.getContext("2d");
  ctx.fillStyle = OBSIDIAN;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 3;
  ctx.strokeRect(W * 0.38, H * 0.36, W * 0.24, H * 0.24);
  ctx.beginPath();
  ctx.moveTo(W * 0.38, H * 0.48);
  ctx.lineTo(W * 0.62, H * 0.48);
  ctx.moveTo(W * 0.5, H * 0.36);
  ctx.lineTo(W * 0.5, H * 0.48);
  ctx.stroke();
  ctx.fillStyle = "#bdb6a8";
  ctx.textAlign = "center";
  ctx.font = '400 54px "Instrument Serif", Georgia, serif';
  ctx.fillText("Comic Sol Studio", W / 2, H * 0.7);
  grain(ctx, W, H, 0.1);
  return element;
}

export function drawInsideCover({ mirrored = false } = {}) {
  const element = canvas();
  const ctx = element.getContext("2d");
  if (mirrored) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  paper(ctx, W, H, "#ece4d2");
  ctx.fillStyle = "#6f6656";
  ctx.textAlign = "left";
  ctx.font = '400 40px "Instrument Serif", Georgia, serif';
  ctx.fillText("Comic Sol Studio", 90, H - 260);
  ctx.font = '500 20px "Manrope", sans-serif';
  const lines = [
    "Planned, rendered, reviewed, lettered, and bound",
    "with the Comic Sol engine on the creator's machine.",
    "Page art on this specimen is drawn in the browser.",
  ];
  lines.forEach((line, index) => ctx.fillText(line, 90, H - 210 + index * 30));
  grain(ctx, W, H, 0.08);
  return element;
}

export function drawEdge() {
  const element = canvas(64, 512);
  const ctx = element.getContext("2d");
  ctx.fillStyle = "#e7dcc6";
  ctx.fillRect(0, 0, 64, 512);
  const random = rng(99);
  for (let y = 0; y < 512; y += 2) {
    ctx.fillStyle = `rgba(110,92,62,${0.08 + random() * 0.18})`;
    ctx.fillRect(0, y, 64, 1);
  }
  return element;
}

export async function fontsReady() {
  if (!document.fonts) return;
  await Promise.allSettled([
    document.fonts.load('400 120px "Instrument Serif"'),
    document.fonts.load('italic 400 60px "Instrument Serif"'),
    document.fonts.load('700 30px "Comic Neue"'),
    document.fonts.load('600 20px "Manrope"'),
  ]);
}
