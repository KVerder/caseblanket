import type { DesignConfig } from '../model/types';
import type { Design } from './evaluate';
import type { Box, Vec3 } from './geometry';
import { routedPaths } from './hoses';
import { partAxis, tiltedShapes } from './tilt';
import type { Field } from './shrinkwrap';

/**
 * Sculpted shells: angled and curved panels around the same parts.
 *
 * The shell is a convex solid built from panel planes. Each plane, with normal n, is pushed out
 * until it just clears everything the case must hold (the parts, their clearances, the hoses and
 * the rear I/O plate) plus one wall: h(n) = max over that envelope of n·p, + wall. Then:
 *
 *   facet   flat panels at angles: the six faces, twelve edge bevels (45°) and eight corner
 *           facets. `cut` sets how deep the bevels go, from none (the box) to touching the parts;
 *           `slope` leans the front panel back by that many degrees. Exact distance inside, so
 *           walls keep their thickness everywhere.
 *   pebble  curved panels: 98 planes, each rounded into its neighbours with a fillet of radius R
 *           (the L2 norm of how far a point is past the planes pulled in by R, which is the
 *           distance to a rounded polytope where the planes are orthogonal). Normalised by its
 *           gradient, so the wall is one wall thick on the curves too. `round` sets R.
 *
 * In both, the back stays flat (the I/O shield and the card bracket need it) and so does the
 * bottom (the case stands on its feet). Everything the parts need stays inside the inner wall
 * surface: the planes are pushed out further until every corner of every part box and every hose
 * point clears it.
 */

export type SculptStyle = 'facet' | 'pebble';

export interface Sculpt {
  /** Facet: bevel depth, 0 (box) … 1 (bevels touch the parts). */
  cut: number;
  /** Lean of the front panel, degrees (0–35). */
  slope: number;
  /** Pebble: fillet radius share, 0 (R = 12 mm) … 1 (R = 70 mm). */
  round: number;
}

export const DEFAULT_SCULPT: Sculpt = { cut: 0.7, slope: 0, round: 0.6 };

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Directions on a cube grid with `k` steps per face edge (k = 2: the 26 axis, edge and corner normals). */
function cubeDirections(k: number): Vec3[] {
  const out: Vec3[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= k; i++)
    for (let j = 0; j <= k; j++)
      for (let l = 0; l <= k; l++) {
        if (i !== 0 && i !== k && j !== 0 && j !== k && l !== 0 && l !== k) continue;
        const v = unit([(2 * i) / k - 1, (2 * j) / k - 1, (2 * l) / k - 1]);
        const key = v.map((x) => x.toFixed(5)).join(',');
        if (!seen.has(key)) {
          seen.add(key);
          out.push(v);
        }
      }
  return out;
}

/** Points the inner wall surface must enclose: part and clearance box corners and edge samples, hose points (with their radius). */
export function envelopePoints(design: Design, cfg: DesignConfig): { p: Vec3; r: number }[] {
  const boxes: Box[] = [];
  const out: { p: Vec3; r: number }[] = [];
  for (const part of design.parts) {
    // A tilted part: its own oriented clearance and the frame's wedge, not the box around it.
    if (part.tilt) for (const p of tiltedShapes(part).points) out.push({ p, r: 0 });
    else boxes.push(part.body, part.clearance);
  }
  // The rear I/O plate: the board's and the card's clearance across the back, 20 mm deep.
  const rear = design.parts.filter((p) => p.kind === 'board' || (p.kind === 'gpu' && p.body.min[0] < 2));
  if (rear.length) {
    const b: Box = { min: [0, Infinity, Infinity], max: [20, -Infinity, -Infinity] };
    for (const p of rear)
      for (const a of [1, 2]) {
        b.min[a] = Math.min(b.min[a], p.clearance.min[a]);
        b.max[a] = Math.max(b.max[a], p.clearance.max[a]);
      }
    boxes.push(b);
  }
  const S = 4; // samples per box edge (the inner surface is only nearly convex once normalised)
  for (const b of boxes)
    for (let i = 0; i <= S; i++)
      for (let j = 0; j <= S; j++)
        for (let k = 0; k <= S; k++) {
          const onEdge = [i, j, k].filter((x) => x === 0 || x === S).length >= 2;
          if (!onEdge) continue;
          out.push({ p: [b.min[0] + ((b.max[0] - b.min[0]) * i) / S, b.min[1] + ((b.max[1] - b.min[1]) * j) / S, b.min[2] + ((b.max[2] - b.min[2]) * k) / S], r: 0 });
        }
  for (const h of routedPaths(design, cfg)) for (let i = 0; i < h.points.length; i += 2) out.push({ p: h.points[i], r: h.radius });
  return out;
}

