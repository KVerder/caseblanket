import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { buildScene, ductCandidates, flipCandidates, louvreCandidates, NO_SHAPING, type Shaping } from './scene';
import { MATERIALS } from '../model/presets';
import { PARTITION_THICKNESS } from '../solver/chambers';
import { cfdComponents, type CfdThermal } from './components';
import { FlowSolver, type FlowStats } from './solver';

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
  kind: 'louvre' | 'duct' | 'flip' | 'partition' | 'no-partition';
  /** Tightest part with this change on top of the kept ones: share of budget left, K left, name. */
  margin: number;
  headroomK: number;
  worst: string;
  kept: boolean;
  /** Weight the change adds, kg (printed plates); 0 for louvres cut into a panel and fan reversals. */
  weightKg: number;
}

export interface ShapingResult {
  shaping: Shaping;
  baseline: FlowStats;
  best: FlowStats;
  baselineThermal: CfdThermal;
  bestThermal: CfdThermal;
  steps: ShapingStep[];
  /** Gain on the tightest part a change must beat to be kept (share of its budget). */
  threshold: number;
}

/**
 * Smallest gain on the tightest part's margin (share of its budget) a structure must give to be
 * kept: run-to-run noise of the short simulations plus their calibration error (estimate).
 */
export const STRUCTURE_MIN_GAIN = 0.03;

const DIR_WORDS = ['front', 'back', 'up', 'down', 'one side', 'other side'];

/** Structures whose effect lives below the grid; listed, never claimed. */
export const UNRESOLVED_STRUCTURES = [
  'bell-mouth inlets (lip radius ~0.1–0.2 of the fan diameter)',
  'exit diffusers (5–7° half-angle)',
  'turning vanes in sharp bends',
  'vortex generators ahead of radiators and fin stacks',
];

/**
 * Greedy search over flow-shaping structures with short, coarse simulations: start from the
 * design as solved (with its partitions, if any), then try each exhaust deflector, intake duct,
 * radiator fan reversal and partition change in turn. A change is kept only when it lifts the
 * tightest part's margin by more than STRUCTURE_MIN_GAIN; the design's own walls are dropped
 * when removing them costs less than that.
 */
export function optimiseShaping(design: Design, cfg: DesignConfig, progress?: (done: number, total: number, label: string) => void): ShapingResult {
  const quick = (s: Shaping) => simulate(design, cfg, s, { cells: 9000, seconds: 1.4 });
  const mat = MATERIALS.find((m) => m.id === cfg.prefs.materialId) ?? MATERIALS[0];
  const candidates: { label: string; kind: ShapingStep['kind']; weightKg: number; apply: (s: Shaping) => Shaping }[] = [];
  for (const l of louvreCandidates(design)) {
    const v = design.vents[l.vent];
    const part = design.parts.find((p) => p.id === v.groupId);
    candidates.push({
      label: `Deflector on the ${part?.label ?? 'exhaust'} vent, throwing air ${DIR_WORDS[l.toward]} away from the intakes`,
      kind: 'louvre',
      weightKg: 0,
      apply: (s) => ({ ...s, louvres: [...s.louvres, l] }),
    });
  }
  for (const id of ductCandidates(design)) {
    const part = design.parts.find((p) => p.id === id);
    candidates.push({
      label: `Duct sealing the ${part?.kind === 'board' ? 'CPU cooler' : (part?.label ?? id)} fan to its vent`,
      kind: 'duct',
      weightKg: 0.02,
      apply: (s) => ({ ...s, ducts: [...s.ducts, id] }),
    });
  }
  for (const id of flipCandidates(design)) {
    const part = design.parts.find((p) => p.id === id);
    candidates.push({
      label: `Reverse the ${part?.label ?? id} fans (${part?.airflow === 'in' ? 'intake → exhaust' : 'exhaust → intake'})`,
      kind: 'flip',
      weightKg: 0,
      apply: (s) => ({ ...s, flipped: [...s.flipped, id] }),
    });
  }
  const plateKg = (area: number) => (area * PARTITION_THICKNESS * mat.densityGcm3) / 1e6;
  if (design.chamber) {
    candidates.push({ label: 'Remove the internal walls (one chamber)', kind: 'no-partition', weightKg: -plateKg(design.chamber.plateAreaMm2), apply: (s) => ({ ...s, noChambers: true }) });
  } else {
    for (const o of design.chamberOptions.slice(0, 2)) {
      candidates.push({
        label: `Internal wall${o.layout.cuts.length > 1 ? 's' : ''}: ${o.layout.chambers.map((c) => c.label.replace(' chamber', '')).join(' | ')}`,
        kind: 'partition',
        weightKg: plateKg(o.layout.plateAreaMm2),
        apply: (s) => ({ ...s, partitions: [...(s.partitions ?? []), ...o.layout.cuts] }),
      });
    }
  }
  const total = candidates.length + 1;
  progress?.(0, total, 'Simulating the design as solved');
  const baseline = quick(NO_SHAPING);
  const baselineThermal = cfdComponents(design, cfg, baseline);
  let best = baseline;
  let bestThermal = baselineThermal;
  let shaping: Shaping = { louvres: [], ducts: [], flipped: [] };
  const steps: ShapingStep[] = [];
  candidates.forEach((cand, i) => {
    progress?.(i + 1, total, cand.label);
    const trial = cand.apply(shaping);
    const st = quick(trial);
    const th = cfdComponents(design, cfg, st);
    // Adding a structure must beat the uncertainty; removing the design's walls is kept unless it
    // costs more than the uncertainty (walls must earn their weight in 3D too).
    const kept =
      cand.kind === 'no-partition' ? th.worstMargin >= bestThermal.worstMargin - STRUCTURE_MIN_GAIN : th.worstMargin > bestThermal.worstMargin + STRUCTURE_MIN_GAIN;
    steps.push({ label: cand.label, kind: cand.kind, margin: th.worstMargin, headroomK: th.worstHeadroomK, worst: th.worstComponent, kept, weightKg: cand.weightKg });
    if (kept) {
      shaping = trial;
      best = st;
      bestThermal = th;
    }
  });
  return { shaping, baseline, best, baselineThermal, bestThermal, steps, threshold: STRUCTURE_MIN_GAIN };
}
