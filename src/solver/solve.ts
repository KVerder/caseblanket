import type { DesignConfig, TopologyId } from '../model/types';
import { TILT_ANGLES } from './tilt';
import { evaluate, type Design } from './evaluate';
import { buildItems, isDirect, isTwoLayer, PROFILES, type Profile } from './items';
import { pack } from './pack';
import { isWrap, wrapMetrics } from './shrinkwrap';

export interface SolveOptions {
  beamWidth?: number;
  /** Designs evaluated in full per (topology, profile) run. */
  evaluatePerRun?: number;
  maxResults?: number;
  onProgress?: (done: number, total: number) => void;
  /** Measure shrinkwrapped shells for the shortlist (default true when organic > 0). */
  wrapMetrics?: boolean;
}

export interface SolveResult {
  designs: Design[];
  /** Every valid design evaluated (the design space), for the explorer. */
  space: Design[];
  stats: { runs: number; evaluated: number; ms: number };
}

export const ALL_TOPOLOGIES: TopologyId[] = ['flat', 'sandwich', 'direct', 'direct-stack'];

/** Interior limits along the solver axes (u, v, t) implied by the world limits and orientation. */
export function solverLimits(cfg: DesignConfig): [number, number, number] {
  const p = cfg.prefs;
  return p.orientation === 'tower' ? [p.maxDepth, p.maxHeight, p.maxWidth] : [p.maxDepth, p.maxWidth, p.maxHeight];
}

/** Layout families to try: the user's ticked families, narrowed by how the GPU is mounted. */
export function activeTopologies(cfg: DesignConfig): TopologyId[] {
  const mount = cfg.prefs.gpuMount ?? 'any';
  const fits = (t: TopologyId) => mount === 'any' || (mount === 'slot') === isDirect(t);
  const ticked = ALL_TOPOLOGIES.filter((t) => cfg.prefs.topologies[t] && fits(t));
  // If the ticked families all need the other mount, fall back to every family that fits the mount.
  return ticked.length ? ticked : ALL_TOPOLOGIES.filter(fits);
}

export function activeProfiles(cfg: DesignConfig): Profile[] {
  const { cooler, gpu } = cfg.parts;
  const has120Rad = [cooler.kind === 'aio' ? cooler.radiator : undefined, gpu.cooling === 'aio' ? gpu.radiator : undefined].some(
    (r) => r && r.fan.size === 120 && r.fan.thickness > 15,
  );
  return PROFILES.filter((p) => !p.slim || (cfg.prefs.allowSlimFans && has120Rad));
}

export function rankDesigns(designs: Design[], cfg: DesignConfig): Design[] {
  const { airflowPriority: s } = cfg.prefs;
  const alpha = Math.min(0.97, Math.max(0.03, cfg.prefs.thinnessPriority));
  const valid = designs.filter((d) => !d.invalid);
  const pool = valid.length ? valid : designs;
  const tBest = Math.min(...pool.map((d) => d.thickness));
  const vBest = Math.min(...pool.map((d) => d.volumeL));
  const load = cfg.prefs.loadProfile ?? 'gaming';
  const quiet = cfg.prefs.noiseMode === 'quiet';
  const splOf = (d: Design) => d.noise?.[load]?.noise.spl ?? 0;
  const splBest = Math.min(...pool.map(splOf));
  for (const d of designs) {
    d.compactCost = alpha * Math.log(d.thickness / tBest) + (1 - alpha) * Math.log(d.volumeL / vBest);
    // Within a noise budget, rank on how cool it runs; in quiet mode, on how quiet it is (10 dB ≈ the thermal score's full range).
    const comfort = quiet ? (splOf(d) - splBest) / 10 : 1 - d.flow.score;
    let cost = (1 - s) * d.compactCost + s * comfort;
    if (d.limited) cost += 1;
    if (d.invalid) cost += 10;
    if (d.checks.some((c) => c.text.startsWith('PSU AC inlet'))) cost += 0.01;
    d.cost = cost;
  }
  return [...designs].sort((a, b) => a.cost - b.cost);
}

/** Designs that differ only in naming (e.g. a "sandwich" with an empty back layer) or trivially collapse to one. */
function signature(d: Design): string {
  const w = d.world;
  const family = d.effectiveTopology === 'direct-stack' ? 'direct' : d.effectiveTopology;
  return [family, Math.round(w.width / 5), Math.round(w.height / 8), Math.round(w.depth / 8), d.profile.slim ? 's' : ''].join('|');
}

