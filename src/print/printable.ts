import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Box, type Vec3 } from '../solver/geometry';
import { partLocal, TILT_PLATE } from '../solver/tilt';
import { fanRings, FLOW_WALL, HOLE_ROUND } from '../solver/flow';
import { ductCandidates, ductGap, ductPlates } from '../cfd/scene';
import { isSculpt, meshGrid, shellBounds, shellField, VENT_MAX_TILT, type Grid, type ShellMesh } from '../solver/shrinkwrap';
import { PARTITION_THICKNESS } from '../solver/chambers';
import { plateMesh } from '../solver/partitions';
import { DEFAULT_SLICER, OVERHANG_DEG, type Manifest, type SlicerSettings } from './analysis';
import { holeAt, holeHalfExtents, openShare, perforation } from '../model/perforation';
import { bossMesh, fanHoleSpacing, mergeMeshes, mountPlan, psuHoles, type MountPlan, type Standoff } from './mounts';

/**
 * Print-ready shell: the wall as a solid (outer surface down to one wall thickness in), with vent
 * perforations cut through as round holes and the I/O and bracket openings as rectangular
 * cut-outs, split into pieces that fit the print bed. Every piece is meshed as a closed solid.
 */

export interface PrintOptions {
  /** Printer build volume, mm. Pieces are cut so each fits in its smallest dimension cube. */
  bed: [number, number, number];
  /** Preferred filament (material id); hotter pieces are moved to a higher-temperature one. */
  filament?: string;
  slicer?: SlicerSettings;
  /** Plan a conductive liner for EMI shielding. */
  liner?: boolean;
}

export const DEFAULT_PRINT: PrintOptions = { bed: [250, 250, 250], filament: 'petg', slicer: DEFAULT_SLICER, liner: false };

export interface PrintPiece {
  name: string;
  box: Box;
  mesh: ShellMesh;
  /** Loose fragments removed from this piece (bits that would print floating). */
  dropped?: number;
}

/**
 * Remove disconnected bits that would print floating: connected components (by shared vertices)
 * whose volume is under `minMm3` and under 0.5 % of the piece's largest component.
 */
export function dropFragments(m: ShellMesh, minMm3 = 400): { mesh: ShellMesh; dropped: number } {
  const n = m.positions.length / 3;
  if (!n) return { mesh: m, dropped: 0 };
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t < m.indices.length; t += 3) {
    union(m.indices[t], m.indices[t + 1]);
    union(m.indices[t], m.indices[t + 2]);
  }
  const vol = new Map<number, number>();
  const P = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    const v =
      (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    const k = find(m.indices[t]);
    vol.set(k, (vol.get(k) ?? 0) + v);
  }
  const largest = Math.max(...[...vol.values()].map(Math.abs));
  // A component is dropped only if it is small in both senses.
  const keepRoot = new Set([...vol].filter(([, v]) => Math.abs(v) >= minMm3 || Math.abs(v) >= 0.005 * largest).map(([k]) => k));
  const dropped = vol.size - keepRoot.size;
  if (!dropped) return { mesh: m, dropped: 0 };
  const remap = new Int32Array(n).fill(-1);
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    if (!keepRoot.has(find(m.indices[t]))) continue;
    for (let k = 0; k < 3; k++) {
      const i = m.indices[t + k];
      if (remap[i] < 0) {
        remap[i] = pos.length / 3;
        pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        nrm.push(m.normals[3 * i] ?? 0, m.normals[3 * i + 1] ?? 0, m.normals[3 * i + 2] ?? 0);
      }
      idx.push(remap[i]);
    }
  }
  const keptVol = [...vol].filter(([k]) => keepRoot.has(k)).reduce((s2, [, v]) => s2 + Math.abs(v), 0);
  return { mesh: { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), bbox: m.bbox, volumeMm3: keptVol, areaMm2: m.areaMm2 }, dropped };
}

