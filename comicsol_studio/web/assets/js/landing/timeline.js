// Physical sheet poses for the cover and two-page Rooftop Stories comic.
export const LEAVES = 1;
export const smooth = (t) => t * t * (3 - 2 * t);
export const clamp01 = (t) => Math.min(1, Math.max(0, t));
export const span = (p, start, end) => clamp01((p - start) / (end - start));
export const lerp = (a, b, t) => a + (b - a) * t;
export const TIMELINE = { coverStart: .1, coverEnd: .36, leavesStart: .38, leavesEnd: .82 };
export const BOOK_VIEWS = [
  { label: "Cover", progress: 0 },
  { label: "Opening", progress: .19 },
  { label: "Page 1 of 2", progress: .37 },
  { label: "Page 2 of 2", progress: .84 },
];
export function coverAngle(p) { return Math.PI * smooth(span(p, TIMELINE.coverStart, TIMELINE.coverEnd)); }
export function leafAngle(p, index) {
  const window = (TIMELINE.leavesEnd - TIMELINE.leavesStart) / (LEAVES + 1.2);
  const start = TIMELINE.leavesStart + index * window;
  return Math.PI * smooth(span(p, start, start + window * 2.2));
}
