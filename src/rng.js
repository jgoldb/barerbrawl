// Deterministic, seedable RNG (mulberry32) + convenience helpers.

export class RNG {
  constructor(seed = 0x1a2b3c4d) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  weighted(pairs) {
    // pairs: [[value, weight], ...]
    let total = 0;
    for (const p of pairs) total += p[1];
    let r = this.next() * total;
    for (const p of pairs) { if ((r -= p[1]) <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  spread(mag) { return (this.next() * 2 - 1) * mag; }
}

// A globally-seeded run RNG for gameplay variety (reseeded per run).
export function newSeed() {
  // Not time-based here (kept deterministic-friendly); caller may reseed.
  return (Math.floor(performance.now() * 1000) ^ 0x51ed270b) >>> 0;
}