/** Signed distance (negative inside) of the printable wall material, in solver coordinates. */
export function wallSolid(design: Design, cfg: DesignConfig, opt: PrintOptions, plan?: MountPlan, joints: { axis: number; at: number }[] = []) {
  void opt;
  const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
  const wall = design.wall;
  // The vent style's own pattern (the same one the 3D view draws).
  const pat = perforation(cfg.prefs.ventStyleId);
  const [hx, hy] = holeHalfExtents(pat);
  const hr = Math.max(hx, hy);
  /**
   * Where a wall facing `s` along axis `a` is, over a rectangle of its plane: found from outside the
   * case inward, so a vent only ever cuts the outer wall it belongs to (on a shrinkwrapped shell a
   * side vent's holes would otherwise slice through any wall on its half of the case). Also says
   * where that wall faces the vent within VENT_MAX_TILT (50°) and is locally flat: a hole drilled
   * along the vent's axis through a flat panel slanted up to 50° keeps full webs (everything
   * stretches by the same 1/cos), but through a curved wall it leaves knife-edge webs and loose
   * bits, so the slope may not change much across a hole.
   */
  const wallMap = (a: number, s: number, R: { x0: number; y0: number; x1: number; y1: number }) => {
    const [xa, ya] = wallAxes(a as 0 | 1 | 2);
    const STEP = 2;
    const x0 = R.x0 - 2 * STEP;
    const y0 = R.y0 - 2 * STEP;
    const nx = Math.max(1, Math.ceil((R.x1 - R.x0) / STEP) + 5);
    const ny = Math.max(1, Math.ceil((R.y1 - R.y0) / STEP) + 5);
    const t = new Float32Array(nx * ny);
    const p: Vec3 = [0, 0, 0];
    const outside = s > 0 ? design.interior[a] + 40 : -40;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        p[xa] = x0 + i * STEP;
        p[ya] = y0 + j * STEP;
        let pos = NaN;
        for (let u = outside; s > 0 ? u > design.interior[a] / 2 : u < design.interior[a] / 2; u -= s * 0.5) {
          p[a] = u;
          if (F(p) <= -wall / 2) {
            pos = u;
            break;
          }
        }
        t[i + nx * j] = pos;
      }
    const at = (i: number, j: number) => t[Math.max(0, Math.min(nx - 1, i)) + nx * Math.max(0, Math.min(ny - 1, j))];
    return {
      /**
       * The wall's mid-plane position along the axis at (x, y), NaN where there is none.
       * Bilinear: on a slanted panel the nearest sample is off by up to slope × 1 mm, enough to
       * leave a skin over a hole.
       */
      pos: (x: number, y: number) => {
        const fx = (x - x0) / STEP;
        const fy = (y - y0) / STEP;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const u = fx - i;
        const v = fy - j;
        const a00 = at(i, j);
        const a10 = at(i + 1, j);
        const a01 = at(i, j + 1);
        const a11 = at(i + 1, j + 1);
        if (![a00, a10, a01, a11].every(Number.isFinite)) return at(Math.round(fx), Math.round(fy));
        return (a00 * (1 - u) + a10 * u) * (1 - v) + (a01 * (1 - u) + a11 * u) * v;
      },
      /** Slope of the wall position (dx, dy) at a point, or null where there is no wall. */
      slope: (x: number, y: number): [number, number] | null => {
        const i = Math.round((x - x0) / STEP);
        const j = Math.round((y - y0) / STEP);
        if (!Number.isFinite(at(i, j))) return null;
        const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * STEP);
        const gy = (at(i, j + 1) - at(i, j - 1)) / (2 * STEP);
        return Number.isFinite(gx) && Number.isFinite(gy) ? [gx, gy] : null;
      },
    };
  };
  type WallMap = ReturnType<typeof wallMap>;
  const MAX_SLOPE = Math.tan((VENT_MAX_TILT * Math.PI) / 180);
  // Rounded vent holes: a chamfer on the side the air comes in (outside for intakes, inside for
  // exhausts, both for passive vents, which breathe either way).
  const round = cfg.prefs.flow?.roundedHoles ? HOLE_ROUND : 0;
  const cuts = design.vents.map((v) => {
    const a = axisOf(v.wall);
    const [xa, ya] = wallAxes(a);
    const entry: 'out' | 'in' | 'both' = v.flow === 'in' ? 'out' : v.flow === 'out' ? 'in' : 'both';
    return { a, xa, ya, s: signOf(v.wall), rect: v.rect, solidCut: v.kind === 'io' || v.kind === 'bracket', map: null as null | WallMap, entry };
  });
  /** On the vent's own wall: within the wall band where the map puts that wall (thicker along the axis where the panel slants). */
  const onWall = (m: WallMap, p: Vec3, a: number, x: number, y: number) => {
    const t = m.pos(x, y);
    if (!Number.isFinite(t)) return false;
    const g = m.slope(x, y);
    const stretch = g ? Math.sqrt(1 + g[0] * g[0] + g[1] * g[1]) : 1;
    return Math.abs(p[a] - t) <= (wall / 2) * stretch + 1;
  };
  const JOINT_CLEAR = 3;
  // Mounting: openings cut through, screw holes through, and solid land around each screw.
  for (const o of plan?.openings ?? []) {
    const a = axisOf(o.wall);
    const [xa, ya] = wallAxes(a);
    cuts.push({ a, xa, ya, s: signOf(o.wall), rect: o.rect, solidCut: true, map: null, entry: 'both' });
  }
  const screws = (plan?.holes ?? []).map((h) => {
    const a = axisOf(h.wall);
    const [xa, ya] = wallAxes(a);
    return { a, xa, ya, s: signOf(h.wall), x: h.x, y: h.y, r: h.d / 2, map: null as null | WallMap };
  });
  const LAND = 3.5;
  const keep = [
    ...screws.map((h) => ({ a: h.a, s: h.s, x: h.x, y: h.y, r: h.r + LAND })),
    ...(plan?.solid ?? []).map((k) => ({ a: axisOf(k.wall), s: signOf(k.wall), x: k.x, y: k.y, r: k.r })),
  ];
  const bulk = (plan?.bulkheads ?? []).map((b) => {
    const [xa, ya] = wallAxes(b.axis);
    return { ...b, xa, ya };
  });
  // The frame's walls run from the plate out to the panel; moulded (shrinkwrap mode), only across the
  // fans' wall gap to the skin, which runs along the fans.
  const frames = (plan?.tiltFrames ?? []).map((tf) => {
    const t = tf.part.tilt!;
    return { ...tf, reach: cfg.prefs.mold ? t.size[2] + (t.clear?.hi[2] ?? 0) + 2 * wall + 6 : t.size[2] + t.size[0] };
  });
  /** Tilted parts' wedge frames (their own coordinates), kept inside the shell so they fuse to the wall. */
  const frameSdf = (p: Vec3, f: number) => {
    let best = Infinity;
    for (const tf of frames) {
      const near = boxSdf(p, tf.part.body);
      if (near > 6) {
        best = Math.min(best, near);
        continue;
      }
      const q = partLocal(tf.part, p);
      const [L, W, T] = tf.part.tilt!.size;
      let plate = boxSdf(q, { min: [0, 0, T - TILT_PLATE], max: [L, W, T] });
      for (const o of tf.fans) plate = Math.max(plate, o.r - Math.hypot(q[0] - o.x, q[1] - o.y));
      for (const h of tf.holes) plate = Math.max(plate, h.d / 2 - Math.hypot(q[0] - h.x, q[1] - h.y));
      const walls = Math.min(
        boxSdf(q, { min: [0, 0, T - TILT_PLATE], max: [L, 3, tf.reach] }),
        boxSdf(q, { min: [0, W - 3, T - TILT_PLATE], max: [L, W, tf.reach] }),
        boxSdf(q, { min: [L - 3, 0, T - TILT_PLATE], max: [L, W, tf.reach] }),
      );
      // Radiused turns (Flow tab): a curved fairing filling the corner between the lifted end's
      // wall and the panel, where the air turns from the vent into the fans. In the frame's own
      // (x, z) plane: the panel is the line z = T + x·tan(deg), the end wall's inner face x = L − 3.
      let fillet = Infinity;
      // Moulded (shrinkwrap mode): the skin runs along the fans, so there is no turn to fair.
      if (cfg.prefs.flow?.radiusedTurns && !cfg.prefs.mold) {
        const th = (tf.part.tilt!.deg * Math.PI) / 180;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        const xe = L - 3;
        const ze = T + xe * Math.tan(th);
        const Rf = Math.min(30, 0.6 * (ze - T));
        if (Rf > 3) {
          const d1 = [0, -1];
          const d2 = [-c, -sn];
          const bl = Math.hypot(d1[0] + d2[0], d1[1] + d2[1]);
          const b = [(d1[0] + d2[0]) / bl, (d1[1] + d2[1]) / bl];
          const half = Math.acos(Math.max(-1, Math.min(1, sn))) / 2;
          const C = [xe + (b[0] * Rf) / Math.sin(half), ze + (b[1] * Rf) / Math.sin(half)];
          const t = Rf / Math.tan(half);
          const T1 = [xe + d1[0] * t, ze + d1[1] * t];
          fillet = Math.max(
            Rf - Math.hypot(q[0] - C[0], q[2] - C[1]),
            q[0] - xe,
            (q[2] - T - q[0] * Math.tan(th)) * c,
            (q[0] - T1[0]) * b[0] + (q[2] - T1[1]) * b[1],
            -q[1],
            q[1] - W,
          );
        }
      }
      // Only inside the wall's mid-plane, so it joins the wall and never sticks out of the case.
      best = Math.min(best, Math.max(Math.min(plate, walls, fillet), f + wall / 2));
    }
    return best;
  };
  // Flow structures (Flow tab): duct plates, bell-mouths and diffusers, kept inside the shell.
  const flowSolids: { sdf: (p: Vec3) => number; min: Vec3; max: Vec3 }[] = [];
  const fl = cfg.prefs.flow;
  if (fl?.ducts)
    for (const id of ductCandidates(design)) {
      const part = design.parts.find((x) => x.id === id)!;
      // Run the plates on past the interior box to wherever the wall really is (a shrinkwrap or a
      // sculpted shell can sit further out); the clip at the wall's mid-plane fuses them to it.
      const a = axisOf(part.face!);
      const gap = ductGap(design, cfg, part, 0);
      if (signOf(part.face!) > 0) gap.max[a] += 40;
      else gap.min[a] -= 40;
      for (const b of ductPlates(gap, a, FLOW_WALL)) flowSolids.push({ sdf: (q) => boxSdf(q, b), min: b.min, max: b.max });
    }
  if (fl?.bellMouths || fl?.diffusers) {
    const sink = (id: string) => {
      const g = design.flow.groups.find((x) => x.id === id);
      return g ? (g.source === 'outside' ? 'in' : g.sink === 'outside' ? 'out' : null) : null;
    };
    flowSolids.push(...fanRings(design.recipe.flowFans ?? [], fl, design.interior, sink));
  }
  const flowSdf = (p: Vec3, f: number) => {
    let best = Infinity;
    for (const s of flowSolids) {
      let out = 0;
      for (let a = 0; a < 3; a++) out = Math.max(out, s.min[a] - p[a], p[a] - s.max[a]);
      if (out > 3) {
        best = Math.min(best, out);
        continue;
      }
      best = Math.min(best, Math.max(s.sdf(p), f + wall / 2));
    }
    return best;
  };
  return (p: Vec3) => {
    const f = F(p);
    // Band between the outer surface and one wall in.
    let d = Math.abs(f + wall / 2) - wall / 2;
    const tframe = Math.min(frames.length ? frameSdf(p, f) : Infinity, flowSolids.length ? flowSdf(p, f) : Infinity);
    // Bulkhead plates (fused to the wall), with their own holes and opening.
    let plate = Infinity;
    for (const b of bulk) {
      let e = boxSdf(p, b.slab);
      if (e > 3) {
        plate = Math.min(plate, e);
        continue;
      }
      for (const h of b.holes) e = Math.max(e, h.d / 2 - Math.hypot(p[b.xa] - h.x, p[b.ya] - h.y));
      if (b.opening) e = Math.max(e, -Math.max(b.opening.x0 - p[b.xa], p[b.xa] - b.opening.x1, b.opening.y0 - p[b.ya], p[b.ya] - b.opening.y1));
      plate = Math.min(plate, e);
    }
    if (d > 3) return Math.min(d, plate, tframe);
    for (const c of cuts) {
      const x = p[c.xa];
      const y = p[c.ya];
      const R = c.rect;
      if (x < R.x0 - 1 || x > R.x1 + 1 || y < R.y0 - 1 || y > R.y1 + 1) continue;
      // Only the vent's own outer wall.
      c.map ??= wallMap(c.a, c.s, R);
      if (!onWall(c.map, p, c.a, x, y)) continue;
      if (c.solidCut) {
        const inside = Math.max(R.x0 - x, x - R.x1, R.y0 - y, y - R.y1);
        d = Math.max(d, -inside);
      } else {
        const h = holeAt(pat, x, y);
        if (h.d >= 0) continue;
        // Whole holes only: inside the vent with a border, clear of screws and joints, on flat wall.
        if (h.cx - hx < R.x0 + 1.5 || h.cx + hx > R.x1 - 1.5 || h.cy - hy < R.y0 + 1.5 || h.cy + hy > R.y1 - 1.5) continue;
        if (keep.some((k) => k.a === c.a && k.s === c.s && Math.hypot(h.cx - k.x, h.cy - k.y) < k.r + hr)) continue;
        // On a flat-enough panel: within 50° of the vent's wall, and the slope about the same across the hole.
        const sl = [[0, 0], [-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]].map(([dx, dy]) => c.map!.slope(h.cx + dx, h.cy + dy));
        if (sl.some((g) => !g || Math.hypot(g[0], g[1]) > MAX_SLOPE)) continue;
        // Clear of joints; on a slanted panel the cut meets the wall obliquely, so by its slant over the wall's depth too.
        const [gx, gy] = sl[0]!;
        if (joints.some((j) => (j.axis === c.xa && Math.abs(j.at - h.cx) < hx + JOINT_CLEAR + wall * Math.abs(gx)) || (j.axis === c.ya && Math.abs(j.at - h.cy) < hy + JOINT_CLEAR + wall * Math.abs(gy)))) continue;
        // A joint across the wall's own axis cuts a slanted wall along a line: no hole within reach of it.
        if (joints.some((j) => j.axis === c.a)) {
          const ps = [[0, 0], [-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]].map(([dx, dy]) => c.map!.pos(h.cx + dx, h.cy + dy));
          const reach = wall + JOINT_CLEAR;
          if (joints.some((j) => j.axis === c.a && ps.some((q) => Math.abs(j.at - q) < reach) || (j.axis === c.a && Math.min(...ps) < j.at && Math.max(...ps) > j.at))) continue;
        }
        if (sl.some((g) => Math.hypot(g![0] - sl[0]![0], g![1] - sl[0]![1]) > 0.2)) continue;
        // Chamfer: the hole widens by (round − depth) within `round` of its entry face(s).
        let widen = 0;
        if (round > 0) {
          const fromOuter = -f;
          const fromInner = f + wall;
          if (c.entry !== 'in') widen = Math.max(widen, round - fromOuter);
          if (c.entry !== 'out') widen = Math.max(widen, round - fromInner);
        }
        d = Math.max(d, -(h.d - Math.max(0, widen)));
      }
    }
    for (const h of screws) {
      const x = p[h.xa];
      const y = p[h.ya];
      if (Math.abs(x - h.x) > h.r + 1 || Math.abs(y - h.y) > h.r + 1) continue;
      h.map ??= wallMap(h.a, h.s, { x0: h.x - h.r - 2, y0: h.y - h.r - 2, x1: h.x + h.r + 2, y1: h.y + h.r + 2 });
      if (!onWall(h.map, p, h.a, h.x, h.y)) continue;
      d = Math.max(d, h.r - Math.hypot(x - h.x, y - h.y));
    }
    return Math.min(d, plate, tframe);
  };
}

