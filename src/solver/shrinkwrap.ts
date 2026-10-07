import { MATERIALS } from '../model/presets';
import type { DesignConfig } from '../model/types';
import type { Design } from './evaluate';
import { connectorBox, gpuWrapClearance, hoseBox, hoseDistance, routedPaths, type HosePath } from './hoses';
import { sculptBounds, sculptField } from './sculpt';
import { tiltedShapes } from './tilt';
import { axisOf, signOf, wallAxes, type Box, type Vec3 } from './geometry';

/**
 * Shrinkwrap shell, meshed with surface nets.
 *
 * 1. X = union of every part's body box and clearance box (both rounded a little; clearances are
 *    air the parts need: fan gaps, cable room), the routed AIO hoses and GPU power cable, plus a
 *    flat plate behind the rear I/O.
 * 2. Closing of X with a ball of radius R (dilate by R, then erode by R), computed with a 3D
 *    Euclidean distance transform. It bridges gaps narrower than about 2R like a shrink film
 *    pulled over the parts, without inflating flat faces; R → ∞ would give the convex hull.
 * 3. The outer surface is the closing offset by the wall plus a softness that rounds convex
 *    edges. The body rounding r cuts a box corner by at most 0.73·r (r·(√3−1)), which the softness covers,
 *    so no part body ever comes closer than one wall to the outside.
 *
 * Shell 'box' is the straight box the solver sized. Shell 'wrap' uses the smoothness s = organic:
 *   s = 0  → R = 15 mm: tight, straight faces, only cracks between parts bridged
 *   s = 1  → R = 65 mm: gaps up to ~130 mm bridged, convex edges rounded by ~3 mm (costs ~3 mm per side)
 * The box is never blended in: every litre of the wrap is parts, clearances, hoses, the wall
 * and the bridging the smoothness asks for.
 *
 * Shrinkwrap mode (prefs.mold) moulds the shell to the parts with no dead space: smoothness 0, a
 * closing just wide enough to keep unprintable slits out (MOLD_CLOSE), no wedge behind tilted parts
 * (the skin runs along the tilted fans, vented, at the fans' wall gap) and the flat I/O plate only
 * behind each rear part, not across the gap between them. deadSpaceL() measures what any shell
 * holds beyond those shapes.
 *
 * All coordinates are solver coordinates (u, v, t) in mm, interior from 0 to design.interior.
 */

export interface ShellMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bbox: Box;
  volumeMm3: number;
  areaMm2: number;
}

export interface WrapMetrics {
  /** World-axis outer size (feet excluded). */
  world: { width: number; height: number; depth: number };
  thickness: number;
  volumeL: number;
  weightKg: number;
  /** Litres the smoothness adds over the tightest wrap (smoothness 0). */
  smoothingL?: number;
  /** Air inside the shell that no part, air gap, hose or cable needs, litres. */
  deadL?: number;
}

const BODY_ROUND = 3.5;
const CLEAR_ROUND = BODY_ROUND;
const SOFT_MIN = 0.5;
const SOFT_RANGE = 2.5;
const CLOSE_MIN = 15;
const CLOSE_RANGE = 50;

/** Shrinkwrap mode: moulded to every part, whatever the shell setting. */
export const isMold = (cfg: DesignConfig) => cfg.prefs.mold === true;
export const isWrap = (cfg: DesignConfig) => isMold(cfg) || cfg.prefs.shell !== 'box';
/** Angled (facet) or curved (pebble) panels: analytic convex shells, see sculpt.ts. */
export const isSculpt = (cfg: DesignConfig) => !isMold(cfg) && (cfg.prefs.shell === 'facet' || cfg.prefs.shell === 'pebble');
export const closeRadius = (s: number) => CLOSE_MIN + CLOSE_RANGE * Math.min(1, Math.max(0, s));
/**
 * Closing radius in shrinkwrap mode: bridges only slits under ~2R between parts, which would print as
 * two walls with a crevice between them too narrow to clean or to cool anything.
 */
export const moldClose = (wall: number) => Math.max(6, 2 * wall);

