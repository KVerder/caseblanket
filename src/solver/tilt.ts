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