/** Split the shell's bounds into a grid of pieces no larger than the bed allows. */
export function planPieces(design: Design, opt: PrintOptions, bounds?: Box, field?: (p: Vec3) => number): Box[] {
  const pad = design.wall + 14;
  // Sculpted shells reach past the interior box: split their measured bounds instead.
  const lo: Vec3 = bounds ? ([...bounds.min] as Vec3) : [-pad, -pad, -pad];
  const hi: Vec3 = bounds ? ([...bounds.max] as Vec3) : [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad];
  // Pieces may be rotated on the bed, so size them by the smallest bed dimension (less a margin).
  const max = Math.min(...opt.bed) - 8;
  const counts = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / max)));
  // Cut positions along each axis: evenly spaced, then (given the shell's field) each nudged within
  // the slack the bed leaves to where it grazes the least wall. A cut running almost along a wall
  // (a slanted skin) leaves slivers too thin to print where it crosses the wall; one inside a wall
  // parallel to it splits that wall into thin sheets.
  const cuts = [0, 1, 2].map((a) => {
    const step = (hi[a] - lo[a]) / counts[a];
    const xs = Array.from({ length: counts[a] + 1 }, (_, i) => lo[a] + i * step);
    if (!field || counts[a] < 2) return xs;
    const slack = Math.min(30, (max - step) / 2);
    const [b1, b2] = [0, 1, 2].filter((x) => x !== a);
    // Part faces across this axis: the shell steps there, and a cut a few mm off a step leaves chips.
    const faces = design.parts.flatMap((p) => [p.body.min[a], p.body.max[a], p.clearance.min[a], p.clearance.max[a]]);
    const grazing = (at: number) => {
      let n = 0;
      for (const f of faces) if (Math.abs(f - at) < 12) n += 25;
      const q: Vec3 = [0, 0, 0];
      for (let u = lo[b1]; u <= hi[b1]; u += 4)
        for (let v = lo[b2]; v <= hi[b2]; v += 4) {
          q[a] = at;
          q[b1] = u;
          q[b2] = v;
          const f = field(q);
          if (Math.abs(f + design.wall / 2) > design.wall) continue;
          const g = [0, 1, 2].map((k) => {
            const e = [...q] as Vec3;
            e[k] += 0.5;
            return field(e) - f;
          });
          const gl = Math.hypot(g[0], g[1], g[2]);
          // Grazing a wall that runs across the cut, or lying inside one that runs along it (worse: a thin sheet).
          if (Math.abs(g[a]) < 0.4 * gl) n++;
          else if (Math.abs(g[a]) > 0.8 * gl) n += 4;
        }
      return n;
    };
    for (let i = 1; i < counts[a]; i++) {
      let best = xs[i];
      const evenN = grazing(best);
      // Even cuts that graze no real stretch of wall stay put (moving them only trades one joint for another).
      if (evenN < 20) continue;
      let bestN = evenN;
      for (let d = -slack; d <= slack && bestN > 0; d += 3) {
        const at = lo[a] + i * step + d;
        const n = grazing(at);
        if (n < bestN || (n === bestN && Math.abs(d) < Math.abs(best - lo[a] - i * step))) {
          best = at;
          bestN = n;
        }
      }
      xs[i] = best;
    }
    return xs;
  });
  const pieces: Box[] = [];
  for (let i = 0; i < counts[0]; i++)
    for (let j = 0; j < counts[1]; j++)
      for (let k = 0; k < counts[2]; k++) {
        const ijk = [i, j, k];
        const b: Box = { min: [0, 0, 0], max: [0, 0, 0] };
        for (let a = 0; a < 3; a++) {
          b.min[a] = cuts[a][ijk[a]];
          b.max[a] = cuts[a][ijk[a] + 1];
        }
        pieces.push(b);
      }
  return pieces;
}

