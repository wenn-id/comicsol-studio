// Verlet card stock for the first-edition cover. The grid is split at the perforation:
// rows 0..24 are the cover, rows 25..35 the stub. Rows 24 and 25 sit on top of each other
// at rest and share no triangles, so the stub hangs on only by the 25 seam fibres and the
// shear and bend springs that reach across the seam. No DOM here: Node imports it in tests.

export const COLS = 25;
export const ROWS = 36;
export const UPPER_SEAM_ROW = 24;
export const LOWER_SEAM_ROW = 25;
export const CARD_W = 2;
export const CARD_H = 3.4;
export const SEAM_V = 0.72;
export const SEAM_Y = (0.5 - SEAM_V) * CARD_H;
export const VERTEX_COUNT = COLS * ROWS;
const ITERATIONS = 10;

export const KIND = { structural: 0, shear: 1, bend2: 2, bend4: 3, seam: 4 };
// Structural, shear, 2-hop bend, 4-hop bend, seam. The long bend springs keep the card
// curving in stiff arcs instead of creasing like cloth.
const STIFFNESS = [0.94, 0.82, 0.76, 0.56, 0.94];

export const idx = (r, c) => r * COLS + c;
export const colX = (c) => (c / (COLS - 1) - 0.5) * CARD_W;

function rowV(r) {
  return r <= UPPER_SEAM_ROW ? (SEAM_V * r) / UPPER_SEAM_ROW : SEAM_V + ((1 - SEAM_V) * (r - LOWER_SEAM_ROW)) / (ROWS - 1 - LOWER_SEAM_ROW);
}