/** The sculpted outer-surface field (negative inside), solver coordinates. */
export function sculptField(design: Design, cfg: DesignConfig): Field {
  const style: SculptStyle = cfg.prefs.shell === 'pebble' ? 'pebble' : 'facet';
  const sc = { ...DEFAULT_SCULPT, ...(cfg.prefs.sculpt ?? {}) };
  const wall = design.wall;
  const up = cfg.prefs.orientation === 'tower' ? 1 : 2;
  const env = envelopePoints(design, cfg);
  const support = (n: Vec3) => env.reduce((m, e) => Math.max(m, dot(n, e.p) + e.r), -Infinity);
  const boxSupport = (n: Vec3) => {
    let s = 0;
    for (let a = 0; a < 3; a++) s += n[a] > 0 ? n[a] * design.interior[a] : 0;
    return s;
  };

  let normals = style === 'pebble' ? cubeDirections(4) : cubeDirections(2);
  // Lean the front back: the upright front panel is replaced by one leaning `slope` degrees,
  // held tight to the parts. Where they fill the front to the top, the base comes forward
  // instead (a wedge), as far as the bevel under it lets it.
  const slope = (Math.max(0, Math.min(35, sc.slope)) * Math.PI) / 180;
  let lean: { n: Vec3 } | null = null;
  if (slope > 0) {
    const n: Vec3 = [Math.cos(slope), 0, 0];
    n[up] = Math.sin(slope);
    lean = { n };
    normals = [...normals.filter((m) => m[0] < 0.999), n];
  }
  // The back and the bottom are hard, flat planes (added below), not part of the rounded set.
  const isBack = (n: Vec3) => n[0] < -0.999;
  const isBottom = (n: Vec3) => n[up] < -0.999;
  normals = normals.filter((n) => !isBack(n) && !isBottom(n));
  // A tilted radiator or fan: panels parallel to its back and to its lifted end, so the shell can
  // follow the tilt where the corner behind it is empty (bevels alone are all at 45°).
  for (const part of design.parts) {
    if (!part.tilt) continue;
    for (const k of [2, 0] as const) {
      const e = partAxis(part, k);
      const n = unit(k === 2 ? [-e[0], -e[1], -e[2]] : e);
      if (!normals.some((m) => dot(m, n) > 0.999) && !isBack(n) && !isBottom(n)) normals.push(n);
    }
  }
  const cut = Math.max(0, Math.min(1, sc.cut));
  const h = normals.map((n) => {
    if (lean && n === lean.n) return support(n) + wall;
    const s = support(n);
    const axis = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) > 0.999;
    // Facets between the box and the parts; the pebble wraps the parts and lets the fillet do the rest.
    const off = style === 'facet' && !axis ? s + (1 - cut) * Math.max(0, boxSupport(n) - s) : s;
    return off + wall;
  });
  const R = style === 'pebble' ? 12 + 58 * Math.max(0, Math.min(1, sc.round)) : 0;
  // The pebble rounds in a space stretched along the case's thin axes, k_a = √(longest / extent_a):
  // a fillet as big as the outline wants would otherwise swell a slim case far past its thickness.
  // Its fillets are ellipses: R/k_a millimetres along axis a.
  const ext = design.interior;
  const k: Vec3 = [0, 1, 2].map((a) => Math.sqrt(Math.max(...ext) / Math.max(1, ext[a]))) as Vec3;
  const envQ = env.map((e) => ({ p: [e.p[0] * k[0], e.p[1] * k[1], e.p[2] * k[2]] as Vec3, r: e.r * Math.max(...k) }));
  const hq = normals.map((n) => {
    const sup = envQ.reduce((m, e) => Math.max(m, dot(n, e.p) + e.r), -Infinity);
    return sup;
  });

  const planes = (p: Vec3) => {
    // Flat back (outer face at u = −wall) and flat bottom.
    return Math.max(-p[0] - wall, -p[up] - wall);
  };
  // Per-plane push-out (mm for facets, stretched-space units for the pebble), set below.
  const push = new Float64Array(normals.length);
  const facetF = (p: Vec3, flat = true) => {
    let d = flat ? planes(p) : -Infinity;
    for (let i = 0; i < normals.length; i++) d = Math.max(d, dot(normals[i], p) - h[i] - push[i]);
    return d;
  };
  /** The pebble's field, and each plane's share of it where it is rounding (for the push-out). */
  const pebble = (p: Vec3, flat: boolean, shares?: Float64Array) => {
    // Rounded in the stretched space q = k∘p (see `k` above), measured back in millimetres.
    const q: Vec3 = [p[0] * k[0], p[1] * k[1], p[2] * k[2]];
    let sum = 0;
    let g: Vec3 = [0, 0, 0];
    let inner = -Infinity;
    let innerN = normals[0];
    for (let i = 0; i < normals.length; i++) {
      const d = dot(normals[i], q) - hq[i] - push[i];
      if (d > inner) {
        inner = d;
        innerN = normals[i];
      }
      const t = d + R;
      if (shares) shares[i] = Math.max(0, t);
      if (t > 0) {
        sum += t * t;
        g = [g[0] + t * normals[i][0], g[1] + t * normals[i][1], g[2] + t * normals[i][2]];
      }
    }
    let f: number;
    if (sum === 0) f = inner / Math.hypot(innerN[0] * k[0], innerN[1] * k[1], innerN[2] * k[2]); // deep inside: distance to the nearest plane
    else {
      const l = Math.sqrt(sum);
      if (shares) for (let i = 0; i < shares.length; i++) shares[i] /= l;
      // ∇_p = k∘(Σ (t_i / l) n_i); dividing by its length keeps one wall one wall thick.
      const gl = Math.hypot(k[0] * g[0], k[1] * g[1], k[2] * g[2]) / l;
      f = (l - R) / Math.max(0.3, gl);
    }
    return flat ? Math.max(f, planes(p)) : f;
  };
  const F = style === 'pebble' ? (p: Vec3, flat = true) => pebble(p, flat) : facetF;

  // Push planes out until every envelope point clears the inner wall surface by 0.5 mm (the flat
  // back and bottom sit where the box's do, so only the moving planes are checked). Only the
  // planes rounding into a point that pokes through move, by their share of the fillet there:
  // the shell stays tight where the parts fill a corner and curves where there is room.
  const shares = new Float64Array(normals.length);
  for (let it = 0; it < 40; it++) {
    const step = new Float64Array(normals.length);
    let worst = -Infinity;
    for (const e of env) {
      const v = (style === 'pebble' ? pebble(e.p, false, shares) : facetF(e.p, false)) + e.r + wall + 0.5;
      worst = Math.max(worst, v);
      if (v <= 0) continue;
      if (style !== 'pebble') {
        for (let i = 0; i < normals.length; i++) step[i] = Math.max(step[i], v);
        continue;
      }
      for (let i = 0; i < normals.length; i++) {
        if (shares[i] <= 0) continue;
        // In stretched units: a millimetre along this plane's normal is |k∘n| of them.
        const kn = Math.hypot(normals[i][0] * k[0], normals[i][1] * k[1], normals[i][2] * k[2]);
        step[i] = Math.max(step[i], v * kn * shares[i] * 1.1);
      }
    }
    if (worst <= 1e-3) break;
    for (let i = 0; i < normals.length; i++) push[i] += step[i] + (it > 30 ? worst : 0);
  }
  return (p: Vec3) => F(p);
}

