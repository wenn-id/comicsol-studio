// Original Rooftop Stories artwork; the two page images are composed by Comic Sol.
export const PAGE_RATIO = 2400 / 1600;
export const PAGE_COUNT = 2;
const W = 1024;
const H = 1536;

// The engine's page layout registry; the source-contract test checks these rectangles.
export const LAYOUTS = {
  "full-page": [[64, 64, 1472, 2272]],
  "two-horizontal": [[64, 64, 1472, 1120], [64, 1216, 1472, 1120]],
  "three-horizontal": [[64, 64, 1472, 736], [64, 832, 1472, 736], [64, 1600, 1472, 736]],
  "hero-top-two-bottom": [[64, 64, 1472, 1176], [64, 1272, 720, 1064], [816, 1272, 720, 1064]],
  "two-top-hero-bottom": [[64, 64, 720, 1064], [816, 64, 720, 1064], [64, 1160, 1472, 1176]],
};

const art = new Map();
let ready;
function loadImage(name) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { art.set(name, image); resolve(); };
    image.onerror = () => reject(new Error("Could not load book artwork: " + name));
    image.src = new URL("../../img/rooftop-" + name + ".webp", import.meta.url).href;
  });
}
export function fontsReady() {
  ready ||= Promise.all([
    loadImage("cover"), loadImage("page-1"), loadImage("page-2"),
    ...(document.fonts ? [document.fonts.load('600 24px "Manrope"')] : []),
  ]);
  return ready;
}
function canvas(width = W, height = H) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}
function imageCanvas(name, mirrored = false) {
  const element = canvas();
  const ctx = element.getContext("2d");
  if (mirrored) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(art.get(name), 0, 0, W, H);
  return element;
}
export function drawCover() { return imageCanvas("cover"); }
export function drawPage(index, { mirrored = false } = {}) {
  return imageCanvas("page-" + (index % PAGE_COUNT + 1), mirrored);
}
export function drawBackCover() {
  const element = canvas();
  const ctx = element.getContext("2d");
  ctx.fillStyle = "#b43928";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#f4f1ea";
  ctx.textAlign = "center";
  ctx.font = '700 66px "Manrope", sans-serif';
  ctx.fillText("Rooftop Stories", W / 2, H * .48);
  ctx.font = '500 28px "Manrope", sans-serif';
  ctx.fillText("A little room above the city.", W / 2, H * .54);
  return element;
}
export function drawInsideCover({ mirrored = false } = {}) {
  const element = canvas();
  const ctx = element.getContext("2d");
  if (mirrored) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#25282b";
  ctx.font = '700 44px "Manrope", sans-serif';
  ctx.fillText("Rooftop Stories", 80, H - 320);
  ctx.font = '500 23px "Manrope", sans-serif';
  ["An original comic made for Comic Sol Studio.",
   "AI-created artwork, with a shared character reference.",
   "Pages and lettering composed by the Comic Sol engine."].forEach(
    (line, i) => ctx.fillText(line, 80, H - 256 + i * 36),
  );
  return element;
}
export function drawEdge() {
  const element = canvas(64, 512);
  const ctx = element.getContext("2d");
  ctx.fillStyle = "#ede7dc";
  ctx.fillRect(0, 0, 64, 512);
  ctx.fillStyle = "rgba(90,80,65,.12)";
  for (let y = 0; y < 512; y += 4) ctx.fillRect(0, y, 64, 1);
  return element;
}