function boxSdf(p: Vec3, b: Box) {
  let out = 0;
  let inMax = -Infinity;
  for (let a = 0; a < 3; a++) {
    const c = (b.min[a] + b.max[a]) / 2;
    const q = Math.abs(p[a] - c) - (b.max[a] - b.min[a]) / 2;
    if (q > 0) out += q * q;
    inMax = Math.max(inMax, q);
  }
  return Math.sqrt(out) + Math.min(inMax, 0);
}

/** Mesh one piece: wall solid clipped to the piece box (flat cut faces, closed). */
export function meshPiece(solid: (p: Vec3) => number, box: Box, cell: number): ShellMesh {
  const pad = 2 * cell;
  const n = [0, 1, 2].map((a) => Math.ceil((box.max[a] - box.min[a] + 2 * pad) / cell) + 1) as Vec3;
  const g: Grid = { n, origin: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad], cell, vals: new Float32Array(n[0] * n[1] * n[2]) };
  const p: Vec3 = [0, 0, 0];
  let id = 0;
  for (let k = 0; k < n[2]; k++)
    for (let j = 0; j < n[1]; j++)
      for (let i = 0; i < n[0]; i++) {
        p[0] = g.origin[0] + i * cell;
        p[1] = g.origin[1] + j * cell;
        p[2] = g.origin[2] + k * cell;
        const b = boxSdf(p, box);
        g.vals[id++] = b > cell ? b : Math.max(solid(p), b);
      }
  return meshGrid(g, 0);
}

