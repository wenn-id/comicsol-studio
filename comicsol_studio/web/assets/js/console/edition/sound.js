// Synthesized tear sounds: each fibre is a band-passed noise burst pitched from 1.35 kHz
// up to 2.8 kHz across the seam, and the stub coming free plays a soft Fmaj9 chord.

const STORAGE_KEY = "comicsol-studio-edition-sound";

export class TearSound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.nextSnapAt = 0;
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      this.enabled = true;
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // storage can be blocked; the choice then lasts for this page only
    }
  }

  ensure() {
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      this.ctx = new Context();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const length = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  /** Call from a user gesture so the browser lets audio start. */
  unlock() {
    if (this.enabled) this.ensure();
  }

  snap(col, total) {
    const ctx = this.enabled ? this.ensure() : null;
    if (!ctx) return;
    // Spread snaps that land in the same frame so a fast swipe zips instead of clumping.
    const t = Math.max(ctx.currentTime, this.nextSnapAt);
    this.nextSnapAt = t + 0.012;
    const freq = 1350 + (1450 * col) / Math.max(1, total - 1);

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.9 + Math.random() * 0.3;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = freq * (0.92 + Math.random() * 0.16);
    band.Q.value = 2.4;
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 600;
    const gain = ctx.createGain();
    const duration = 0.05 + Math.random() * 0.03;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(band).connect(high).connect(gain).connect(this.master);
    source.start(t, Math.random() * 0.15, duration + 0.02);
  }

  chord() {
    const ctx = this.enabled ? this.ensure() : null;
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(900, t);
    low.frequency.linearRampToValueAtTime(2600, t + 0.6);
    const bus = ctx.createGain();
    bus.gain.value = 0.14;
    low.connect(bus).connect(this.master);
    // F3 A3 C4 E4 G4
    [174.61, 220.0, 261.63, 329.63, 392.0].forEach((freq, i) => {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? "sine" : "triangle";
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const gain = ctx.createGain();
        const start = t + i * 0.045;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.5, start + 0.06);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 2.6);
        osc.connect(gain).connect(low);
        osc.start(start);
        osc.stop(start + 2.7);
      }
    });
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
