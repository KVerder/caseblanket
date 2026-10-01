import { fanLw, splAt1m, sumDb } from './acoustics';
import { solveNetwork, type NetworkInput } from './airflow';
import type { DesignRecipe } from './evaluate';

/**
 * Fitting the model to measurements from a printed prototype.
 *
 * Three correction factors, each with a physical meaning:
 *   radiator   multiplies every radiator core's loss coefficient (core resistance)
 *   leakage    multiplies the seam and joint leak area of every zone
 *   noise      dB added to the predicted case noise (rating and installation offset)
 * A measurement is one steady state: the fan speeds (RPM) it ran at, any part temperatures
 * read (thermocouples, °C), the room temperature, and optionally the noise at 1 m.
 * The fit needs at least two measurements at different fan speeds, so speed and leakage
 * effects can be told apart.
 */

export interface Measurement {
  /** Fan group id → RPM. Groups not listed run at the model's solved speed. */
  rpm: Record<string, number>;
  /** Component id → measured temperature, °C. */
  temps: Record<string, number>;
  roomC: number;
  /** Noise at 1 m, dB(A). */
  splDb?: number;
}

export interface Correction {
  radiator: number;
  leakage: number;
  noiseDb: number;
}

export const NO_CORRECTION: Correction = { radiator: 1, leakage: 1, noiseDb: 0 };

export interface Residual {
  /** Which reading: component id, or 'noise'. */
  what: string;
  row: number;
  measured: number;
  predicted: number;
  error: number;
}

function speedsOf(recipe: DesignRecipe, m: Measurement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of recipe.fans) {
    const g = recipe.net.groups.find((x) => x.id === f.id);
    out[f.id] = m.rpm[f.id] !== undefined ? Math.max(0, m.rpm[f.id] / f.rpmMax) : (g?.speed ?? 1);
  }
  return out;
}

/** Model predictions for one measurement under a correction. */
export function predict(recipe: DesignRecipe, c: Correction, m: Measurement) {
  const speeds = speedsOf(recipe, m);
  const net: NetworkInput = {
    ...recipe.net,
    ambientC: m.roomC,
    zones: recipe.net.zones.map((z) => ({ ...z, leakArea: z.leakArea * c.leakage })),
    groups: recipe.net.groups.map((g) => ({
      ...g,
      speed: g.id in speeds ? speeds[g.id] : g.speed,
      losses: g.losses.map((l) => (l.label === 'radiator core' ? { ...l, zeta: l.zeta * c.radiator } : l)),
    })),
  };
  const flow = solveNetwork(net);
  const lw = sumDb([...recipe.fans.map((f) => fanLw(f.fan, f.count, speeds[f.id] ?? 1) + f.penaltyDb), ...recipe.fixedLw]);
  return { flow, splDb: splAt1m(lw) + c.noiseDb };
}

export function residuals(recipe: DesignRecipe, c: Correction, data: Measurement[]): Residual[] {
  const out: Residual[] = [];
  data.forEach((m, row) => {
    const p = predict(recipe, c, m);
    for (const [id, measured] of Object.entries(m.temps)) {
      const comp = p.flow.components.find((x) => x.id === id);
      if (comp) out.push({ what: id, row, measured, predicted: comp.tempC, error: comp.tempC - measured });
    }
    if (m.splDb !== undefined) out.push({ what: 'noise', row, measured: m.splDb, predicted: p.splDb, error: p.splDb - m.splDb });
  });
  return out;
}

export const rms = (r: Residual[]) => (r.length ? Math.sqrt(r.reduce((s, x) => s + x.error * x.error, 0) / r.length) : 0);

/** Why a data set can't be fitted, or null. */
export function fitProblem(recipe: DesignRecipe, data: Measurement[]): string | null {
  if (data.length < 2) return 'Enter at least two measurements.';
  const keys = recipe.fans.map((f) => f.id);
  const distinct = new Set(data.map((m) => keys.map((k) => Math.round(m.rpm[k] ?? -1)).join(',')));
  if (distinct.size < 2) return 'Run the fans at two or more different speeds, so leakage and fan effects can be told apart.';
  if (!data.some((m) => Object.keys(m.temps).length)) return 'Enter at least one part temperature.';
  return null;
}

/**
 * Least-squares fit of the three factors: the noise offset in closed form (mean noise error),
 * radiator and leakage factors by a log-space coordinate search with shrinking steps.
 */
export function fitCorrection(recipe: DesignRecipe, data: Measurement[]) {
  const before = residuals(recipe, NO_CORRECTION, data);
  const thermalCost = (c: Correction) => {
    const r = residuals(recipe, c, data).filter((x) => x.what !== 'noise');
    return r.reduce((s, x) => s + x.error * x.error, 0);
  };
  let c: Correction = { ...NO_CORRECTION };
  let cost = thermalCost(c);
  for (let step = 0.6; step > 0.005; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const key of ['radiator', 'leakage'] as const) {
        for (const dir of [1, -1]) {
          const v = Math.min(key === 'radiator' ? 5 : 20, Math.max(key === 'radiator' ? 0.2 : 0, c[key] * Math.exp(dir * step)));
          const trial = { ...c, [key]: key === 'leakage' && v < 0.05 ? 0 : v };
          const tc = thermalCost(trial);
          if (tc < cost - 1e-12) {
            c = trial;
            cost = tc;
            improved = true;
          }
        }
      }
    }
  }
  const noise = residuals(recipe, c, data).filter((x) => x.what === 'noise');
  if (noise.length) c.noiseDb = -noise.reduce((s, x) => s + x.error, 0) / noise.length;
  const after = residuals(recipe, c, data);
  // A factor is constrained by these data only if doubling it moves the predictions noticeably (> 0.3 K rms).
  const moves = (key: 'radiator' | 'leakage') => {
    const base = residuals(recipe, c, data).filter((x) => x.what !== 'noise');
    const bumped = residuals(recipe, { ...c, [key]: Math.max(c[key], 0.5) * 2 }, data).filter((x) => x.what !== 'noise');
    const d = base.map((x, i) => bumped[i].predicted - x.predicted);
    return Math.sqrt(d.reduce((s2, x) => s2 + x * x, 0) / Math.max(1, d.length)) > 0.3;
  };
  const identifiable = { radiator: moves('radiator'), leakage: moves('leakage'), noise: data.some((m) => m.splDb !== undefined) };
  return { correction: c, before, after, rmsBefore: rms(before), rmsAfter: rms(after), identifiable };
}
