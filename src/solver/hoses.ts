import type { DesignConfig } from '../model/types';
import type { Design, PlacedPart } from './evaluate';
import { dirVec, localBoxToWorld, localToWorld, sideToWorld, axisOf, signOf, type Box, type Dir, type Vec3 } from './geometry';
import { partPoint } from './tilt';
import { boardStack } from './items';

/** Outer radius of an AIO hose, mm (typical ~12 mm sleeved tubing; estimate). */
export const HOSE_RADIUS = 6;
/** Smallest bend radius an AIO hose takes without kinking, mm (estimate). */
export const HOSE_MIN_BEND = 35;
/** Radius of the GPU power cable bundle, mm (estimate). */
export const CABLE_RADIUS = 7;
/** Length of card edge the power connector and its plug occupy, mm (estimate). */
export const CONNECTOR_SPAN = 50;

export interface HosePath {
  /** Dense polyline in solver coordinates (u, v, t), mm. */
  points: Vec3[];
  radius: number;
  kind: 'hose' | 'cable';
  /** Which AIO the hose belongs to. */
  loop?: 'cpu' | 'gpu';
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Centripetal Catmull-Rom through `pts` (end points duplicated), `per` samples per span. */
function catmullRom(pts: Vec3[], per: number): Vec3[] {
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  const out: Vec3[] = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const t0 = 0;
    const t1 = t0 + Math.sqrt(len(sub(p1, p0))) || t0 + 1e-3;
    const t2 = t1 + (Math.sqrt(len(sub(p2, p1))) || 1e-3);
    const t3 = t2 + (Math.sqrt(len(sub(p3, p2))) || 1e-3);
    const lerp = (a: Vec3, b: Vec3, ta: number, tb: number, t: number): Vec3 => {
      const w = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    };
    for (let s = 0; s < per; s++) {
      const t = t1 + ((t2 - t1) * s) / per;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      out.push(lerp(b1, b2, t1, t2, t));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function pair(design: Design, from: Vec3, fromDir: Vec3, rad: PlacedPart, reachOut: number, loop: 'cpu' | 'gpu'): HosePath[] {
  const r = rad.radiator!;
  const m = 7;
  const lo: Vec3 = [m, m, m];
  const hi: Vec3 = [design.interior[0] - m, design.interior[1] - m, design.interior[2] - m];
  const clamp = (p: Vec3): Vec3 => [0, 1, 2].map((a) => Math.min(hi[a], Math.max(lo[a], p[a]))) as Vec3;
  const portReach = Math.max(12, Math.min(40, r.portClearance * 0.9));
  // Spread the two hoses across the axis least aligned with where they come from.
  const side: Vec3 = Math.abs(fromDir[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const out: HosePath[] = [];
  for (const off of [-9, 9]) {
    // Ports at the +e1 end (tilted radiators: the end lifted off the panel).
    const size = rad.tilt?.size ?? rad.size;
    const port = partPoint(rad, [size[0] + 4, size[1] / 2 + off * 1.5, r.coreThickness / 2]);
    const portOut = norm(sub(partPoint(rad, [size[0] + 40, size[1] / 2 + off * 1.5, r.coreThickness / 2]), port));
    const a = clamp(add(from, side, off * 0.8));
    const b = clamp(add(a, fromDir, Math.max(12, Math.min(35, reachOut * 0.9))));
    const c = clamp(add(port, portOut, portReach));
    const mid = clamp([(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2]);
    out.push({ points: catmullRom([a, b, mid, c, clamp(port)], 12), radius: HOSE_RADIUS, kind: 'hose', loop });
  }
  return out;
}

/** AIO hose runs (CPU pump → radiator, GPU block → radiator), inside the interior box. */
export function hosePaths(design: Design, cfg: DesignConfig): HosePath[] {
  const out: HosePath[] = [];
  const board = design.parts.find((p) => p.kind === 'board');
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  const radCpu = design.parts.find((p) => p.kind === 'rad-cpu');
  const radGpu = design.parts.find((p) => p.kind === 'rad-gpu');
  if (board && radCpu && cfg.parts.cooler.kind === 'aio') {
    const s = boardStack(cfg, design.profile.extraGap);
    const bd = cfg.parts.board;
    const top: Vec3 = [bd.socketU + 20, s.pcbDv + bd.socketV, s.surface + bd.socketStack + cfg.parts.cooler.height * 0.7];
    out.push(...pair(design, localToWorld(board.frame, board.body, top), [0, 0, 1], radCpu, 30, 'cpu'));
  }
  if (gpu && radGpu && cfg.parts.gpu.cooling === 'aio') {
    const g = cfg.parts.gpu;
    const exit: Vec3 = g.tubeExit === 'end' ? [g.length, g.height * 0.55, g.thickness * 0.6] : [g.length * 0.62, g.height, g.thickness * 0.6];
    const d: Dir = g.tubeExit === 'end' ? gpu.frame.d[0] : gpu.frame.d[1];
    out.push(...pair(design, localToWorld(gpu.frame, gpu.body, exit), dirVec(d), radGpu, g.tubeClearance, 'gpu'));
  }
  return out;
}

/** The GPU power connector's plug and bend room: a local box on the card's top edge, not the whole edge. */
export function connectorBox(design: Design, cfg: DesignConfig): Box | null {
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  const g = cfg.parts.gpu;
  if (!gpu || g.connectorClearance <= 0) return null;
  const c = (g.connectorPos ?? 0.7) * g.length;
  const lo: Vec3 = [Math.max(0, c - CONNECTOR_SPAN / 2), g.height, 0];
  const hi: Vec3 = [Math.min(g.length, c + CONNECTOR_SPAN / 2), g.height + g.connectorClearance, g.thickness];
  return localBoxToWorld(gpu.frame, gpu.body, lo, hi);
}

/** The card's clearance box without the full-length connector strip (the connector box replaces it). */
export function gpuWrapClearance(design: Design, cfg: DesignConfig): Box | null {
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  if (!gpu) return null;
  const top = sideToWorld(gpu.frame, 2);
  const a = axisOf(top);
  const b: Box = { min: [...gpu.clearance.min] as Vec3, max: [...gpu.clearance.max] as Vec3 };
  const tol = cfg.prefs.tolerance / 2;
  const tubeTop = cfg.parts.gpu.cooling === 'aio' && cfg.parts.gpu.tubeExit === 'top';
  if (tubeTop) return b;
  if (signOf(top) > 0) b.max[a] = Math.min(b.max[a], gpu.body.max[a] + tol);
  else b.min[a] = Math.max(b.min[a], gpu.body.min[a] - tol);
  return b;
}

/** Power cable from the card's connector to the PSU's cable face. */
export function gpuCablePath(design: Design, cfg: DesignConfig): HosePath | null {
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  const psu = design.parts.find((p) => p.kind === 'psu');
  const box = connectorBox(design, cfg);
  if (!gpu || !psu || !box) return null;
  const m = CABLE_RADIUS + 1;
  const clamp = (p: Vec3): Vec3 => [0, 1, 2].map((a) => Math.min(design.interior[a] - m, Math.max(m, p[a]))) as Vec3;
  const up = dirVec(sideToWorld(gpu.frame, 2));
  const centre: Vec3 = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2) as Vec3;
  // Leave the plug straight for most of the bend room, then head for the PSU.
  const start = clamp(add(centre, up, -cfg.parts.gpu.connectorClearance / 2 + CABLE_RADIUS));
  const out1 = clamp(add(centre, up, cfg.parts.gpu.connectorClearance / 2 - CABLE_RADIUS));
  const p = cfg.parts.psu;
  const face = localToWorld(psu.frame, psu.body, [p.length, p.width / 2, p.height / 2]);
  const faceOut = dirVec(sideToWorld(psu.frame, 0));
  const end = clamp(add(face, faceOut, CABLE_RADIUS));
  const out2 = clamp(add(face, faceOut, Math.max(CABLE_RADIUS, p.cableClearance - CABLE_RADIUS)));
  const mid = clamp([(out1[0] + out2[0]) / 2, (out1[1] + out2[1]) / 2, (out1[2] + out2[2]) / 2]);
  return { points: catmullRom([start, out1, mid, out2, end], 10), radius: CABLE_RADIUS, kind: 'cable' };
}

/** Everything routed through the case that the shell must enclose. */
export function routedPaths(design: Design, cfg: DesignConfig): HosePath[] {
  const cable = gpuCablePath(design, cfg);
  return cable ? [...hosePaths(design, cfg), cable] : hosePaths(design, cfg);
}

export function pathLength(h: HosePath): number {
  let s = 0;
  for (let i = 1; i < h.points.length; i++) s += len(sub(h.points[i], h.points[i - 1]));
  return s;
}

/** Tightest bend along a path, from the circumradius of consecutive point triples ~15 mm apart. */
export function minBendRadius(h: HosePath): number {
  // Resample at even spacing so the estimate does not depend on the spline parameterisation.
  const step = 15;
  const pts: Vec3[] = [h.points[0]];
  let acc = 0;
  for (let i = 1; i < h.points.length; i++) {
    acc += len(sub(h.points[i], h.points[i - 1]));
    if (acc >= step) {
      pts.push(h.points[i]);
      acc = 0;
    }
  }
  let best = Infinity;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = len(sub(pts[i], pts[i - 1]));
    const b = len(sub(pts[i + 1], pts[i]));
    const c = len(sub(pts[i + 1], pts[i - 1]));
    const s = (a + b + c) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)));
    if (area < 1e-6) continue;
    best = Math.min(best, (a * b * c) / (4 * area));
  }
  return best;
}

/** Signed distance to a hose (capsule chain). */
export function hoseDistance(h: HosePath, p: Vec3): number {
  let best = Infinity;
  const pts = h.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const ab = sub(pts[i + 1], a);
    const ap = sub(p, a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = l2 > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
    const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
    if (d < best) best = d;
  }
  return best - h.radius;
}

/** Bounding box of a hose including its radius. */
export function hoseBox(h: HosePath) {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of h.points)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a] - h.radius);
      max[a] = Math.max(max[a], p[a] + h.radius);
    }
  return { min, max };
}
