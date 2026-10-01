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