function sdBox(p: Vec3, b: Box, r: number): number {
  let out = 0;
  let inMax = -Infinity;
  for (let a = 0; a < 3; a++) {
    const c = (b.min[a] + b.max[a]) / 2;
    const h = Math.max(0, (b.max[a] - b.min[a]) / 2 - r);
    const q = Math.abs(p[a] - c) - h;
    if (q > 0) out += q * q;
    inMax = Math.max(inMax, q);
  }
  return Math.sqrt(out) + Math.min(inMax, 0) - r;
}

export type Field = (p: Vec3) => number;

/** The straight case: the solver's exterior box with rounded or chamfered edges. */
export function boxField(design: Design, cfg: DesignConfig): Field {
  const wall = design.wall;
  const ext: Box = {
    min: [-wall, -wall, -wall],
    max: [design.interior[0] + wall, design.interior[1] + wall, design.interior[2] + wall],
  };
  const edge = Math.min(cfg.prefs.edgeRadius, ...design.exterior.map((x) => x / 2));
  if (cfg.prefs.edgeStyle !== 'chamfer') return (p) => sdBox(p, ext, edge);
  const c = ext.min.map((m, a) => (m + ext.max[a]) / 2);
  const h = ext.max.map((m, a) => m - c[a]);
  return (p) => {
    let d = sdBox(p, ext, 0);
    const q = p.map((v, a) => Math.abs(v - c[a]) - h[a]);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) d = Math.max(d, (q[a] + q[b] + edge) / Math.SQRT2);
    return Math.max(d, (q[0] + q[1] + q[2] + edge * 1.5) / Math.sqrt(3));
  };
}

function wrapShapes(design: Design, cfg: DesignConfig, o: number, mold = isMold(cfg)) {
  // Rounding only ever shrinks a box, so the body rounding is covered by the softness (0.73·r ≤ soft − wall).
  const rb = BODY_ROUND * o;
  const rc = CLEAR_ROUND * o;
  const half = (b: Box) => Math.min(...[0, 1, 2].map((a) => (b.max[a] - b.min[a]) / 2));
  const shapes: WrapShape[] = [];
  for (const part of design.parts) {
    if (part.tilt) {
      // A tilted part: its own oriented body and clearance, and the frame's wedge to its panel,
      // not the box around it (the empty corner behind the tilt stays outside the shell).
      const t = tiltedShapes(part, rb);
      const tc = tiltedShapes(part, rc);
      // Bounded by the oriented shapes' own extent (the plenum behind tilted fans can reach past the box around the part).
      const ext: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const q of [...t.points, part.clearance.min, part.clearance.max])
        for (let a = 0; a < 3; a++) {
          ext.min[a] = Math.min(ext.min[a], q[a]);
          ext.max[a] = Math.max(ext.max[a], q[a]);
        }
      shapes.push({ box: ext, r: 0, sdf: t.body }, { box: ext, r: 0, sdf: tc.clearance });
      // Moulded: no wedge; the clearance's panel side (the fans' wall gap) is where the skin runs.
      if (!mold) shapes.push({ box: ext, r: 0, sdf: t.wedge });
      continue;
    }
    shapes.push({ box: part.body, r: Math.min(rb, half(part.body)) });
    // The card's connector room is local (the solver reserves the whole edge, the wrap only the plug).
    const clear = part.kind === 'gpu' ? (gpuWrapClearance(design, cfg) ?? part.clearance) : part.clearance;
    shapes.push({ box: clear, r: Math.min(rc, half(clear)) });
  }
  const conn = connectorBox(design, cfg);
  if (conn) shapes.push({ box: conn, r: Math.min(rb, half(conn)) });
  const rear = design.parts.filter((p) => p.kind === 'board' || (p.kind === 'gpu' && p.body.min[0] < 2));
  if (mold)
    // A flat plate behind each rear part's own I/O, not one spanning the gap between them.
    for (const p of rear) shapes.push({ box: { min: [0, p.clearance.min[1], p.clearance.min[2]], max: [20, p.clearance.max[1], p.clearance.max[2]] }, r: 0 });
  else if (rear.length) {
    const b: Box = { min: [0, Infinity, Infinity], max: [20, -Infinity, -Infinity] };
    for (const p of rear)
      for (const a of [1, 2]) {
        b.min[a] = Math.min(b.min[a], p.clearance.min[a]);
        b.max[a] = Math.max(b.max[a], p.clearance.max[a]);
      }
    shapes.push({ box: b, r: 0 });
  }
  return shapes;
}