export function printPieces(design: Design, cfg: DesignConfig, opt: PrintOptions, progress?: (done: number, total: number) => void, plan = mountPlan(design, cfg)): PrintPiece[] {
  const boxes = planPieces(design, opt, isSculpt(cfg) ? shellBounds(design, cfg) : undefined, shellField(design, cfg, cfg.prefs.organic ?? 0));
  // Joints between pieces: the box faces shared by two pieces.
  const joints: { axis: number; at: number }[] = [];
  for (let a = 0; a < 3; a++) {
    const lo = Math.min(...boxes.map((b) => b.min[a]));
    for (const at of new Set(boxes.map((b) => b.min[a]))) if (at > lo + 1e-6) joints.push({ axis: a, at });
  }
  const solid = wallSolid(design, cfg, opt, plan, joints);
  const web = perforation(cfg.prefs.ventStyleId).web;
  const out: PrintPiece[] = [];
  // Each standoff goes with the piece that holds all of it; one cut by a joint is printed on its own.
  const inside = (s: Standoff, b: Box) => {
    const m = bossMesh(s).bbox;
    return [0, 1, 2].every((a) => m.min[a] >= b.min[a] - 0.01 && m.max[a] <= b.max[a] + 0.01);
  };
  const loose = plan.standoffs.filter((s) => !boxes.some((b) => inside(s, b)));
  boxes.forEach((box, idx) => {
    progress?.(idx, boxes.length);
    const ext = Math.max(...[0, 1, 2].map((a) => box.max[a] - box.min[a]));
    // Fine enough that every web between holes spans two cells (thinner ones pinch off into loose bits).
    const cell = Math.min(1.8, web / 2, Math.max(1, ext / 160));
    const raw = meshPiece(solid, box, cell);
    const { mesh: kept, dropped } = dropFragments(raw);
    let mesh = kept;
    const bosses = plan.standoffs.filter((s) => !loose.includes(s) && inside(s, box) && boxes.find((b) => inside(s, b)) === box);
    if (mesh.indices.length && bosses.length) mesh = mergeMeshes([mesh, ...bosses.map((s) => bossMesh(s))]);
    if (mesh.indices.length) out.push({ name: `piece-${String(out.length + 1).padStart(2, '0')}`, box, mesh, dropped });
  });
  loose.forEach((s, i) => out.push({ name: `standoff-${i + 1}`, box: bossMesh(s).bbox, mesh: bossMesh(s) }));
  // Partition plates, trimmed to the shell, cut into strips that fit the bed.
  if (design.chamber) {
    const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
    const bed = Math.min(...opt.bed) - 4;
    let k = 0;
    for (const cut of design.chamber.cuts) {
      const [xa, ya] = wallAxes(cut.axis);
      const long = cut.region.max[xa] - cut.region.min[xa] >= cut.region.max[ya] - cut.region.min[ya] ? xa : ya;
      const short = long === xa ? ya : xa;
      const nLong = Math.ceil((cut.region.max[long] - cut.region.min[long]) / bed);
      const nShort = Math.ceil((cut.region.max[short] - cut.region.min[short]) / bed);
      for (let i = 0; i < nLong; i++)
        for (let j = 0; j < nShort; j++) {
          const region: Box = { min: [...cut.region.min] as Vec3, max: [...cut.region.max] as Vec3 };
          const L = (cut.region.max[long] - cut.region.min[long]) / nLong;
          const S = (cut.region.max[short] - cut.region.min[short]) / nShort;
          region.min[long] = cut.region.min[long] + i * L;
          region.max[long] = region.min[long] + L;
          region.min[short] = cut.region.min[short] + j * S;
          region.max[short] = region.min[short] + S;
          const mesh = plateMesh(design, cfg, { ...cut, region }, F, 0.5);
          if (mesh.indices.length) out.push({ name: `partition-${String(++k).padStart(2, '0')}`, box: mesh.bbox, mesh });
        }
    }
  }
  progress?.(boxes.length, boxes.length);
  return out;
}

