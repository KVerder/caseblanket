import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Box, type Vec3 } from '../solver/geometry';
import { meshGrid, shellField, type Grid, type ShellMesh } from '../solver/shrinkwrap';
import { PARTITION_THICKNESS } from '../solver/chambers';
import { plateMesh } from '../solver/partitions';
import { DEFAULT_SLICER, OVERHANG_DEG, type Manifest, type SlicerSettings } from './analysis';
import { bossMesh, fanHoleSpacing, mergeMeshes, mountPlan, psuHoles, type MountPlan, type Standoff } from './mounts';

/**
 * Print-ready shell: the wall as a solid (outer surface down to one wall thickness in), with vent
 * perforations cut through as round holes and the I/O and bracket openings as rectangular
 * cut-outs, split into pieces that fit the print bed. Every piece is meshed as a closed solid.
 */

export interface PrintOptions {
  /** Printer build volume, mm. Pieces are cut so each fits in its smallest dimension cube. */
  bed: [number, number, number];
  holeDiameter: number;
  holePitch: number;
  /** Preferred filament (material id); hotter pieces are moved to a higher-temperature one. */
  filament?: string;
  slicer?: SlicerSettings;
  /** Plan a conductive liner for EMI shielding. */
  liner?: boolean;
}

export const DEFAULT_PRINT: PrintOptions = { bed: [250, 250, 250], holeDiameter: 5, holePitch: 7, filament: 'petg', slicer: DEFAULT_SLICER, liner: false };

export interface PrintPiece {
  name: string;
  box: Box;
  mesh: ShellMesh;
}

/** Signed distance (negative inside) of the printable wall material, in solver coordinates. */
export function wallSolid(design: Design, cfg: DesignConfig, opt: PrintOptions, plan?: MountPlan) {
  const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
  const wall = design.wall;
  const r = opt.holeDiameter / 2;
  const P = opt.holePitch;
  const rowH = P * 0.866;
  const cuts = design.vents.map((v) => {
    const a = axisOf(v.wall);
    const [xa, ya] = wallAxes(a);
    return { a, xa, ya, s: signOf(v.wall), rect: v.rect, solidCut: v.kind === 'io' || v.kind === 'bracket' };
  });
  // Mounting: openings cut through, screw holes through, and solid land around each screw.
  for (const o of plan?.openings ?? []) {
    const a = axisOf(o.wall);
    const [xa, ya] = wallAxes(a);
    cuts.push({ a, xa, ya, s: signOf(o.wall), rect: o.rect, solidCut: true });
  }
  const screws = (plan?.holes ?? []).map((h) => {
    const a = axisOf(h.wall);
    const [xa, ya] = wallAxes(a);
    return { a, xa, ya, s: signOf(h.wall), x: h.x, y: h.y, r: h.d / 2 };
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
  const holeDist = (x: number, y: number) => {
    const ri = Math.round(y / rowH);
    let best = Infinity;
    for (let row = ri - 1; row <= ri + 1; row++) {
      const off = row & 1 ? P / 2 : 0;
      const ci = Math.round((x - off) / P);
      for (let col = ci - 1; col <= ci + 1; col++) best = Math.min(best, Math.hypot(x - (col * P + off), y - row * rowH));
    }
    return best - r;
  };
  return (p: Vec3) => {
    const f = F(p);
    // Band between the outer surface and one wall in.
    let d = Math.abs(f + wall / 2) - wall / 2;
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
    if (d > 3) return Math.min(d, plate);
    for (const c of cuts) {
      // Only cut the wall on the vent's own side of the case.
      const mid = design.interior[c.a] / 2;
      if (c.s > 0 ? p[c.a] < mid : p[c.a] > mid) continue;
      const x = p[c.xa];
      const y = p[c.ya];
      const R = c.rect;
      if (c.solidCut) {
        const inside = Math.max(R.x0 - x, x - R.x1, R.y0 - y, y - R.y1);
        d = Math.max(d, -inside);
      } else {
        if (x < R.x0 + r + 1 || x > R.x1 - r - 1 || y < R.y0 + r + 1 || y > R.y1 - r - 1) continue;
        if (keep.some((h) => h.a === c.a && h.s === c.s && Math.hypot(x - h.x, y - h.y) < h.r + r)) continue;
        d = Math.max(d, -holeDist(x, y));
      }
    }
    for (const h of screws) {
      const mid = design.interior[h.a] / 2;
      if (h.s > 0 ? p[h.a] < mid : p[h.a] > mid) continue;
      d = Math.max(d, h.r - Math.hypot(p[h.xa] - h.x, p[h.ya] - h.y));
    }
    return Math.min(d, plate);
  };
}

/** Split the shell's bounds into a grid of pieces no larger than the bed allows. */
export function planPieces(design: Design, opt: PrintOptions): Box[] {
  const pad = design.wall + 14;
  const lo: Vec3 = [-pad, -pad, -pad];
  const hi: Vec3 = [design.interior[0] + pad, design.interior[1] + pad, design.interior[2] + pad];
  // Pieces may be rotated on the bed, so size them by the smallest bed dimension (less a margin).
  const max = Math.min(...opt.bed) - 8;
  const counts = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / max)));
  const pieces: Box[] = [];
  for (let i = 0; i < counts[0]; i++)
    for (let j = 0; j < counts[1]; j++)
      for (let k = 0; k < counts[2]; k++) {
        const ijk = [i, j, k];
        const b: Box = { min: [0, 0, 0], max: [0, 0, 0] };
        for (let a = 0; a < 3; a++) {
          const step = (hi[a] - lo[a]) / counts[a];
          b.min[a] = lo[a] + ijk[a] * step;
          b.max[a] = lo[a] + (ijk[a] + 1) * step;
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
  const solid = wallSolid(design, cfg, opt, plan);
  const boxes = planPieces(design, opt);
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
    const cell = Math.min(1.8, Math.max(1, ext / 160, opt.holeDiameter / 4));
    let mesh = meshPiece(solid, box, cell);
    const bosses = plan.standoffs.filter((s) => !loose.includes(s) && inside(s, box) && boxes.find((b) => inside(s, b)) === box);
    if (mesh.indices.length && bosses.length) mesh = mergeMeshes([mesh, ...bosses.map((s) => bossMesh(s))]);
    if (mesh.indices.length) out.push({ name: `piece-${String(out.length + 1).padStart(2, '0')}`, box, mesh });
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
  const sizes = [...new Set(design.parts.filter((p) => p.fan && (p.kind === 'rad-cpu' || p.kind === 'rad-gpu')).map((p) => p.fan!.size))];
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

export function printReadme(design: Design, opt: PrintOptions, pieces: PrintPiece[], manifest?: Manifest, plan?: MountPlan, fits: PrintPiece[] = []): string {
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
    `Vents: ${opt.holeDiameter} mm holes on a ${opt.holePitch} mm hex pitch. I/O and GPU bracket openings are cut through.`,
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