/** Squared 1D distance transform (Felzenszwalb & Huttenlocher) over the finite sites of f. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    for (;;) {
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        break;
      }
      const s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= z[k]) {
        k--;
        continue;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
      break;
    }
  }
  if (k < 0) {
    for (let q = 0; q < n; q++) d[q] = Infinity;
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

export interface Grid {
  n: Vec3;
  origin: Vec3;
  cell: number;
  vals: Float32Array;
}

function gridIndex(g: Grid, i: number, j: number, k: number) {
  return i + g.n[0] * (j + g.n[1] * k);
}

/** Trilinear sample of a grid; clamps at the border. */
export function sampleGrid(g: Grid): Field {
  return (p) => {
    const f = [0, 1, 2].map((a) => Math.min(g.n[a] - 1.0001, Math.max(0, (p[a] - g.origin[a]) / g.cell)));
    const i = Math.floor(f[0]);
    const j = Math.floor(f[1]);
    const k = Math.floor(f[2]);
    const x = f[0] - i;
    const y = f[1] - j;
    const z = f[2] - k;
    const at = (a: number, b: number, c: number) => g.vals[gridIndex(g, i + a, j + b, k + c)];
    const c00 = at(0, 0, 0) * (1 - x) + at(1, 0, 0) * x;
    const c10 = at(0, 1, 0) * (1 - x) + at(1, 1, 0) * x;
    const c01 = at(0, 0, 1) * (1 - x) + at(1, 0, 1) * x;
    const c11 = at(0, 1, 1) * (1 - x) + at(1, 1, 1) * x;
    return (c00 * (1 - y) + c10 * y) * (1 - z) + (c01 * (1 - y) + c11 * y) * z;
  };
}

function makeGrid(min: Vec3, max: Vec3, cell: number): Grid {
  const n = [0, 1, 2].map((a) => Math.ceil((max[a] - min[a]) / cell) + 1) as Vec3;
  return { n, origin: [...min] as Vec3, cell, vals: new Float32Array(n[0] * n[1] * n[2]) };
}

function forEachPoint(g: Grid, fn: (p: Vec3, id: number) => void) {
  const p: Vec3 = [0, 0, 0];
  const [nx, ny, nz] = g.n;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        p[0] = g.origin[0] + i * g.cell;
        p[1] = g.origin[1] + j * g.cell;
        p[2] = g.origin[2] + k * g.cell;
        fn(p, i + nx * (j + ny * k));
      }
}

/** A shape the wrap holds: a rounded box, or any shape (`sdf`) inside the bounding `box`. */
type WrapShape = { box: Box; r: number; sdf?: Field };

function unionField(shapes: WrapShape[], hoses: HosePath[]): Field {
  const boxes = hoses.map(hoseBox);
  return (q) => {
    let d = Infinity;
    for (const s of shapes) {
      if (!s.sdf) {
        d = Math.min(d, sdBox(q, s.box, s.r));
        continue;
      }
      // Cheap bound first: a shape can't be nearer than its bounding box.
      const lb = sdBox(q, s.box, 0);
      if (lb < d) d = Math.min(d, Math.max(lb, s.sdf(q)));
    }
    for (let i = 0; i < hoses.length; i++) {
      // Cheap bound first: the hose can't be nearer than its bounding box.
      const lb = sdBox(q, boxes[i], 0);
      if (lb < d) d = Math.min(d, hoseDistance(hoses[i], q));
    }
    return d;
  };
}