/**
 * Fit-test plates, to print before the case: the board's standoffs on a thin plate (screw the
 * board onto it), a template per fan size and the PSU face (hold them against the parts). Each
 * takes minutes; they catch a wrong hole pattern before hours of printing.
 */
export function fitTestPieces(design: Design, cfg: DesignConfig, plan: MountPlan): PrintPiece[] {
  const out: PrintPiece[] = [];
  const T = 3;
  const plateSdf = (lo: Vec3, hi: Vec3) => (p: Vec3) => boxSdf(p, { min: lo, max: hi });
  const flat = (sdf: (p: Vec3) => number, lo: Vec3, hi: Vec3, cell = 0.5) => meshPiece(sdf, { min: lo, max: hi }, cell);
  // Board: plate under the standoffs, bosses 8 mm tall with insert holes.
  const boardStandoffs = plan.standoffs.filter((st) => st.label.startsWith('standoff'));
  if (boardStandoffs.length) {
    const xs = boardStandoffs.map((st) => st.top[0]);
    const ys = boardStandoffs.map((st) => st.top[1]);
    const x0 = Math.min(...xs) - 10;
    const y0 = Math.min(...ys) - 10;
    const lo: Vec3 = [0, 0, 0];
    const hi: Vec3 = [Math.max(...xs) - x0 + 10, Math.max(...ys) - y0 + 10, T];
    // Lighten the plate: keep a frame and the corners around each boss.
    const holesAt = boardStandoffs.map((st) => [st.top[0] - x0, st.top[1] - y0] as [number, number]);
    const sdf = (p: Vec3) => {
      let d = plateSdf(lo, hi)(p);
      const inner = -boxSdf(p, { min: [12, 12, -1], max: [hi[0] - 12, hi[1] - 12, T + 1] });
      const nearBoss = Math.min(...holesAt.map(([x, y]) => Math.hypot(p[0] - x, p[1] - y))) - 12;
      d = Math.max(d, Math.min(inner, nearBoss));
      return d;
    };
    const plate = flat(sdf, lo, hi, 1);
    const bosses = holesAt.map(([x, y], i) => bossMesh({ label: `fit ${i + 1}`, top: [x, y, T + 8], base: [x, y, T / 2], axis: 2, length: 8 + T / 2 }));
    out.push({ name: 'fit-board-standoffs', box: { min: lo, max: [hi[0], hi[1], T + 8] }, mesh: mergeMeshes([plate, ...bosses]) });
  }
  // Fans: one template per size used, with the bore and the four holes.
  const sizes = [...new Set(design.parts.filter((p) => p.fan && (p.kind === 'rad-cpu' || p.kind === 'rad-gpu' || p.kind === 'case-fan')).map((p) => p.fan!.size))];
  for (const size of sizes) {
    const sp = fanHoleSpacing(size);
    if (!sp) continue;
    const W = size + 6;
    const c = W / 2;
    const sdf = (p: Vec3) => {
      let d = boxSdf(p, { min: [0, 0, 0], max: [W, W, 2.4] });
      d = Math.max(d, size / 2 - 4 - Math.hypot(p[0] - c, p[1] - c));
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) d = Math.max(d, 2.5 - Math.hypot(p[0] - c - (dx * sp.spacing) / 2, p[1] - c - (dy * sp.spacing) / 2));
      return d;
    };
    out.push({ name: `fit-fan-${size}`, box: { min: [0, 0, 0], max: [W, W, 2.4] }, mesh: flat(sdf, [0, 0, 0], [W, W, 2.4]) });
  }
  // GPU bracket clamp: a bar on the bosses that steps down onto the bracket plate.
  if (plan.clamp) {
    const c = plan.clamp;
    const [L, Wb] = c.size;
    const top = 3;
    const plate = 1; // bracket plate thickness (typical ~0.9 mm) under the pressing step
    const sdf = (p: Vec3) => {
      // z = 0 at the panel; the bar sits on the boss tops (z = rise); the press reaches the plate.
      let d = boxSdf(p, { min: [0, 0, c.rise], max: [L, Wb, c.rise + top] });
      d = Math.min(d, boxSdf(p, { min: [c.press.x0, c.press.y0, plate], max: [c.press.x1, c.press.y1, c.rise + top] }));
      for (const [hx, hy] of c.holes) d = Math.max(d, 1.7 - Math.hypot(p[0] - hx, p[1] - hy));
      return d;
    };
    out.push({ name: 'gpu-bracket-clamp', box: { min: [0, 0, 0], max: [L, Wb, c.rise + top] }, mesh: flat(sdf, [0, 0, plate], [L, Wb, c.rise + top]) });
  }
  // PSU face: holes, the opening, and a notch on the fan side's edge.
  const ph = psuHoles(cfg.parts.psu);
  if (ph) {
    const Wd = cfg.parts.psu.width;
    const Hd = cfg.parts.psu.height;
    const sdf = (p: Vec3) => {
      const x = p[0] - Wd / 2;
      const y = p[1] - Hd / 2;
      let d = boxSdf(p, { min: [0, 0, 0], max: [Wd, Hd, 2.4] });
      for (const [hx, hy] of ph.holes) d = Math.max(d, 2.5 - Math.hypot(x - hx, y - hy));
      d = Math.max(d, -Math.max(Math.abs(x) - ph.opening.hx, Math.abs(y) - ph.opening.hy));
      d = Math.max(d, 3 - Math.hypot(x, y - Hd / 2));
      return d;
    };
    out.push({ name: `fit-psu-${cfg.parts.psu.formFactor}`, box: { min: [0, 0, 0], max: [Wd, Hd, 2.4] }, mesh: flat(sdf, [0, 0, 0], [Wd, Hd, 2.4]) });
  }
  return out;
}

