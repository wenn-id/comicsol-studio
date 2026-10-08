// The hero's scroll timeline, shared by the book scene and the page captions.

export const LEAVES = 5;

export const smooth = (t) => t * t * (3 - 2 * t);
export const clamp01 = (t) => Math.min(1, Math.max(0, t));
export const span = (p, start, end) => clamp01((p - start) / (end - start));
export const lerp = (a, b, t) => a + (b - a) * t;

export const TIMELINE = {
  coverStart: 0.1,
  coverEnd: 0.36,
  leavesStart: 0.38,
  leavesEnd: 0.82,
  diveStart: 0.9,
};

export function coverAngle(p) {
  return Math.PI * smooth(span(p, TIMELINE.coverStart, TIMELINE.coverEnd));
}

export function leafAngle(p, index) {
  const window = (TIMELINE.leavesEnd - TIMELINE.leavesStart) / (LEAVES + 1.2);
  const start = TIMELINE.leavesStart + index * window;
  return Math.PI * smooth(span(p, start, start + window * 2.2));
}

export function chapterAt(p) {
  if (p < 0.08) return 0;
  if (p < TIMELINE.leavesStart) return 1;
  if (p < TIMELINE.diveStart - 0.04) return 2;
  if (p < 0.92) return 3;
  return -1; // the last stretch is the camera's alone
}