/**
 * Closing of the union with a ball of radius R, on its own coarse grid. Only its hollow-filling
 * matters (the exact union is min-ed back in on the fine grid), so a coarse grid is enough.
 */
function closingGrid(design: Design, union: Field, R: number, fineCell: number): Grid {
  const cell = Math.max(fineCell, R / 18);
  const pad = R + design.wall + 3 * cell;
  const g = makeGrid([-pad, -pad, -pad], [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad], cell);
  const n = g.n;
  const total = g.vals.length;
  const S = new Float32Array(total);
  forEachPoint(g, (p, id) => (S[id] = union(p)));
  const D = new Float64Array(total);
  for (let id = 0; id < total; id++) D[id] = S[id] <= R ? Infinity : 0;
  const maxN = Math.max(...n);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);
  const strides = [1, n[0], n[0] * n[1]];
  for (let axis = 0; axis < 3; axis++) {
    const len = n[axis];
    const stride = strides[axis];
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let b = 0; b < n[others[1]]; b++)
      for (let a = 0; a < n[others[0]]; a++) {
        const base = a * strides[others[0]] + b * strides[others[1]];
        for (let q = 0; q < len; q++) f[q] = D[base + q * stride];
        edt1d(f, len, d, v, z);
        for (let q = 0; q < len; q++) D[base + q * stride] = d[q];
      }
  }
  const C = g.vals;
  for (let id = 0; id < total; id++) C[id] = S[id] <= R ? R - (Math.sqrt(D[id]) - 0.5) * cell : S[id];
  // [1 2 1] smoothing along each axis takes the voxel steps out of the fill.
  const tmp = new Float32Array(total);
  for (let axis = 0; axis < 3; axis++) {
    const stride = strides[axis];
    for (let id = 0; id < total; id++) {
      const c = axis === 0 ? id % n[0] : axis === 1 ? Math.floor(id / n[0]) % n[1] : Math.floor(id / (n[0] * n[1]));
      const lo = c > 0 ? C[id - stride] : C[id];
      const hi = c < n[axis] - 1 ? C[id + stride] : C[id];
      tmp[id] = (lo + 2 * C[id] + hi) / 4;
    }
    C.set(tmp);
  }
  // Bias the fill slightly inward so interpolation never bulges a flat outer face.
  for (let id = 0; id < total; id++) C[id] += 0.6 * cell;
  return g;
}

/** Outer-surface field of the shell on a grid (negative inside). */
export function shellGrid(design: Design, cfg: DesignConfig, organic: number, cell: number): Grid {
  const mold = isMold(cfg);
  const s = mold ? 0 : Math.min(1, Math.max(0, organic));
  const wall = design.wall;
  const soft = wall + SOFT_MIN + SOFT_RANGE * s + cell * 0.45;
  const pad = soft + 3 * cell;
  if (isSculpt(cfg)) {
    // A sculpted shell can reach well past the interior box: the grid follows its own bounds.
    const fs = sculptField(design, cfg);
    const b = sculptBounds(design, fs);
    const gs = makeGrid(b.min.map((x) => x - 3 * cell) as Vec3, b.max.map((x) => x + 3 * cell) as Vec3, cell);
    forEachPoint(gs, (p, id) => (gs.vals[id] = fs(p)));
    return gs;
  }
  const g = makeGrid([-pad, -pad, -pad], [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad], cell);
  if (!isWrap(cfg)) {
    const fb = boxField(design, cfg);
    forEachPoint(g, (p, id) => (g.vals[id] = fb(p)));
    return g;
  }
  const union = unionField(wrapShapes(design, cfg, s), routedPaths(design, cfg));
  const closing = sampleGrid(closingGrid(design, union, mold ? moldClose(wall) : closeRadius(s), cell));
  // min with the exact union: parts are always covered exactly; the closing only bridges gaps.
  forEachPoint(g, (p, id) => (g.vals[id] = Math.min(union(p), closing(p)) - soft));
  fillPockets(g, wall);
  return g;
}

