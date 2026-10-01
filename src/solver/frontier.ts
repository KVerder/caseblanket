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
 * Designs worth re-scoring with the 3D simulation, at most `n`. The airflow model's ranking is not
 * trusted to pre-select (it disagrees with the 3D sim on which designs are coolest), so the pick is
 * spread over size: the model's own frontier first, then the best few of each size band.
 */
export function rescoreCandidates<T extends SpacePoint>(points: T[], n = 20, bands = 8): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (p: T) => {
    if (out.length < n && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  };
  frontier(points).forEach(add);
  const bySize = [...points].sort((a, b) => a.size - b.size);
  const per = Math.max(1, Math.ceil((n - out.length) / bands));
  for (let b = 0; b < bands; b++) {
    const band = bySize.slice(Math.floor((b * bySize.length) / bands), Math.floor(((b + 1) * bySize.length) / bands));
    band.sort((x, y) => y.margin - x.margin).slice(0, per).forEach(add);
  }
  for (const p of bySize) add(p);
  return out;
}
