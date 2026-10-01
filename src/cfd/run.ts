import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { buildScene, ductCandidates, flipCandidates, louvreCandidates, NO_SHAPING, type Shaping } from './scene';
import { FlowSolver, thermalScore, type FlowStats } from './solver';

export interface SimFrame {
  n: [number, number, number];
  h: number;
  origin: [number, number, number];
  solid: Uint8Array;
  vel: Float32Array;
  T: Float32Array;
  stats: FlowStats;
  done: boolean;
}

/** Steps a design's flow, calling `frame` every `every` steps. */
export function simulate(design: Design, cfg: DesignConfig, shaping: Shaping, opts: { cells?: number; seconds?: number; every?: number; frame?: (f: SimFrame) => void }) {
  const scene = buildScene(design, cfg, shaping, { cells: opts.cells });
  const sim = new FlowSolver(scene);
  const dt = sim.suggestDt();
  const steps = Math.ceil((opts.seconds ?? 2.5) / dt);
  const emit = (done: boolean) => {
    if (!opts.frame) return;
    const snap = sim.snapshot();
    opts.frame({ n: scene.n, h: scene.h, origin: scene.origin, solid: scene.cellType, vel: snap.vel, T: snap.T, stats: sim.stats(), done });
  };
  for (let s = 0; s < steps; s++) {
    sim.step(dt);
    if (opts.every && s % opts.every === opts.every - 1 && s < steps - 1) emit(false);
  }
  emit(true);
  return sim.stats();
}

export interface ShapingStep {
  label: string;
  score: number;
  kept: boolean;
}

export interface ShapingResult {
  shaping: Shaping;
  baseline: FlowStats;
  best: FlowStats;
  baselineScore: number;
  bestScore: number;
  steps: ShapingStep[];
}

const DIR_WORDS = ['front', 'back', 'up', 'down', 'one side', 'other side'];

/**
 * Greedy search over flow-shaping features with short, coarse simulations: start from the
 * plain design, then try each exhaust deflector, intake duct and radiator fan reversal in
 * turn, keeping a change only when it lowers the heat-weighted intake air temperature.
 */
export function optimiseShaping(design: Design, cfg: DesignConfig, progress?: (done: number, total: number, label: string) => void): ShapingResult {
  const quick = (s: Shaping) => simulate(design, cfg, s, { cells: 9000, seconds: 1.4 });
  const candidates: { label: string; apply: (s: Shaping) => Shaping }[] = [];
  for (const l of louvreCandidates(design)) {
    const v = design.vents[l.vent];
    const part = design.parts.find((p) => p.id === v.groupId);
    candidates.push({
      label: `Deflector on the ${part?.label ?? 'exhaust'} vent, throwing air ${DIR_WORDS[l.toward]} away from the intakes`,
      apply: (s) => ({ ...s, louvres: [...s.louvres, l] }),
    });
  }
  for (const id of ductCandidates(design)) {
    const part = design.parts.find((p) => p.id === id);
    candidates.push({ label: `Duct sealing the ${part?.kind === 'board' ? 'CPU cooler' : part?.label ?? id} fan to its vent`, apply: (s) => ({ ...s, ducts: [...s.ducts, id] }) });
  }
  for (const id of flipCandidates(design)) {
    const part = design.parts.find((p) => p.id === id);
    candidates.push({ label: `Reverse the ${part?.label ?? id} fans (${part?.airflow === 'in' ? 'intake → exhaust' : 'exhaust → intake'})`, apply: (s) => ({ ...s, flipped: [...s.flipped, id] }) });
  }
  const total = candidates.length + 1;
  progress?.(0, total, 'Simulating the plain design');
  const baseline = quick(NO_SHAPING);
  let best = baseline;
  let bestScore = thermalScore(baseline);
  const baselineScore = bestScore;
  let shaping: Shaping = { louvres: [], ducts: [], flipped: [] };
  const steps: ShapingStep[] = [];
  candidates.forEach((cand, i) => {
    progress?.(i + 1, total, cand.label);
    const trial = cand.apply(shaping);
    const st = quick(trial);
    const sc = thermalScore(st);
    const kept = sc < bestScore - 0.05;
    steps.push({ label: cand.label, score: sc, kept });
    if (kept) {
      shaping = trial;
      best = st;
      bestScore = sc;
    }
  });
  return { shaping, baseline, best, baselineScore, bestScore, steps };
}
