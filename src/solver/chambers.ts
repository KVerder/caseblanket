import type { DesignConfig } from '../model/types';
import type { Design, PlacedPart, Vent } from './evaluate';
import { axisOf, signOf, wallAxes, type Axis, type Box, type Dir, type Vec3 } from './geometry';
import { hosePaths, gpuCablePath, type HosePath } from './hoses';

/**
 * Internal partitions that split the case into air chambers.
 *
 * A partition is a flat printed wall across one region of the case, perpendicular to a solver
 * axis, placed only in a gap that cuts no part body and no functional clearance (fan gaps, cable
 * room). Up to two partitions give up to three chambers: the second one splits one side of the
 * first. Hoses, cables and a riser that cross a partition go through grommeted pass-throughs,
 * which leak; so does the joint along the partition's edge. All leak figures are estimates.
 */

/** Printed partition wall thickness, mm (estimate for a 3-perimeter wall). */
export const PARTITION_THICKNESS = 1.2;
/** Joint leakage along a partition's edge: an effective gap, mm (estimate). */
export const PARTITION_SEAM_GAP = 0.3;
/** Leak area per grommeted hose or cable pass-through, m² (estimate, ~1.5 cm²). */
export const PASS_THROUGH_LEAK = 1.5e-4;
/** Leak area where the riser ribbon or PSU cable bundle crosses, m² (estimate, ~3 cm²). */
export const BUNDLE_LEAK = 3e-4;
/** Seam leakage of the whole case to the room, m² (as the one-zone model). */
export const CASE_LEAK = 0.001;

export interface Partition {
  axis: Axis;
  at: number;
  /** Extent of the plate: the region it splits. */
  region: Box;
}

export interface Chamber {
  id: string;
  label: string;
  box: Box;
  /** Placed part ids whose bodies sit in this chamber. */
  parts: string[];
}

export interface ChamberLayout {
  cuts: Partition[];
  chambers: Chamber[];
  /** Openings between chambers (pass-throughs and seams). */
  links: { a: number; b: number; area: number; label: string }[];
  /** Plate area, mm², for weight and print cost. */
  plateAreaMm2: number;
}

const centre = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const inside = (p: Vec3, b: Box) => p.every((x, a) => x >= b.min[a] - 1e-6 && x <= b.max[a] + 1e-6);

/** Clearance box with the shared tolerance band taken off, so a partition can sit between neighbours. */
function functional(p: PlacedPart, tol: number): Box {
  const min = p.clearance.min.map((x, a) => Math.min(p.body.min[a], x + tol)) as Vec3;
  const max = p.clearance.max.map((x, a) => Math.max(p.body.max[a], x - tol)) as Vec3;
  return { min, max };
}

