import type { DesignConfig, TopologyId } from '../model/types';
import { evaluate, type Design } from './evaluate';
import { buildItems, isDirect, isTwoLayer, PROFILES, type Profile } from './items';
import { pack } from './pack';

export interface SolveOptions {
  beamWidth?: number;
  /** Designs evaluated in full per (topology, profile) run. */
  evaluatePerRun?: number;
  maxResults?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SolveResult {
  designs: Design[];
  stats: { runs: number; evaluated: number; ms: number };
}

export const ALL_TOPOLOGIES: TopologyId[] = ['flat', 'sandwich', 'direct', 'direct-stack'];

/** Interior limits along the solver axes (u, v, t) implied by the world limits and orientation. */
export function solverLimits(cfg: DesignConfig): [number, number, number] {
  const p = cfg.prefs;
  return p.orientation === 'tower' ? [p.maxDepth, p.maxHeight, p.maxWidth] : [p.maxDepth, p.maxWidth, p.maxHeight];
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
  for (const d of designs) {
    d.compactCost = alpha * Math.log(d.thickness / tBest) + (1 - alpha) * Math.log(d.volumeL / vBest);
    let cost = (1 - s) * d.compactCost + s * (1 - d.flow.score);
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
  const topologies = ALL_TOPOLOGIES.filter((t) => cfg.prefs.topologies[t]);
  const profiles = activeProfiles(cfg);
  const limits = solverLimits(cfg);
  const total = topologies.length * profiles.length;
  const all: Design[] = [];
  let runs = 0;
  for (const topology of topologies) {
    for (const profile of profiles) {
      const items = buildItems({ cfg, topology, profile });
      const nodes = pack(items, {
        twoLayer: isTwoLayer(topology),
        spine: cfg.prefs.spineThickness,
        wall: cfg.prefs.wallThickness,
        alpha: cfg.prefs.thinnessPriority,
        beamWidth,
        limits,
        riserLength: isDirect(topology) ? 0 : cfg.prefs.riserLength,
        requireBack: isTwoLayer(topology),
      });
      nodes.slice(0, perRun).forEach((n, i) => all.push(evaluate(n, { cfg, topology, profile, items }, i)));
      runs++;
      opts.onProgress?.(runs, total);
    }
  }
  const ranked = rankDesigns(all, cfg);
  return { designs: shortlist(ranked, maxResults), stats: { runs, evaluated: all.length, ms: performance.now() - t0 } };
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
