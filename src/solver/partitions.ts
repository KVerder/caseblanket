import type { DesignConfig } from '../model/types';
import { PARTITION_THICKNESS, type Partition } from './chambers';
import type { Design } from './evaluate';
import { wallAxes, type Box, type Vec3 } from './geometry';
import { routedPaths } from './hoses';
import type { Field, ShellMesh } from './shrinkwrap';

/** Clearance around a hose or cable where it passes through a partition (grommet), mm. */
export const GROMMET_CLEARANCE = 1.5;
/** How far a partition reaches into the case wall so the two bond, mm. */
const WALL_OVERLAP = 0.6;

export function boxSdf(p: Vec3, b: Box) {
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

export function plateBox(cut: Partition): Box {
  const min = [...cut.region.min] as Vec3;
  const max = [...cut.region.max] as Vec3;
  min[cut.axis] = cut.at - PARTITION_THICKNESS / 2;
  max[cut.axis] = cut.at + PARTITION_THICKNESS / 2;
  return { min, max };
}

/** Where hoses and cables pierce a partition, with the hole radius. */
export function passThroughs(design: Design, cfg: DesignConfig, cut: Partition): { at: Vec3; r: number }[] {
  const out: { at: Vec3; r: number }[] = [];
  for (const h of routedPaths(design, cfg)) {
    for (let i = 1; i < h.points.length; i++) {
      const p = h.points[i - 1];
      const q = h.points[i];
      const sp = p[cut.axis] - cut.at;
      const sq = q[cut.axis] - cut.at;
      if (sp * sq >= 0) continue;
      const t = sp / (sp - sq);
      const x: Vec3 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      if (x.every((v, a) => v >= cut.region.min[a] - 1e-6 && v <= cut.region.max[a] + 1e-6)) out.push({ at: x, r: h.radius + GROMMET_CLEARANCE });
    }
  }
  return out;
}

/**
 * In-plane mask of one partition plate: cells of the plate's region that lie inside the shell
 * (reaching WALL_OVERLAP into its wall) and outside every pass-through hole.
 */
export function plateMask(design: Design, cfg: DesignConfig, cut: Partition, shell: Field, cell: number) {
  const [xa, ya] = wallAxes(cut.axis);
  const holes = passThroughs(design, cfg, cut);
  const x0 = cut.region.min[xa];
  const y0 = cut.region.min[ya];
  const nx = Math.max(1, Math.round((cut.region.max[xa] - x0) / cell));
  const ny = Math.max(1, Math.round((cut.region.max[ya] - y0) / cell));
  const cx = (cut.region.max[xa] - x0) / nx;
  const cy = (cut.region.max[ya] - y0) / ny;
  const mask = new Uint8Array(nx * ny);
  const p: Vec3 = [0, 0, 0];
  p[cut.axis] = cut.at;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      p[xa] = x0 + (i + 0.5) * cx;
      p[ya] = y0 + (j + 0.5) * cy;
      if (shell(p) + design.wall - WALL_OVERLAP > 0) continue;
      if (holes.some((h) => Math.hypot(p[xa] - h.at[xa], p[ya] - h.at[ya]) < h.r)) continue;
      mask[i + nx * j] = 1;
    }
  return { xa, ya, x0, y0, nx, ny, cx, cy, mask };
}

/** Closed mesh of a plate: its mask extruded to the partition thickness (top, bottom and side faces). */
export function plateMesh(design: Design, cfg: DesignConfig, cut: Partition, shell: Field, cell: number): ShellMesh {
  const m = plateMask(design, cfg, cut, shell, cell);
  const a = cut.axis;
  const lo = cut.at - PARTITION_THICKNESS / 2;
  const hi = cut.at + PARTITION_THICKNESS / 2;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < m.nx && j < m.ny ? m.mask[i + m.nx * j] : 0);
  const v = (x: number, y: number, z: number): Vec3 => {
    const q: Vec3 = [0, 0, 0];
    q[m.xa] = x;
    q[m.ya] = y;
    q[a] = z;
    return q;
  };
  // Quad with corners in order; n = outward normal.
  const quad = (c: Vec3[], n: Vec3) => {
    const base = pos.length / 3;
    for (const q of c) {
      pos.push(...q);
      nrm.push(...n);
    }
    // Orient the two triangles so their winding matches the normal.
    const e1 = c[1].map((x, k) => x - c[0][k]);
    const e2 = c[2].map((x, k) => x - c[0][k]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ok = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0;
    if (ok) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const unit = (axis: number, s: number): Vec3 => {
    const u: Vec3 = [0, 0, 0];
    u[axis] = s;
    return u;
  };
  let cells = 0;
  for (let j = 0; j < m.ny; j++)
    for (let i = 0; i < m.nx; i++) {
      if (!at(i, j)) continue;
      cells++;
      const x0 = m.x0 + i * m.cx;
      const x1 = x0 + m.cx;
      const y0 = m.y0 + j * m.cy;
      const y1 = y0 + m.cy;
      quad([v(x0, y0, hi), v(x1, y0, hi), v(x1, y1, hi), v(x0, y1, hi)], unit(a, 1));
      quad([v(x0, y0, lo), v(x1, y0, lo), v(x1, y1, lo), v(x0, y1, lo)], unit(a, -1));
      if (!at(i - 1, j)) quad([v(x0, y0, lo), v(x0, y1, lo), v(x0, y1, hi), v(x0, y0, hi)], unit(m.xa, -1));
      if (!at(i + 1, j)) quad([v(x1, y0, lo), v(x1, y1, lo), v(x1, y1, hi), v(x1, y0, hi)], unit(m.xa, 1));
      if (!at(i, j - 1)) quad([v(x0, y0, lo), v(x1, y0, lo), v(x1, y0, hi), v(x0, y0, hi)], unit(m.ya, -1));
      if (!at(i, j + 1)) quad([v(x0, y1, lo), v(x1, y1, lo), v(x1, y1, hi), v(x0, y1, hi)], unit(m.ya, 1));
    }
  const box = plateBox(cut);
  const cellArea = m.cx * m.cy;
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint32Array(idx),
    bbox: box,
    volumeMm3: cells * cellArea * PARTITION_THICKNESS,
    areaMm2: cells * cellArea,
  };
}

/** Meshes of every partition plate in a design. */
export function plateMeshes(design: Design, cfg: DesignConfig, shell: Field, cell = 2): ShellMesh[] {
  if (!design.chamber) return [];
  return design.chamber.cuts.map((cut) => plateMesh(design, cfg, cut, shell, cell));
}