/** Hardware list and assembly order, from the mount plan. */
export function buildGuide(plan: MountPlan, fits: PrintPiece[]): string[] {
  return [
    'BUILD GUIDE',
    '',
    '1. Print the fit tests first (fit-test/, minutes each), and check them against your parts:',
    ...fits.map((f) => `   - ${f.name}.stl` + (f.name.startsWith('fit-board') ? ': melt in the inserts, screw your motherboard on — all four holes must line up.' : f.name.startsWith('fit-fan') ? ': hold it on a fan; the four holes must meet the fan’s screw holes.' : ': hold it against the PSU’s inlet end; the notch marks the fan side. The holes must meet the PSU’s threads.')),
    '   Any mismatch: correct it in Parts (board mounting holes) before printing the case.',
    '',
    '2. Print the pieces. Standoffs are printed on the bottom panel with their insert holes; screw holes, the PSU opening, the power button and (if needed) the IEC socket cut-out are cut through.',
    '3. Glue the pieces; let it cure.',
    '4. Heat-set the M3 inserts into the standoffs (soldering iron at the filament’s print temperature, press straight down, let cool).',
    '5. Fit the PSU (screws through its plate or the panel), then the radiator(s) through the panel and fans, then the motherboard (CPU, cooler and RAM already on it), then the graphics card; screw gpu-bracket-clamp.stl over its bracket plate.',
    '6. Wire the power button to the board’s PWR_SW pins; mains through the PSU inlet or the IEC socket. Earth: tie one standoff to PSU ground.',
    '',
    'Hardware:',
    ...plan.hardware.map((h) => `  ${h.qty} × ${h.item} — ${h.note}`),
    '',
    'Check before building:',
    ...plan.warnings.map((w) => `  ! ${w}`),
    '',
    'Where the dimensions come from:',
    ...plan.sources.map((s) => `  ${s}`),
    '',
  ];
}

