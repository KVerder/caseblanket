import type { Design } from './evaluate';

export type SizeAxis = 'volume' | 'thickness';

export interface SpacePoint {
  id: string;
  /** Box envelope size on the chosen axis (L or mm). */
  size: number;
  /** Tightest part's share of its budget left (1 = at room temperature, 0 = at its limit). */
  margin: number;
}

export const sizeOf = (d: Design, axis: SizeAxis) => (axis === 'volume' ? d.volumeL : d.thickness);

/**
 * The trade-off frontier: designs no other design beats on both size (smaller) and thermal
 * margin (larger). Sorted from smallest to coolest.
 */
export function frontier<T extends SpacePoint>(points: T[]): T[] {
  const sorted = [...points].sort((a, b) => a.size - b.size || b.margin - a.margin);
  const out: T[] = [];
  let best = -Infinity;
  for (const p of sorted) {
    if (p.margin > best + 1e-9) {
      out.push(p);
      best = p.margin;
    }
  }
  return out;
}

export function spacePoints(designs: Design[], axis: SizeAxis): SpacePoint[] {
  return designs.map((d) => ({ id: d.id, size: sizeOf(d, axis), margin: d.flow.worstMargin }));
}

/**
 * A design's flow scheme, coarsely: layout family, where each radiator sits, which way its fans
 * blow and how far it tilts, and how many case fans blow in and out. In the 3D simulation the
 * scheme matters more than the details the airflow model ranks on (iteration-3 thermal sweep: the
 * coolest layouts in 3D sat at the model's ranks 1–68 of ~150), so re-scoring samples every scheme.
 */
export function thermalScheme(d: Design): string {
  const family = d.effectiveTopology === 'direct-stack' ? 'direct' : d.effectiveTopology;
  const rads = d.parts
    .filter((p) => p.kind === 'rad-cpu' || p.kind === 'rad-gpu')
    .map((p) => `${p.kind}@${p.face ?? '-'}:${p.airflow ?? '?'}/${p.tilt?.deg ?? 0}`)
    .sort();
  const fans = d.parts.filter((p) => p.kind === 'case-fan');
  const fanIn = fans.filter((p) => p.airflow === 'in').length;
  return [family, ...rads, `fans ${fanIn}in ${fans.length - fanIn}out`].join(' ');
}

/**
 * Designs worth re-scoring with the 3D simulation, at most `n`. The airflow model's ranking is not
 * trusted to pre-select (it disagrees with the 3D sim on which designs are coolest), so the pick is
 * spread: the model's own frontier first, then (given `scheme`) the model's best design of each
 * flow scheme, then the best few of each size band.
 */
export function rescoreCandidates<T extends SpacePoint>(points: T[], n = 20, bands = 8, scheme?: (p: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (p: T) => {
    if (out.length < n && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  };
  frontier(points).forEach(add);
  if (scheme) {
    const best = new Map<string, T>();
    for (const p of points) {
      const k = scheme(p);
      const b = best.get(k);
      if (!b || p.margin > b.margin) best.set(k, p);
    }
    // Schemes the frontier already covers need no second representative.
    const covered = new Set(out.map(scheme));
    [...best.entries()]
      .filter(([k]) => !covered.has(k))
      .map(([, p]) => p)
      .sort((a, b) => b.margin - a.margin)
      .forEach(add);
  }
  const bySize = [...points].sort((a, b) => a.size - b.size);
  const per = Math.max(1, Math.ceil((n - out.length) / bands));
  for (let b = 0; b < bands; b++) {
    const band = bySize.slice(Math.floor((b * bySize.length) / bands), Math.floor(((b + 1) * bySize.length) / bands));
    band.sort((x, y) => y.margin - x.margin).slice(0, per).forEach(add);
  }
  for (const p of bySize) add(p);
  return out;
}
