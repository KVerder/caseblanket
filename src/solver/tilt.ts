import { localToWorld, type Box, type Frame, type Vec3 } from './geometry';

/**
 * Tilted radiators and case fans. A part tilts about its own width axis (e2) by `deg`: the end at
 * e1 = 0 stays against its vented panel (local +e3 points at the panel) and the e1 = L end lifts
 * away into the case. A printed wedge frame between the fans and the panel holds it and ducts the
 * vent to the fans.
 *
 * Coordinates: the part's own (untilted) local box is x ∈ [0, L], y ∈ [0, W], z ∈ [0, T], with z = T
 * the face toward the panel. The packer sees the axis-aligned box around the tilted part, of size
 * tiltDims(); its local coordinates (u, y, w) map to the world through the part's frame as usual.
 */

/** Angles tried, degrees (0 = flat against the panel). */
export const TILT_ANGLES = [0, 15, 30, 45];

/** Printed frame plate between the fans and the panel, mm. */
export const TILT_PLATE = 3;

export interface Tilt {
  deg: number;
  /** The part's own size [L, W, T] (T includes the frame plate). */
  size: Vec3;
  /** Clearances along the part's own axes, mm: below 0 (lo) and past the size (hi) on each. */
  clear?: { lo: Vec3; hi: Vec3 };
}

/** Size of the axis-aligned box around a part of `size` tilted by `deg`. */
export function tiltDims(size: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const [L, W, T] = size;
  return [L * Math.cos(t) + T * Math.sin(t), W, L * Math.sin(t) + T * Math.cos(t)];
}

/** Part-local (untilted) point → local point in the axis-aligned box around it. */
export function tiltToBox(tilt: Tilt, p: Vec3): Vec3 {
  const t = (tilt.deg * Math.PI) / 180;
  const [, , T] = tilt.size;
  const H = tiltDims(tilt.size, tilt.deg)[2];
  const c = Math.cos(t);
  const s = Math.sin(t);
  // A rotation by deg about e2: distance from the panel x·s + r·c, along it x·c − r·s (+ T·s so it starts at 0).
  const r = T - p[2];
  return [p[0] * c - r * s + T * s, p[1], H - p[0] * s - r * c];
}

/** Inverse of tiltToBox. */
export function boxToTilt(tilt: Tilt, q: Vec3): Vec3 {
  const t = (tilt.deg * Math.PI) / 180;
  const [, , T] = tilt.size;
  const H = tiltDims(tilt.size, tilt.deg)[2];
  const c = Math.cos(t);
  const s = Math.sin(t);
  // q0 − T s = x c − r s, H − q2 = x s + r c, with r = T − z.
  const a = q[0] - T * s;
  const b = H - q[2];
  const x = a * c + b * s;
  const r = -a * s + b * c;
  return [x, q[1], T - r];
}

interface Posed {
  frame: Frame;
  body: Box;
  tilt?: Tilt;
}

/** A point in a part's own local coordinates → world (tilted or not). */
export function partPoint(part: Posed, p: Vec3): Vec3 {
  return localToWorld(part.frame, part.body, part.tilt ? tiltToBox(part.tilt, p) : p);
}

/** World → the part's own local coordinates (inverse of partPoint). */
export function partLocal(part: Posed, w: Vec3): Vec3 {
  const q: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = part.frame.d[i];
    const a = d >> 1;
    q[i] = d & 1 ? part.body.max[a] - w[a] : w[a] - part.body.min[a];
  }
  return part.tilt ? boxToTilt(part.tilt, q) : q;
}

/** World direction of a local axis (0, 1, 2) of a part, tilted or not. */
export function partAxis(part: Posed, k: 0 | 1 | 2): Vec3 {
  const o = partPoint(part, [0, 0, 0]);
  const e: Vec3 = [0, 0, 0];
  e[k] = 1;
  const p = partPoint(part, e);
  return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
}

