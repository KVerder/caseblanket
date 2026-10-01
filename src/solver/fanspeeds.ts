import { splAt1m, sumDb, type NoiseSource } from './acoustics';
import type { FlowResult } from './airflow';

export interface NoiseResult {
  sources: NoiseSource[];
  /** Case sound power and SPL at 1 m (free-field estimate), dB(A). */
  lw: number;
  spl: number;
}

export interface SpeedControl {
  id: string;
  /** Slowest speed as a share of the maximum. */
  min: number;
}

export interface SpeedSolution {
  speeds: Record<string, number>;
  flow: FlowResult;
  noise: NoiseResult;
  /** Budget mode: the budget can be met at all (the slowest speeds are quiet enough). */
  feasible: boolean;
}

export interface SpeedProblem {
  controls: SpeedControl[];
  evaluate: (speeds: Record<string, number>) => FlowResult;
  noise: (speeds: Record<string, number>, flow: FlowResult) => NoiseResult;
}

/** Coarse-to-fine speed steps: big moves first, then refine. */
const STEPS = [0.2, 0.1, 0.05];

function at(p: SpeedProblem, speeds: Record<string, number>) {
  const flow = p.evaluate(speeds);
  return { speeds, flow, noise: p.noise(speeds, flow) };
}

/**
 * As cool as possible within a noise budget: start every fan at its slowest, then keep speeding
 * up whichever fan lifts the tightest part's margin most per unit of added sound power, while the
 * case stays within the budget. If even the slowest speeds are too loud, report that (infeasible)
 * at the slowest speeds; never exceed the budget silently.
 */
export function coolestWithin(p: SpeedProblem, budgetDb: number): SpeedSolution {
  const speeds: Record<string, number> = {};
  for (const c of p.controls) speeds[c.id] = c.min;
  let cur = at(p, speeds);
  if (cur.noise.spl > budgetDb + 1e-9) return { ...cur, feasible: false };
  for (const STEP of STEPS)
  for (let iter = 0; iter < 400; iter++) {
    let best: (typeof cur & { rate: number }) | null = null;
    for (const c of p.controls) {
      const s = cur.speeds[c.id];
      if (s >= 1 - 1e-9) continue;
      const next = { ...cur.speeds, [c.id]: Math.min(1, s + STEP) };
      const trial = at(p, next);
      if (trial.noise.spl > budgetDb + 1e-9) continue;
      const gain = trial.flow.worstMargin - cur.flow.worstMargin;
      const cost = Math.max(1e-9, 10 ** (trial.noise.spl / 10) - 10 ** (cur.noise.spl / 10));
      // Prefer the biggest gain on the tightest part; among no-gain moves, the cheapest one that
      // lifts the heat-weighted score (it may unlock the tightest part later).
      const rate = gain > 1e-6 ? gain / cost : (trial.flow.score - cur.flow.score) / cost - 1e9;
      if (!best || rate > best.rate) best = { ...trial, rate };
    }
    if (!best || best.rate <= -1e9 + 1e-12) break;
    cur = best;
  }
  return { speeds: cur.speeds, flow: cur.flow, noise: cur.noise, feasible: true };
}

/**
 * As quiet as possible with every part under its limit: start at full speed, then keep slowing
 * whichever fan saves the most sound power while every part keeps a margin of at least 0. If
 * even full speed leaves a part over its limit, report full speed (infeasible).
 */
export function quietestSafe(p: SpeedProblem): SpeedSolution {
  const speeds: Record<string, number> = {};
  for (const c of p.controls) speeds[c.id] = 1;
  let cur = at(p, speeds);
  if (cur.flow.worstMargin < 0) return { ...cur, feasible: false };
  for (const STEP of STEPS)
  for (let iter = 0; iter < 400; iter++) {
    let best: (typeof cur & { saved: number }) | null = null;
    for (const c of p.controls) {
      const s = cur.speeds[c.id];
      if (s <= c.min + 1e-9) continue;
      const next = { ...cur.speeds, [c.id]: Math.max(c.min, s - STEP) };
      const trial = at(p, next);
      if (trial.flow.worstMargin < 0) continue;
      const saved = 10 ** (cur.noise.spl / 10) - 10 ** (trial.noise.spl / 10);
      if (!best || saved > best.saved) best = { ...trial, saved };
    }
    if (!best) break;
    cur = best;
  }
  return { speeds: cur.speeds, flow: cur.flow, noise: cur.noise, feasible: true };
}

export const noiseTotal = (sources: NoiseSource[]): NoiseResult => {
  const lw = sumDb(sources.map((s) => s.lw));
  return { sources, lw, spl: splAt1m(lw) };
};