/**
 * Fill enclosed pockets: air the wrap left between parts that is sealed off from the outside.
 * Its wall band would print as a hollow shell floating inside the case, so every region of
 * f > −wall (wall band and beyond) that the grid boundary can't reach is set inside the air.
 */
export function fillPockets(g: Grid, wall: number) {
  const [nx, ny, nz] = g.n;
  const n = nx * ny * nz;
  const open = (id: number) => g.vals[id] > -wall;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (id: number) => {
    if (!seen[id] && open(id)) {
      seen[id] = 1;
      queue[tail++] = id;
    }
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (head < tail) {
    const id = queue[head++];
    const i = id % nx;
    const j = Math.floor(id / nx) % ny;
    const k = Math.floor(id / (nx * ny));
    if (i > 0) push(id - 1);
    if (i < nx - 1) push(id + 1);
    if (j > 0) push(id - nx);
    if (j < ny - 1) push(id + nx);
    if (k > 0) push(id - nx * ny);
    if (k < nz - 1) push(id + nx * ny);
  }
  let filled = 0;
  for (let id = 0; id < n; id++)
    if (open(id) && !seen[id]) {
      g.vals[id] = -wall - g.cell;
      filled++;
    }
  return filled;
}

/** Outer-surface field (negative inside), sampled from the shell grid. */
export function shellField(design: Design, cfg: DesignConfig, organic: number, detail = 1): Field {
  if (!isWrap(cfg)) return boxField(design, cfg);
  if (isSculpt(cfg)) return sculptField(design, cfg);
  return sampleGrid(shellGrid(design, cfg, organic, defaultCell(design, detail)));
}

/** Mesh the level set `grid = level` with naive surface nets. */
export function meshGrid(g: Grid, level = 0): ShellMesh {
  const [nx, ny, nz] = g.n;
  const cell = g.cell;
  const bounds = { min: g.origin };
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const vals = level === 0 ? g.vals : g.vals.map((x) => x - level);
  const field = sampleGrid({ ...g, vals });

  const cellIdx = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const pos: number[] = [];
  const corners: Vec3[] = [];
  for (let c = 0; c < 8; c++) corners.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
  const edges: [number, number][] = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const d = corners[a].reduce((s, v, i) => s + Math.abs(v - corners[b][i]), 0);
    if (d === 1) edges.push([a, b]);
  }
  const f = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          f[c] = vals[idx(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (f[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cnt = 0;
        for (const [a, b] of edges) {
          if (f[a] < 0 === f[b] < 0) continue;
          const t = f[a] / (f[a] - f[b]);
          sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
          sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
          sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
          cnt++;
        }
        cellVert[cellIdx(i, j, k)] = pos.length / 3;
        pos.push(bounds.min[0] + (i + sx / cnt) * cell, bounds.min[1] + (j + sy / cnt) * cell, bounds.min[2] + (k + sz / cnt) * cell);
      }

  const tris: number[] = [];
  const vp = (v: number): Vec3 => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
  const quad = (a: number, b: number, c: number, d: number, axis: number, outward: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const A = vp(a);
    const C = vp(c);
    const B = vp(b);
    const D = vp(d);
    const e1 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const e2 = [D[0] - B[0], D[1] - B[1], D[2] - B[2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (nrm[axis] * outward >= 0) tris.push(a, b, c, a, c, d);
    else tris.push(a, c, b, a, d, c);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = vals[idx(i, j, k)];
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          const v1 = vals[idx(i + 1, j, k)];
          if (v0 < 0 !== v1 < 0)
            quad(cellVert[cellIdx(i, j - 1, k - 1)], cellVert[cellIdx(i, j, k - 1)], cellVert[cellIdx(i, j, k)], cellVert[cellIdx(i, j - 1, k)], 0, v0 < 0 ? 1 : -1);
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          const v1 = vals[idx(i, j + 1, k)];
          if (v0 < 0 !== v1 < 0)
            quad(cellVert[cellIdx(i - 1, j, k - 1)], cellVert[cellIdx(i, j, k - 1)], cellVert[cellIdx(i, j, k)], cellVert[cellIdx(i - 1, j, k)], 1, v0 < 0 ? 1 : -1);
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          const v1 = vals[idx(i, j, k + 1)];
          if (v0 < 0 !== v1 < 0)
            quad(cellVert[cellIdx(i - 1, j - 1, k)], cellVert[cellIdx(i, j - 1, k)], cellVert[cellIdx(i, j, k)], cellVert[cellIdx(i - 1, j, k)], 2, v0 < 0 ? 1 : -1);
        }
      }

  // Normals from the field gradient: smooth, and exact on flat faces.
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  const e = cell * 0.5;
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v];
    const y = pos[v + 1];
    const z = pos[v + 2];
    const gx = field([x + e, y, z]) - field([x - e, y, z]);
    const gy = field([x, y + e, z]) - field([x, y - e, z]);
    const gz = field([x, y, z + e]) - field([x, y, z - e]);
    const l = Math.hypot(gx, gy, gz) || 1;
    normals[v] = gx / l;
    normals[v + 1] = gy / l;
    normals[v + 2] = gz / l;
  }

  let vol = 0;
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp(tris[t]);
    const b = vp(tris[t + 1]);
    const c = vp(tris[t + 2]);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  const bbox: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let v = 0; v < pos.length; v += 3)
    for (let a = 0; a < 3; a++) {
      bbox.min[a] = Math.min(bbox.min[a], pos[v + a]);
      bbox.max[a] = Math.max(bbox.max[a], pos[v + a]);
    }
  return { positions, normals, indices: new Uint32Array(tris), bbox, volumeMm3: Math.abs(vol), areaMm2: area };
}

export function defaultCell(design: Design, detail = 1): number {
  const m = Math.max(...design.exterior);
  return Math.min(8, Math.max(3, m / (110 * detail)));
}

export function meshShell(design: Design, cfg: DesignConfig, organic: number, level = 0, detail = 1): ShellMesh {
  return meshGrid(shellGrid(design, cfg, organic, defaultCell(design, detail)), level);
}

/** Solver-space size → world size for the case orientation. */
export function worldSize(cfg: DesignConfig, s: Vec3) {
  return cfg.prefs.orientation === 'tower' ? { width: s[2], height: s[1], depth: s[0] } : { width: s[1], height: s[2], depth: s[0] };
}

export function wrapMetrics(design: Design, cfg: DesignConfig, organic: number, detail = 0.5): WrapMetrics {
  const g = shellGrid(design, cfg, organic, defaultCell(design, detail));
  return { ...meshMetrics(design, cfg, meshGrid(g)), deadL: deadSpaceL(design, cfg, g) };
}

/** What every shell must hold: the parts, their air gaps, hoses and cables (the moulded shapes). */
export function neededField(design: Design, cfg: DesignConfig): Field {
  return unionField(wrapShapes(design, cfg, 0, true), routedPaths(design, cfg));
}

/**
 * Dead space of a shell, litres: air inside its inner surface (the outer field below −wall) that
 * no part, air gap, hose or cable needs, counted on the shell's own grid.
 */
export function deadSpaceL(design: Design, cfg: DesignConfig, g: Grid): number {
  const need = neededField(design, cfg);
  let dead = 0;
  forEachPoint(g, (p, id) => {
    if (g.vals[id] <= -design.wall && need(p) > 0) dead++;
  });
  return (dead * g.cell ** 3) / 1e6;
}

/**
 * Quick estimate of the moulded shell's size for ranking layouts in shrinkwrap mode: the needed
 * shapes grown by the wall, counted on a coarse grid (no mesh, no closing).
 */
export function moldEstimate(design: Design, cfg: DesignConfig, cell = 10): { volumeL: number; thickness: number } {
  const need = neededField(design, cfg);
  const w = design.wall + SOFT_MIN;
  const pad = w + cell;
  const g = makeGrid([-pad, -pad, -pad], [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad], cell);
  let n = 0;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  forEachPoint(g, (p) => {
    if (need(p) > w) return;
    n++;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
  });
  if (!n) return { volumeL: design.volumeL, thickness: design.thickness };
  const size = [0, 1, 2].map((a) => hi[a] - lo[a] + cell) as Vec3;
  const world = worldSize(cfg, size);
  return { volumeL: (n * cell ** 3) / 1e6, thickness: Math.min(world.width, world.height, world.depth) };
}

/** Outer size, volume and panel weight of a meshed shell. */
export function meshMetrics(design: Design, cfg: DesignConfig, m: ShellMesh): WrapMetrics {
  const size: Vec3 = [m.bbox.max[0] - m.bbox.min[0], m.bbox.max[1] - m.bbox.min[1], m.bbox.max[2] - m.bbox.min[2]];
  const world = worldSize(cfg, size);
  const mat = MATERIALS.find((x) => x.id === cfg.prefs.materialId) ?? MATERIALS[0];
  return {
    world,
    thickness: Math.min(world.width, world.height, world.depth),
    volumeL: m.volumeMm3 / 1e6,
    weightKg: (m.areaMm2 * design.wall * mat.densityGcm3) / 1e6,
  };
}

/**
 * Per-vertex vent flag for a shell mesh: 1 = perforated, 2 = solid cut-out (I/O, bracket).
 * A vertex belongs to a vent when it faces that vent's wall and projects into the vent's rectangle.
 */
/** Steepest slant of a panel, from its vent's wall, that still gets perforated (degrees). */
export const VENT_MAX_TILT = 50;
const VENT_COS = Math.cos((VENT_MAX_TILT * Math.PI) / 180);

export function ventMask(design: Design, mesh: ShellMesh): Float32Array {
  const out = new Float32Array(mesh.positions.length / 3);
  for (let v = 0; v < out.length; v++) {
    const p = [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]];
    const nrm = [mesh.normals[3 * v], mesh.normals[3 * v + 1], mesh.normals[3 * v + 2]];
    for (const vent of design.vents) {
      const a = axisOf(vent.wall);
      if (nrm[a] * signOf(vent.wall) < VENT_COS) continue;
      const [xa, ya] = wallAxes(a);
      const r = vent.rect;
      if (p[xa] < r.x0 - 1 || p[xa] > r.x1 + 1 || p[ya] < r.y0 - 1 || p[ya] > r.y1 + 1) continue;
      out[v] = Math.max(out[v], vent.kind === 'io' || vent.kind === 'bracket' ? 2 : 1);
    }
  }
  return out;
}