/** Mean gap between a tilted part's panel face and the panel (the wedge), mm. */
export function tiltMeanGap(tilt: Tilt | undefined): number {
  if (!tilt) return 0;
  return (tilt.size[0] * Math.sin((tilt.deg * Math.PI) / 180)) / 2;
}

type SdfFn = (p: Vec3) => number;

/** Signed distance to an axis-aligned box rounded by r (negative inside). */
function sdBox(p: Vec3, min: Vec3, max: Vec3, r = 0): number {
  let out = 0;
  let inMax = -Infinity;
  for (let a = 0; a < 3; a++) {
    const c = (min[a] + max[a]) / 2;
    const h = Math.max(0, (max[a] - min[a]) / 2 - r);
    const q = Math.abs(p[a] - c) - h;
    if (q > 0) out += q * q;
    inMax = Math.max(inMax, q);
  }
  return Math.sqrt(out) + Math.min(inMax, 0) - r;
}

/**
 * What the shell must hold for a tilted part, following the part rather than the box around it:
 *   body       the part itself, an oriented box in its own coordinates
 *   clearance  the same with its clearances (plenum behind, port room, tolerance)
 *   wedge      the frame's wedge between the fans and the panel: the box around the part on the
 *              panel side of the frame plate (z ≥ T), which the frame closes off
 * The empty corner of the box behind the tilt is in none of them, so a shrinkwrap or a sculpted
 * shell slants with the part there. All three are exact distances inside (convex shapes; the
 * part's coordinates are a rotation of the world's).
 */
export function tiltedShapes(part: Posed & { clearance: Box }, round = 0): { body: SdfFn; clearance: SdfFn; wedge: SdfFn; points: Vec3[] } {
  const tilt = part.tilt!;
  const [L, W, T] = tilt.size;
  const lo = tilt.clear?.lo ?? [0, 0, 0];
  const hi = tilt.clear?.hi ?? [0, 0, 0];
  const cMin: Vec3 = [-lo[0], -lo[1], -lo[2]];
  const cMax: Vec3 = [L + hi[0], W + hi[1], T + hi[2]];
  const body: SdfFn = (p) => sdBox(partLocal(part, p), [0, 0, 0], [L, W, T], Math.min(round, W / 2));
  const clearance: SdfFn = (p) => sdBox(partLocal(part, p), cMin, cMax, Math.min(round, W / 2));
  const box = part.clearance;
  const wedge: SdfFn = (p) => Math.max(sdBox(p, box.min, box.max), T - partLocal(part, p)[2]);
  // Points for the sculpted shells: the clearance box's edges (sampled), and the wedge's vertices
  // (the box corners on the panel side of the plate plane, and where that plane cuts the box edges).
  const points: Vec3[] = [];
  const S = 4;
  for (let i = 0; i <= S; i++)
    for (let j = 0; j <= S; j++)
      for (let k = 0; k <= S; k++) {
        if ([i, j, k].filter((x) => x === 0 || x === S).length < 2) continue;
        points.push(partPoint(part, [cMin[0] + ((cMax[0] - cMin[0]) * i) / S, cMin[1] + ((cMax[1] - cMin[1]) * j) / S, cMin[2] + ((cMax[2] - cMin[2]) * k) / S]));
      }
  const z = (p: Vec3) => partLocal(part, p)[2];
  const corners: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const w of [box.min[2], box.max[2]]) corners.push([x, y, w]);
  for (const c of corners) if (z(c) >= T - 1e-6) points.push(c);
  for (let a = 0; a < corners.length; a++)
    for (let b = a + 1; b < corners.length; b++) {
      const A = corners[a];
      const B = corners[b];
      if ([0, 1, 2].filter((q) => A[q] !== B[q]).length !== 1) continue; // box edges only
      const za = z(A) - T;
      const zb = z(B) - T;
      if (za * zb >= 0) continue;
      const t = za / (za - zb);
      points.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
    }
  return { body, clearance, wedge, points };
}