export function solve(cfg: DesignConfig, opts: SolveOptions = {}): SolveResult {
  const t0 = performance.now();
  const beamWidth = opts.beamWidth ?? 40;
  const perRun = opts.evaluatePerRun ?? 10;
  const maxResults = opts.maxResults ?? 8;
  const topologies = activeTopologies(cfg);
  const profiles = activeProfiles(cfg);
  const limits = solverLimits(cfg);
  const total = topologies.length * profiles.length;
  const all: Design[] = [];
  let runs = 0;
  for (const topology of topologies) {
    for (const profile of profiles) {
      const built = buildItems({ cfg, topology, profile });
      // One packing run with every radiator and case fan flat on its panel, then one per tilt angle
      // with them all at that angle: a tilted part's bounding box is always larger, so in a shared
      // run the beam would drop every tilted layout before it is evaluated.
      const tiltable = built.some((it) => it.variants.some((v) => v.parts.some((p) => p.tilt)));
      for (const deg of tiltable ? TILT_ANGLES : [0]) {
        const items = built.map((it) => {
          if (!it.variants.some((v) => v.parts.some((p) => p.tilt))) return it;
          // Tilted runs: only that angle (a radiator on through-mode or flat would repeat the flat run).
          const variants = it.variants.filter((v) => v.parts.every((p) => (p.tilt?.deg ?? 0) === deg));
          if (!variants.length) return it;
          return { ...it, variants, minArea: Math.min(...variants.map((v) => v.w * v.h)), minT: Math.min(...variants.map((v) => v.minT)) };
        });
        const nodes = pack(items, {
          twoLayer: isTwoLayer(topology),
          spine: cfg.prefs.spineThickness,
          wall: cfg.prefs.wallThickness,
          alpha: cfg.prefs.thinnessPriority,
          beamWidth: deg ? Math.ceil(beamWidth / 2) : beamWidth,
          limits,
          riserLength: isDirect(topology) ? 0 : cfg.prefs.riserLength,
          requireBack: isTwoLayer(topology),
        });
        nodes.slice(0, deg ? Math.ceil(perRun / 3) : perRun).forEach((n, i) => {
          const d = evaluate(n, { cfg, topology, profile, items }, i);
          if (deg) d.id += `-tilt${deg}`;
          all.push(d);
        });
      }
      runs++;
      opts.onProgress?.(runs, total);
    }
  }
  const ranked = rankDesigns(all, cfg);
  const designs = shortlist(ranked, maxResults);
  // Organic shells: measure the shrinkwrapped outline of every shortlisted design (coarse grid).
  if (isWrap(cfg) && opts.wrapMetrics !== false)
    for (const d of designs) {
      d.wrap = wrapMetrics(d, cfg, cfg.prefs.organic);
      if (cfg.prefs.organic > 0.02) d.wrap.smoothingL = Math.max(0, d.wrap.volumeL - wrapMetrics(d, cfg, 0).volumeL);
    }
  // The design space: every valid layout, minus exact repeats (same size and thermal result).
  const seen = new Set<string>();
  const space = all.filter((d) => {
    if (d.invalid) return false;
    const k = `${d.volumeL.toFixed(2)}|${Math.round(d.thickness)}|${d.flow.worstMargin.toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { designs, space, stats: { runs, evaluated: all.length, ms: performance.now() - t0 } };
}

const TOPO_SHORT: Record<TopologyId, string> = {
  flat: 'Best flat',
  sandwich: 'Best sandwich',
  direct: 'No riser',
  'direct-stack': 'No riser',
};

/** Best match first, then the extremes and the best of each layout family, then the rest by rank. */
export function shortlist(ranked: Design[], maxResults: number): Design[] {
  const seen = new Set<string>();
  const unique: Design[] = [];
  for (const d of ranked) {
    const k = signature(d);
    if (seen.has(k)) continue;
    seen.add(k);
    d.tags = [];
    unique.push(d);
  }
  const ok = unique.filter((d) => !d.invalid);
  const pool = ok.length ? ok : unique;
  const picks: Design[] = [];
  const pick = (d: Design | undefined, tag: string) => {
    if (!d) return;
    if (!d.tags.includes(tag)) d.tags.push(tag);
    if (!picks.includes(d)) picks.push(d);
  };
  pick(pool[0], 'Best match');
  const acceptable = pool.filter((d) => !d.limited);
  const base = acceptable.length ? acceptable : pool;
  pick([...base].sort((a, b) => a.thickness - b.thickness || a.volumeL - b.volumeL)[0], 'Thinnest');
  pick([...base].sort((a, b) => a.volumeL - b.volumeL || a.thickness - b.thickness)[0], 'Smallest');
  pick([...pool].sort((a, b) => b.flow.score - a.flow.score)[0], 'Coolest');
  for (const t of ['flat', 'sandwich', 'direct'] as TopologyId[]) {
    pick(
      pool.find((d) => (t === 'direct' ? d.effectiveTopology === 'direct' || d.effectiveTopology === 'direct-stack' : d.effectiveTopology === t)),
      TOPO_SHORT[t],
    );
  }
  for (const d of pool) {
    if (picks.length >= maxResults) break;
    if (!picks.includes(d)) picks.push(d);
  }
  // Keep rank order so the list reads best-first.
  return picks.sort((a, b) => a.cost - b.cost);
}