/** Outer bounding box of a sculpted shell (it can reach well past the interior box), mm. */
export function sculptBounds(design: Design, field: Field): Box {
  const reach = 160;
  const step = 6;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const n = design.interior;
  // Convex shell: march out from the interior along each axis line on a coarse lattice.
  for (let a = 0; a < 3; a++) {
    const [b, c] = [0, 1, 2].filter((x) => x !== a);
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const p: Vec3 = [0, 0, 0];
        p[b] = (n[b] * i) / 8;
        p[c] = (n[c] * j) / 8;
        for (const dir of [1, -1]) {
          let t = dir > 0 ? n[a] : 0;
          p[a] = t;
          if (field(p) > 0) continue;
          for (let k = 0; k < reach / step; k++) {
            p[a] = t + dir * step;
            if (field(p) > 0) break;
            t = p[a];
          }
          // Refine the crossing to 0.5 mm.
          let inside = t;
          let outside = t + dir * step;
          for (let r = 0; r < 4; r++) {
            const m = (inside + outside) / 2;
            p[a] = m;
            if (field(p) <= 0) inside = m;
            else outside = m;
          }
          lo[a] = Math.min(lo[a], outside);
          hi[a] = Math.max(hi[a], outside);
        }
      }
  }
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], -design.wall) - 2;
    hi[a] = Math.max(hi[a], n[a] + design.wall) + 2;
  }
  return { min: lo, max: hi };
}