// ------------------------------------------------------------------ files

/** Solver → world axes for the case orientation (same mapping as the 3D view, uncentred). */
function toWorld(cfg: DesignConfig, x: number, y: number, z: number): [number, number, number] {
  return cfg.prefs.orientation === 'tower' ? [-z, y, x] : [y, z, x];
}

/** Binary STL of a mesh, in millimetres, oriented as the case stands. */
export function stlBinary(mesh: ShellMesh, cfg: DesignConfig): Uint8Array {
  const tris = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = 'caseblanket print piece, mm';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  const P = mesh.positions;
  for (let t = 0; t < tris; t++) {
    const v = [0, 1, 2].map((q) => {
      const i = mesh.indices[3 * t + q] * 3;
      return toWorld(cfg, P[i], P[i + 1], P[i + 2]);
    });
    const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true);
    dv.setFloat32(o + 4, ny / l, true);
    dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const p of v) {
      dv.setFloat32(o, p[0], true);
      dv.setFloat32(o + 4, p[1], true);
      dv.setFloat32(o + 8, p[2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP (stored, no compression). */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function printReadme(design: Design, opt: PrintOptions, pieces: PrintPiece[], manifest?: Manifest, plan?: MountPlan, fits: PrintPiece[] = [], ventStyleId = 'round'): string {
  const pat = perforation(ventStyleId);
  const patText = pat.kind === 'slots' ? `${pat.size} × ${pat.length} mm slots, rows ${pat.rowPitch} mm apart` : pat.kind === 'hex' ? `hexagonal holes ${pat.size} mm across flats on a ${pat.pitch} mm pitch` : `Ø${pat.size} mm holes on a ${pat.pitch} mm pitch`;
  const dropped = pieces.reduce((s2, p) => s2 + (p.dropped ?? 0), 0);
  const s = opt.slicer ?? DEFAULT_SLICER;
  const lines = [
    'caseblanket — 3D-printable shell',
    '',
    ...(manifest
      ? [
          `Plan (manifest.csv has every piece): ${manifest.rows.length} pieces, ≈ ${Math.round(manifest.totalMassG)} g of filament, ≈ ${(manifest.totalTimeMin / 60).toFixed(0)} h of printing, ${manifest.totalSupportCm3.toFixed(0)} cm³ of support in the suggested orientations.`,
          `Estimates assume ${s.layerMm} mm layers, ${s.walls} walls of ${s.lineMm} mm, ${Math.round(s.infill * 100)} % infill, ${s.speedMmS} mm/s; overhangs over ${OVERHANG_DEG}° from vertical need support.`,
          'Filament per piece follows the hottest air it meets at full load, kept 20 K under the filament’s heat-deflection temperature (typical values; check your filament’s datasheet).',
          '',
          ...manifest.flags.map((f) => `! ${f}`),
          '',
          ...(plan
            ? []
            : ['Threaded inserts and grounding:', ...manifest.inserts.map((i) => `  ${i.count} × ${i.what}: ${i.note}`), '']),
        ]
      : []),
    ...(plan ? buildGuide(plan, fits) : []),
    `Wall ${design.wall} mm (set the material and wall thickness in Tune → Shape & finish; 2.4 mm or more suits FDM printing).`,
    `Vents: ${patText} (${Math.round(openShare(pat) * 100)} % open, webs at least ${pat.web} mm), whole holes only, where the wall faces its vent, with a solid border at every joint. I/O and GPU bracket openings are cut through.`,
    ...(dropped ? [`${dropped} loose fragment${dropped > 1 ? 's' : ''} (bits that would print floating) were removed from the pieces.`] : []),
    `Pieces are cut on straight planes to fit a ${opt.bed.join(' × ')} mm bed; glue or bridge them along the cut faces.`,
    'Units: millimetres. Orientation: as the case stands (Y up).',
    '',
    ...pieces.map((p) => {
      const s = [0, 1, 2].map((a) => (p.box.max[a] - p.box.min[a]).toFixed(0));
      return `${p.name}.stl  (cut box ${s.join(' × ')} mm, ${(p.mesh.indices.length / 3).toLocaleString()} triangles)`;
    }),
    '',
    ...(design.chamber
      ? [
          '',
          `partition-*.stl are the ${PARTITION_THICKNESS} mm internal walls that split the case into ${design.chamber.chambers.length} air chambers. Glue them into the shell; the round holes take hoses and cables (fit grommets or foam to seal them).`,
        ]
      : []),
    plan
      ? 'Joints: glue the cut faces (PETG: medium CA or a PETG solvent cement) and seal them; the airflow model counts a 0.1 mm leak along every joint. No alignment pins are generated: tape the pieces square while the glue sets.'
      : 'Not included as geometry: standoff bosses, screw holes, alignment pins and fan mounting holes; add them in your CAD tool (the insert list above says where they go). Joints: glue the cut faces and seal them; the airflow model counts a 0.1 mm leak along every joint.',
  ];
  return lines.join('\n');
}