/** Gaps along `axis` inside `region` where a partition fits between the parts. */
function planeCandidates(region: Box, parts: PlacedPart[], axis: Axis, tol: number): number[] {
  const lo = region.min[axis] + 5;
  const hi = region.max[axis] - 5;
  const spans = parts
    .map((p) => functional(p, tol))
    .map((b) => [b.min[axis], b.max[axis]] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const out: number[] = [];
  let reach = region.min[axis];
  for (const [a, b] of spans) {
    if (a - reach >= PARTITION_THICKNESS) {
      const c = (Math.max(reach, lo) + Math.min(a, hi)) / 2;
      if (c > lo && c < hi && a - reach >= PARTITION_THICKNESS) out.push(c);
    }
    reach = Math.max(reach, b);
  }
  return out;
}

function split(region: Box, axis: Axis, at: number): [Box, Box] {
  const a: Box = { min: [...region.min] as Vec3, max: [...region.max] as Vec3 };
  const b: Box = { min: [...region.min] as Vec3, max: [...region.max] as Vec3 };
  a.max[axis] = at;
  b.min[axis] = at;
  return [a, b];
}

/** Does a routed path cross the plane inside the region? Counts crossings. */
function crossings(h: HosePath, cut: Partition): number {
  let n = 0;
  for (let i = 1; i < h.points.length; i++) {
    const p = h.points[i - 1];
    const q = h.points[i];
    const sp = p[cut.axis] - cut.at;
    const sq = q[cut.axis] - cut.at;
    if (sp * sq >= 0) continue;
    const t = sp / (sp - sq);
    const x: Vec3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    if (inside(x, cut.region)) n++;
  }
  return n;
}

const HEAT_ORDER = ['rad-gpu', 'rad-cpu', 'gpu', 'psu', 'board'];
const NAMES: Record<string, string> = { 'rad-gpu': 'GPU radiator', 'rad-cpu': 'CPU radiator', gpu: 'Graphics card', psu: 'Power supply', board: 'Motherboard' };

function chamberLabel(parts: string[]): string {
  const main = HEAT_ORDER.find((k) => parts.includes(k));
  return main ? `${NAMES[main]} chamber` : 'Chamber';
}

function layoutFrom(design: Design, cfg: DesignConfig, cuts: Partition[], regions: Box[]): ChamberLayout | null {
  const chambers: Chamber[] = regions.map((box, i) => {
    const parts = design.parts.filter((p) => inside(centre(p.body), box)).map((p) => p.id);
    return { id: `z${i}`, label: chamberLabel(parts), box, parts };
  });
  // Every chamber must hold a part; an empty chamber is just a wall in the way.
  if (chambers.some((c) => c.parts.length === 0)) return null;
  const zoneOfPart = (id: string) => chambers.findIndex((c) => c.parts.includes(id));
  const paths = [...hosePaths(design, cfg)];
  const cable = gpuCablePath(design, cfg);
  if (cable) paths.push(cable);
  const links: ChamberLayout['links'] = [];
  let plateAreaMm2 = 0;
  for (const cut of cuts) {
    const [xa, ya] = wallAxes(cut.axis);
    const w = cut.region.max[xa] - cut.region.min[xa];
    const h = cut.region.max[ya] - cut.region.min[ya];
    plateAreaMm2 += w * h;
    // Pairs of chambers facing each other across this plate.
    const sides: [number, number][] = [];
    // A cut may face several chambers on one side (when the other side was split later).
    const near = chambers.map((ch, i) => ({ ch, i })).filter(({ ch }) => Math.abs(ch.box.max[cut.axis] - cut.at) < 1e-6 || Math.abs(ch.box.min[cut.axis] - cut.at) < 1e-6);
    for (const A of near)
      for (const B of near) {
        if (A.i >= B.i) continue;
        if (Math.sign(centre(A.ch.box)[cut.axis] - cut.at) === Math.sign(centre(B.ch.box)[cut.axis] - cut.at)) continue;
        // Shared face area between A and B on the plate.
        const ox = Math.min(A.ch.box.max[xa], B.ch.box.max[xa]) - Math.max(A.ch.box.min[xa], B.ch.box.min[xa]);
        const oy = Math.min(A.ch.box.max[ya], B.ch.box.max[ya]) - Math.max(A.ch.box.min[ya], B.ch.box.min[ya]);
        if (ox > 1 && oy > 1) sides.push([A.i, B.i]);
      }
    for (const [a, b] of sides) {
      const ox = Math.min(chambers[a].box.max[xa], chambers[b].box.max[xa]) - Math.max(chambers[a].box.min[xa], chambers[b].box.min[xa]);
      const oy = Math.min(chambers[a].box.max[ya], chambers[b].box.max[ya]) - Math.max(chambers[a].box.min[ya], chambers[b].box.min[ya]);
      let area = 2 * (ox + oy) * PARTITION_SEAM_GAP * 1e-6;
      const passes = paths.reduce((n, p) => n + crossings(p, cut), 0);
      area += passes * PASS_THROUGH_LEAK;
      const bundles: string[] = [];
      const pb = zoneOfPart('board');
      const pg = zoneOfPart('gpu');
      const pp = zoneOfPart('psu');
      const across = (x: number, y: number) => (x === a && y === b) || (x === b && y === a);
      if (across(pb, pp)) bundles.push('PSU cables');
      if (across(pb, pg) && !isDirect(design)) bundles.push('riser');
      area += bundles.length * BUNDLE_LEAK;
      const what = [passes ? `${passes} pass-through${passes > 1 ? 's' : ''}` : '', ...bundles].filter(Boolean).join(', ');
      links.push({ a, b, area, label: `${chambers[a].label} ↔ ${chambers[b].label}${what ? ` (${what})` : ''}` });
    }
  }
  return { cuts, chambers, links, plateAreaMm2 };
}

const isDirect = (d: Design) => d.effectiveTopology === 'direct' || d.effectiveTopology === 'direct-stack';

/** Every buildable 2- and 3-chamber layout, deduplicated by which parts end up together. */
export function chamberLayouts(design: Design, cfg: DesignConfig, max = 30): ChamberLayout[] {
  const tol = cfg.prefs.tolerance / 2;
  const all: Box = { min: [0, 0, 0], max: [...design.interior] as Vec3 };
  const seen = new Set<string>();
  const out: ChamberLayout[] = [];
  const key = (l: ChamberLayout) =>
    l.chambers
      .map((c) => [...c.parts].sort().join('+'))
      .sort()
      .join('|');
  const partsIn = (r: Box) => design.parts.filter((p) => inside(centre(p.body), r));
  const push = (l: ChamberLayout | null) => {
    if (!l || out.length >= max) return;
    const k = key(l);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(l);
  };
  for (const a1 of [0, 1, 2] as Axis[]) {
    for (const c1 of planeCandidates(all, design.parts, a1, tol)) {
      const cut1: Partition = { axis: a1, at: c1, region: all };
      const [r1, r2] = split(all, a1, c1);
      push(layoutFrom(design, cfg, [cut1], [r1, r2]));
      // A second wall splits one side of the first.
      for (const [side, other] of [
        [r1, r2],
        [r2, r1],
      ] as [Box, Box][]) {
        const ps = partsIn(side);
        if (ps.length < 2) continue;
        for (const a2 of [0, 1, 2] as Axis[]) {
          if (a2 === a1) continue;
          for (const c2 of planeCandidates(side, ps, a2, tol)) {
            const [s1, s2] = split(side, a2, c2);
            push(layoutFrom(design, cfg, [cut1, { axis: a2, at: c2, region: side }], [s1, s2, other]));
          }
        }
      }
    }
  }
  return out;
}

/** Area of a vent (thin box on its wall) inside a chamber, mm². */
export function ventAreaIn(v: Vent, design: Design, box: Box): number {
  const a = axisOf(v.wall);
  const at = signOf(v.wall) > 0 ? design.interior[a] : 0;
  if (at < box.min[a] - 1e-6 || at > box.max[a] + 1e-6) return 0;
  const [xa, ya] = wallAxes(a);
  const ox = Math.min(v.rect.x1, box.max[xa]) - Math.max(v.rect.x0, box.min[xa]);
  const oy = Math.min(v.rect.y1, box.max[ya]) - Math.max(v.rect.y0, box.min[ya]);
  return Math.max(0, ox) * Math.max(0, oy);
}

/** Share of the case's outer wall area that bounds a chamber (for seam leakage). */
export function wallShare(design: Design, box: Box): number {
  let mine = 0;
  let total = 0;
  for (const w of [0, 1, 2, 3, 4, 5] as Dir[]) {
    const a = axisOf(w);
    const [xa, ya] = wallAxes(a);
    const at = signOf(w) > 0 ? design.interior[a] : 0;
    const full = design.interior[xa] * design.interior[ya];
    total += full;
    if (Math.abs((signOf(w) > 0 ? box.max[a] : box.min[a]) - at) < 1e-6) mine += (box.max[xa] - box.min[xa]) * (box.max[ya] - box.min[ya]);
  }
  return total > 0 ? mine / total : 1;
}