/**
 * Per-vertex axis of the vent wall a vertex belongs to (−1: none), so the 3D view lays the hole
 * pattern out in that wall's plane, as the print does, even on a bevel that faces two walls.
 */
export function ventAxis(design: Design, mesh: ShellMesh): Float32Array {
  const out = new Float32Array(mesh.positions.length / 3).fill(-1);
  for (let v = 0; v < out.length; v++) {
    const p = [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]];
    const nrm = [mesh.normals[3 * v], mesh.normals[3 * v + 1], mesh.normals[3 * v + 2]];
    let best = -1;
    let bestDot = VENT_COS;
    for (const vent of design.vents) {
      const a = axisOf(vent.wall);
      const d = nrm[a] * signOf(vent.wall);
      if (d < bestDot) continue;
      const [xa, ya] = wallAxes(a);
      const r = vent.rect;
      if (p[xa] < r.x0 - 1 || p[xa] > r.x1 + 1 || p[ya] < r.y0 - 1 || p[ya] > r.y1 + 1) continue;
      best = a;
      bestDot = d;
    }
    out[v] = best;
  }
  return out;
}

/** Outer bounding box of the shell for any shell kind (the print splitter and grids cover it). */
export function shellBounds(design: Design, cfg: DesignConfig): Box {
  if (isSculpt(cfg)) return sculptBounds(design, sculptField(design, cfg));
  const pad = design.wall + SOFT_MIN + SOFT_RANGE + 12;
  return { min: [-pad, -pad, -pad], max: [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad] };
}
