// Seedable PRNG + the few distributions the simulator needs. Pure and
// deterministic: the same seed yields the same stream on every runtime
// (Node, vitest, Workers), which is what makes a bench reproducible.

// mulberry32: tiny, fast, 32-bit state; good enough for a simulator
// (not for anything security-relevant).
export interface Rng {
  next(): number; // uniform [0, 1)
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// Derive an independent stream from a base seed and a label, so each
// concern (workload, flakes, conflicts, ...) draws from its own stream
// and adding draws to one never perturbs another.
export function deriveSeed(seed: number, label: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export function rngFor(seed: number, label: string): Rng {
  return mulberry32(deriveSeed(seed, label));
}

// Standard normal via Box-Muller (one value per call; simplicity over
// throughput).
export function normal(rng: Rng): number {
  let u = rng.next();
  while (u <= Number.EPSILON) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Lognormal parameterised by its median (exp(mu)) and sigma: the
// natural shape for durations (long right tail, never negative).
export function lognormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * normal(rng));
}

export function bernoulli(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

// Zipf(s) over ranks 0..n-1 via a precomputed CDF + binary search.
export interface Zipf {
  n: number;
  sample(rng: Rng): number;
  // Probability mass of rank r (for tests and docs).
  mass(r: number): number;
}

export function zipf(n: number, s: number): Zipf {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let r = 0; r < n; r++) {
    acc += 1 / Math.pow(r + 1, s);
    cdf[r] = acc;
  }
  const total = acc;
  for (let r = 0; r < n; r++) cdf[r] /= total;
  return {
    n,
    sample(rng: Rng): number {
      const u = rng.next();
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cdf[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    mass(r: number): number {
      return 1 / Math.pow(r + 1, s) / total;
    },
  };
}

// Fisher-Yates permutation of 0..n-1.
export function permutation(rng: Rng, n: number): Int32Array {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

// Nearest-rank percentile of an ascending-sorted array (NaN when empty).
export function percentile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}
