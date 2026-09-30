// Solver frame: u = depth (u = 0 is the rear/I-O wall), v = the other in-plane axis,
// t = the stacking ("thickness") axis. Right-handed: u × v = t.

export type Axis = 0 | 1 | 2;
/** 0:+u 1:-u 2:+v 3:-v 4:+t 5:-t. Local sides use the same encoding on e1/e2/e3. */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5;

export const DIR_NAMES = ['+u', '-u', '+v', '-v', '+t', '-t'] as const;

export const axisOf = (d: Dir): Axis => (d >> 1) as Axis;
export const signOf = (d: Dir): 1 | -1 => (d & 1 ? -1 : 1);
export const makeDir = (axis: Axis, sign: number): Dir => (axis * 2 + (sign < 0 ? 1 : 0)) as Dir;
export const opposite = (d: Dir): Dir => (d ^ 1) as Dir;

export type Vec3 = [number, number, number];

export function dirVec(d: Dir): Vec3 {
  const v: Vec3 = [0, 0, 0];
  v[axisOf(d)] = signOf(d);
  return v;
}

function vecDir(v: Vec3): Dir {
  for (let a = 0; a < 3; a++) if (v[a] !== 0) return makeDir(a as Axis, v[a]);
  throw new Error('zero vector');
}

export function crossDir(a: Dir, b: Dir): Dir {
  const x = dirVec(a);
  const y = dirVec(b);
  return vecDir([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]);
}

/** World direction of local +e1, +e2, +e3. */
export interface Frame {
  d: [Dir, Dir, Dir];
}

export const IDENTITY: Frame = { d: [0, 2, 4] };

export function sideToWorld(frame: Frame, localSide: Dir): Dir {
  const d = frame.d[localSide >> 1];
  return localSide & 1 ? opposite(d) : d;
}

/** Right-handed frames (e3 = e1 × e2): 24 of them. */
export function allFrames(): Frame[] {
  const out: Frame[] = [];
  for (let d1 = 0; d1 < 6; d1++) {
    for (let d2 = 0; d2 < 6; d2++) {
      if (d1 >> 1 === d2 >> 1) continue;
      out.push({ d: [d1 as Dir, d2 as Dir, crossDir(d1 as Dir, d2 as Dir)] });
    }
  }
  return out;
}

export interface Clearance {
  side: Dir; // local side
  depth: number;
}

export interface Oriented {
  frame: Frame;
  /** Local body size along e1,e2,e3. */
  size: Vec3;
  /** World (u,v,t) body size. */
  body: Vec3;
  /** World (u,v,t) size including clearances. */
  ext: Vec3;
  /** Body min corner relative to the clearance-box min corner. */
  off: Vec3;
}

export function orient(size: Vec3, frame: Frame, clears: Clearance[]): Oriented {
  const body: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) body[axisOf(frame.d[i])] = size[i];
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  for (const c of clears) {
    if (c.depth <= 0) continue;
    const w = sideToWorld(frame, c.side);
    const a = axisOf(w);
    if (signOf(w) > 0) hi[a] = Math.max(hi[a], c.depth);
    else lo[a] = Math.max(lo[a], c.depth);
  }
  return {
    frame,
    size,
    body,
    ext: [body[0] + lo[0] + hi[0], body[1] + lo[1] + hi[1], body[2] + lo[2] + hi[2]],
    off: lo,
  };
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export const boxSize = (b: Box): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const boxCenter = (b: Box): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];

export function boxesOverlap(a: Box, b: Box, eps = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.max[i] <= b.min[i] + eps || b.max[i] <= a.min[i] + eps) return false;
  }
  return true;
}

/**
 * Map a point given in an item's local body coordinates (0..size along e1,e2,e3)
 * to world coordinates, given the item's world body box and frame.
 */
export function localToWorld(frame: Frame, body: Box, p: Vec3): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = frame.d[i];
    const a = axisOf(d);
    out[a] = signOf(d) > 0 ? body.min[a] + p[i] : body.max[a] - p[i];
  }
  return out;
}

/** Axis-aligned local box (in body coordinates) to a world box. */
export function localBoxToWorld(frame: Frame, body: Box, lo: Vec3, hi: Vec3): Box {
  const a = localToWorld(frame, body, lo);
  const b = localToWorld(frame, body, hi);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectArea = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/** a minus b, as up to four disjoint rectangles. */
export function rectSubtract(a: Rect, b: Rect): Rect[] {
  const i = rectIntersect(a, b);
  if (!i) return [a];
  const out: Rect[] = [];
  if (i.y0 > a.y0) out.push({ x0: a.x0, y0: a.y0, x1: a.x1, y1: i.y0 });
  if (i.y1 < a.y1) out.push({ x0: a.x0, y0: i.y1, x1: a.x1, y1: a.y1 });
  if (i.x0 > a.x0) out.push({ x0: a.x0, y0: i.y0, x1: i.x0, y1: i.y1 });
  if (i.x1 < a.x1) out.push({ x0: i.x1, y0: i.y0, x1: a.x1, y1: i.y1 });
  return out;
}

/** The two in-plane axes of a wall with normal axis `a`, in (x, y) order. */
export function wallAxes(a: Axis): [Axis, Axis] {
  return a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
}