export class VerletPaper {
  constructor(events = {}) {
    this.events = events;
    this.pos = new Float32Array(VERTEX_COUNT * 3);
    this.prev = new Float32Array(VERTEX_COUNT * 3);
    this.rest = new Float32Array(VERTEX_COUNT * 3);
    this.home = new Float32Array(VERTEX_COUNT * 3);
    this.uv = new Float32Array(VERTEX_COUNT * 2);
    this.index = [];
    this.bodyIndexCount = 0;
    this.seamIntact = new Array(COLS).fill(true);
    this.seamSpring = new Int32Array(COLS);
    this.detached = false;
    this.detachTime = 0;
    this.maxFiberStrain = 0;
    this.time = 0;
    this.grabWeights = new Float32Array(VERTEX_COUNT);
    this.grabOrigin = { x: 0, y: 0 };
    this.grabTarget = { x: 0, y: 0, z: 0 };
    this.grabbing = false;
    this.grabMode = "flex";
    this.lastPullBreak = 0;

    for (let r = 0; r < ROWS; r++) {
      const v = rowV(r);
      for (let c = 0; c < COLS; c++) {
        const i = idx(r, c);
        this.rest[i * 3] = colX(c);
        this.rest[i * 3 + 1] = (0.5 - v) * CARD_H;
        this.uv[i * 2] = c / (COLS - 1);
        this.uv[i * 2 + 1] = 1 - v;
      }
    }

    // Cover triangles first, then the stub, so the stub can be hidden with a draw range.
    for (let r = 0; r < ROWS - 1; r++) {
      if (r === UPPER_SEAM_ROW) {
        this.bodyIndexCount = this.index.length;
        continue;
      }
      for (let c = 0; c < COLS - 1; c++) {
        const a = idx(r, c);
        const b = idx(r, c + 1);
        const d = idx(r + 1, c);
        const e = idx(r + 1, c + 1);
        this.index.push(a, d, b, b, d, e);
      }
    }

    const A = [];
    const B = [];
    const K = [];
    const add = (r1, c1, r2, c2, kind) => {
      if (r2 >= ROWS || c2 >= COLS || c2 < 0) return;
      A.push(idx(r1, c1));
      B.push(idx(r2, c2));
      K.push(kind);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        add(r, c, r, c + 1, KIND.structural);
        add(r, c, r + 1, c, r === UPPER_SEAM_ROW ? KIND.seam : KIND.structural);
        add(r, c, r + 1, c + 1, KIND.shear);
        add(r, c + 1, r + 1, c, KIND.shear);
        add(r, c, r, c + 2, KIND.bend2);
        add(r, c, r + 2, c, KIND.bend2);
        add(r, c, r, c + 4, KIND.bend4);
        add(r, c, r + 4, c, KIND.bend4);
      }
    }
    const n = A.length;
    this.springA = Uint16Array.from(A);
    this.springB = Uint16Array.from(B);
    this.springKind = Uint8Array.from(K);
    this.springRest = new Float32Array(n);
    this.springActive = new Uint8Array(n);
    // For springs that cross the seam: the two columns they touch, else -1.
    this.crossA = new Int8Array(n).fill(-1);
    this.crossB = new Int8Array(n).fill(-1);
    for (let s = 0; s < n; s++) {
      const a = this.springA[s];
      const b = this.springB[s];
      this.springRest[s] = Math.hypot(this.rest[b * 3] - this.rest[a * 3], this.rest[b * 3 + 1] - this.rest[a * 3 + 1]);
      if (Math.floor(a / COLS) <= UPPER_SEAM_ROW !== Math.floor(b / COLS) <= UPPER_SEAM_ROW) {
        this.crossA[s] = a % COLS;
        this.crossB[s] = b % COLS;
      }
      if (this.springKind[s] === KIND.seam) this.seamSpring[a % COLS] = s;
    }
    this.reset();
  }

  get springCount() {
    return this.springA.length;
  }

  get intactSeamCount() {
    return this.seamIntact.filter(Boolean).length;
  }

  reset() {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this.home.set(this.rest);
    this.springActive.fill(1);
    this.seamIntact.fill(true);
    this.detached = false;
    this.grabbing = false;
    this.grabWeights.fill(0);
    this.maxFiberStrain = 0;
  }

  isStub(i) {
    return Math.floor(i / COLS) >= LOWER_SEAM_ROW;
  }

  /** Grab the card at a point in card-local coordinates. "pull" drags the stub, "flex" the cover. */
  startGrab(x, y, mode) {
    this.grabbing = true;
    this.grabMode = mode;
    this.grabOrigin = { x, y };
    this.grabTarget = { x, y, z: 0 };
    const radius = mode === "pull" ? 1.6 : 1.05;
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const stub = this.isStub(i);
      if ((mode === "pull") !== stub) {
        this.grabWeights[i] = 0;
        continue;
      }
      const d = Math.hypot(this.rest[i * 3] - x, this.rest[i * 3 + 1] - y);
      let w = Math.max(0, 1 - d / radius);
      w *= w;
      // The stub is small and stiff: pulling it drags the whole piece along.
      if (mode === "pull") w = 0.35 + 0.65 * w;
      this.grabWeights[i] = w;
    }
  }

  moveGrab(x, y) {
    if (!this.grabbing) return;
    const dist = Math.hypot(x - this.grabOrigin.x, y - this.grabOrigin.y);
    // Lift the card toward the viewer as it is pulled, so a drag reads as a bend.
    this.grabTarget = { x, y, z: Math.min(0.9, dist * 0.55) };
  }

  endGrab() {
    this.grabbing = false;
    this.grabWeights.fill(0);
  }

  get pullDistance() {
    if (!this.grabbing || this.grabMode !== "pull") return 0;
    return Math.max(0, this.grabOrigin.y - this.grabTarget.y) + Math.abs(this.grabTarget.x - this.grabOrigin.x) * 0.35;
  }

  sever(c) {
    if (c < 0 || !this.seamIntact[c] || this.detached) return false;
    this.seamIntact[c] = false;
    for (let s = 0; s < this.springActive.length; s++) {
      if (this.crossA[s] === c || this.crossB[s] === c) this.springActive[s] = 0;
    }
    this.springActive[this.seamSpring[c]] = 0;

    // Curl the two torn lips apart so a V-shaped gap opens and stays open.
    const up = idx(UPPER_SEAM_ROW, c);
    const lo = idx(LOWER_SEAM_ROW, c);
    const jitter = 0.6 + Math.random() * 0.4;
    this.home[up * 3 + 1] += 0.028;
    this.home[up * 3 + 2] += 0.05 * jitter;
    this.home[lo * 3 + 1] -= 0.028;
    this.home[lo * 3 + 2] -= 0.035 * jitter;
    this.prev[up * 3 + 2] -= 0.025 * jitter;
    this.prev[lo * 3 + 2] += 0.02 * jitter;
    this.prev[lo * 3 + 1] += 0.015;

    const severed = COLS - this.intactSeamCount;
    this.events.onSnap?.(c, severed);
    if (severed === COLS) this.detach();
    return true;
  }

  /** Sever every intact column whose x lies between two local x positions, in swipe order. */
  sliceBetween(x0, x1) {
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const order = [];
    for (let c = 0; c < COLS; c++) {
      const x = colX(c);
      if (x >= lo && x <= hi && this.seamIntact[c]) order.push(c);
    }
    if (x1 < x0) order.reverse();
    for (const c of order) this.sever(c);
    return order.length;
  }

  detach() {
    this.detached = true;
    this.detachTime = this.time;
    this.endGrab();
    // Tumble: spin the stub around its centre and push it away and down.
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (let i = idx(LOWER_SEAM_ROW, 0); i < VERTEX_COUNT; i++) {
      cx += this.pos[i * 3];
      cy += this.pos[i * 3 + 1];
      n++;
    }
    cx /= n;
    cy /= n;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (0.012 + Math.random() * 0.01);
    const tip = 0.012 + Math.random() * 0.01;
    for (let i = idx(LOWER_SEAM_ROW, 0); i < VERTEX_COUNT; i++) {
      const rx = this.pos[i * 3] - cx;
      const ry = this.pos[i * 3 + 1] - cy;
      this.prev[i * 3] -= -ry * spin + 0.004 * Math.sign(spin);
      this.prev[i * 3 + 1] -= rx * spin - 0.01;
      this.prev[i * 3 + 2] -= tip * (ry + 0.4);
    }
    // The cover springs back up once the stub lets go.
    for (let c = 0; c < COLS; c++) {
      for (let r = UPPER_SEAM_ROW - 4; r <= UPPER_SEAM_ROW; r++) {
        const i = idx(r, c);
        this.prev[i * 3 + 1] -= (0.035 * (r - UPPER_SEAM_ROW + 5)) / 5;
        this.prev[i * 3 + 2] += 0.02;
      }
    }
    this.events.onDetach?.();
  }

  /** Lowest point of the falling stub, to know when it has left the frame. */
  stubBottom() {
    let low = Infinity;
    for (let i = idx(LOWER_SEAM_ROW, 0); i < VERTEX_COUNT; i++) low = Math.min(low, this.pos[i * 3 + 1]);
    return low;
  }

  step(dt, gravityLocal, nowMs) {
    this.time += dt;
    const { pos, prev, home } = this;

    if (this.grabbing && this.grabMode === "pull" && !this.detached) {
      const d = this.pullDistance;
      if (d > 0.14 && nowMs - this.lastPullBreak > Math.max(16, 130 - d * 220)) {
        this.lastPullBreak = nowMs;
        this.sever(this.nextPullColumn());
      }
    }

    const grav = 0.0026;
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const o = i * 3;
      const free = this.detached && this.isStub(i);
      const damp = free ? 0.985 : 0.88;
      let vx = (pos[o] - prev[o]) * damp;
      let vy = (pos[o + 1] - prev[o + 1]) * damp;
      let vz = (pos[o + 2] - prev[o + 2]) * damp;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      if (free) {
        // Gravity plus a flutter, so the stub tumbles like card rather than dropping like a stone.
        const t = this.time - this.detachTime;
        vx += gravityLocal.x * grav + Math.sin(t * 7 + i * 0.05) * 0.0009;
        vy += gravityLocal.y * grav;
        vz += gravityLocal.z * grav + Math.cos(t * 5.3 + i * 0.03) * 0.0007;
        vy *= 0.992;
      }
      pos[o] += vx;
      pos[o + 1] += vy;
      pos[o + 2] += vz;
    }

    const { springA: A, springB: B, springRest: R, springKind: K, springActive: act, grabWeights: w, grabTarget: t, grabOrigin: g } = this;
    const n = A.length;
    for (let it = 0; it < ITERATIONS; it++) {
      // Elastic recoil toward the flat pose, and the pointer pull on grabbed vertices.
      for (let i = 0; i < VERTEX_COUNT; i++) {
        if (this.detached && this.isStub(i)) continue;
        const o = i * 3;
        pos[o] += (home[o] - pos[o]) * 0.018;
        pos[o + 1] += (home[o + 1] - pos[o + 1]) * 0.018;
        pos[o + 2] += (home[o + 2] - pos[o + 2]) * 0.018;
        const wi = w[i];
        if (wi > 0) {
          const s = wi * 0.35;
          pos[o] += (home[o] + (t.x - g.x) * wi - pos[o]) * s;
          pos[o + 1] += (home[o + 1] + (t.y - g.y) * wi - pos[o + 1]) * s;
          pos[o + 2] += (home[o + 2] + t.z * wi - pos[o + 2]) * s;
        }
      }
      for (let s = 0; s < n; s++) {
        if (!act[s]) continue;
        const a = A[s] * 3;
        const b = B[s] * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-7) continue;
        const diff = ((len - R[s]) / len) * STIFFNESS[K[s]] * 0.5;
        pos[a] += dx * diff;
        pos[a + 1] += dy * diff;
        pos[a + 2] += dz * diff;
        pos[b] -= dx * diff;
        pos[b + 1] -= dy * diff;
        pos[b + 2] -= dz * diff;
      }
    }

    let maxStrain = 0;
    for (let c = 0; c < COLS; c++) {
      if (this.seamIntact[c]) maxStrain = Math.max(maxStrain, this.springLength(this.seamSpring[c]));
    }
    this.maxFiberStrain = maxStrain;
  }

  springLength(s) {
    const a = this.springA[s] * 3;
    const b = this.springB[s] * 3;
    return Math.hypot(this.pos[b] - this.pos[a], this.pos[b + 1] - this.pos[a + 1], this.pos[b + 2] - this.pos[a + 2]);
  }

  // The stub moves almost as one piece, so seam stretch is nearly equal across columns;
  // the tear starts at the fibre under the pointer and runs outward from the torn front.
  nextPullColumn() {
    const anyTorn = this.intactSeamCount < COLS;
    let best = -1;
    let bestScore = Infinity;
    for (let c = 0; c < COLS; c++) {
      if (!this.seamIntact[c]) continue;
      const onFront = (c > 0 && !this.seamIntact[c - 1]) || (c < COLS - 1 && !this.seamIntact[c + 1]);
      if (anyTorn && !onFront) continue;
      const score = Math.abs(colX(c) - this.grabTarget.x) - this.springLength(this.seamSpring[c]) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }
}
