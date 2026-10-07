import { FINISHES } from '../model/presets';
import type { DesignConfig, Preferences } from '../model/types';
import { simulateSteady } from '../cfd/run';
import { NO_SHAPING } from '../cfd/scene';
import type { Design } from './evaluate';
import { ALL_FLOW } from './flow';
import type { Vec3 } from './geometry';
import { meshShell, type ShellMesh } from './shrinkwrap';
import { solve } from './solve';

/**
 * Funkify: sculpted, organic cases that give up nothing on cooling. Volume and thickness are
 * ignored; only how cool it runs and how it looks count.
 *
 * 1. Thermal floor. The solver runs with cooling as the only goal (size limits off, every flow
 *    structure on, chambers and tilt allowed). The best tightest-part margin it finds is the floor;
 *    a layout qualifies only within FUNK_THERMAL_TOL of it (the model's uncertainty).
 * 2. Shapes. Each qualifying layout (up to four) is tried under organic shells: pebbles of three
 *    roundnesses, upright and leaning; the shrinkwrap at high smoothness; a faceted wedge.
 * 3. Look. Each shape is scored from its own mesh (a heuristic, stated so it can be argued with):
 *      curved   share of the surface whose normal is more than 10° from every axis  (35 %)
 *      round    sphericity π^⅓(6V)^⅔/A against the same layout in a straight box     (25 %)
 *      calm     volume against its convex hull (lumps and dents score low)             (20 %)
 *      ratio    outer proportions against the golden ratio φ                          (20 %)
 * 4. Check. The best few, one per layout-and-shell family, are simulated in 3D with their shell
 *    against the thermal-best layout in a straight box; a pick more than FUNK_CFD_TOL K behind on
 *    the tightest part is dropped.
 * Finishes and perforation styles are dealt out for variety; they do not change the score.
 */

export const FUNK_THERMAL_TOL = 0.03;
export const FUNK_CFD_TOL = 1.0;

export interface FunkLook {
  score: number;
  curved: number;
  round: number;
  calm: number;
  ratio: number;
}

export interface FunkPick {
  name: string;
  /** Preferences to apply (the rest of the configuration stays as it is). */
  prefs: Partial<Preferences>;
  designId: string;
  look: FunkLook;
  /** Tightest part in the airflow model: its share of budget left, and the floor's. */
  margin: number;
  floorMargin: number;
  headroomK: number;
  volumeL: number;
  world: { width: number; height: number; depth: number };
  /** 3D check: tightest part's headroom with this shell, and the thermal-best layout's in a box (K). */
  cfd?: { headroomK: number; refHeadroomK: number; kept: boolean };
}

export interface FunkResult {
  picks: FunkPick[];
  /** Layouts within the thermal tolerance, shapes tried, picks dropped by the 3D check. */
  stats: { layouts: number; shapes: number; dropped: number; floorMargin: number; floorHeadroomK: number };
}

/** The thermal-only search settings. */
export function funkBase(cfg: DesignConfig): DesignConfig {
  return {
    ...cfg,
    prefs: {
      ...cfg.prefs,
      airflowPriority: 1,
      maxWidth: 0,
      maxHeight: 0,
      maxDepth: 0,
      chambers: 'auto',
      allowTilt: true,
      flow: { ...ALL_FLOW },
      // Funkify's shapes are the shell: shrinkwrap mode (which overrides the shell) is off, and
      // its own 3D check replaces the shortlist's.
      mold: false,
      rank3D: false,
    },
  };
}

const SHAPES: { name: string; prefs: Partial<Preferences> }[] = [
  { name: 'Pebble', prefs: { shell: 'pebble', sculpt: { cut: 0.7, slope: 0, round: 0.55 } } },
  { name: 'River stone', prefs: { shell: 'pebble', sculpt: { cut: 0.7, slope: 0, round: 0.8 } } },
  { name: 'Drop', prefs: { shell: 'pebble', sculpt: { cut: 0.7, slope: 0, round: 1 } } },
  { name: 'Leaning stone', prefs: { shell: 'pebble', sculpt: { cut: 0.7, slope: 25, round: 0.5 } } },
  { name: 'Wave', prefs: { shell: 'pebble', sculpt: { cut: 0.7, slope: 30, round: 0.85 } } },
  { name: 'Cocoon', prefs: { shell: 'wrap', organic: 0.8 } },
  { name: 'Chrysalis', prefs: { shell: 'wrap', organic: 1 } },
  { name: 'Shard', prefs: { shell: 'facet', sculpt: { cut: 1, slope: 25, round: 0.6 } } },
];

const DRESS: { finish: string; ventStyleId: string }[] = [
  { finish: '#e9e6df', ventStyleId: 'hex' },
  { finish: '#3b4a3f', ventStyleId: 'fine' },
  { finish: '#23395b', ventStyleId: 'slots' },
  { finish: '#c9ccd1', ventStyleId: 'round' },
  { finish: '#5b2f2f', ventStyleId: 'hex' },
  { finish: '#2b2d31', ventStyleId: 'slots' },
];

const PHI = (1 + Math.sqrt(5)) / 2;

/** Directions on a cube grid (for the hull's support planes). */
function directions(k: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= k; i++)
    for (let j = 0; j <= k; j++)
      for (let l = 0; l <= k; l++) {
        if (i !== 0 && i !== k && j !== 0 && j !== k && l !== 0 && l !== k) continue;
        const v: Vec3 = [(2 * i) / k - 1, (2 * j) / k - 1, (2 * l) / k - 1];
        const n = Math.hypot(...v);
        out.push([v[0] / n, v[1] / n, v[2] / n]);
      }
  return out;
}

/** Look score of a shell mesh (see the module comment); `boxSphericity` is the same layout's straight box. */
export function lookOf(m: ShellMesh, boxSphericity: number): FunkLook {
  const P = m.positions;
  const I = m.indices;
  let area = 0;
  let curvedArea = 0;
  const cos10 = Math.cos((10 * Math.PI) / 180);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t];
    const b = 3 * I[t + 1];
    const c = 3 * I[t + 2];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l === 0) continue;
    area += l / 2;
    if (Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) / l < cos10) curvedArea += l / 2;
  }
  const V = m.volumeMm3;
  const sph = (Math.cbrt(Math.PI) * Math.pow(6 * V, 2 / 3)) / Math.max(1, area);
  // Convex hull volume from 98 support planes, on a coarse lattice.
  const dirs = directions(4);
  const h = dirs.map((d) => {
    let s = -Infinity;
    for (let i = 0; i < P.length; i += 3) s = Math.max(s, d[0] * P[i] + d[1] * P[i + 1] + d[2] * P[i + 2]);
    return s;
  });
  const lo = m.bbox.min;
  const hi = m.bbox.max;
  const step = Math.max(4, Math.cbrt(((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])) / 60000));
  let inside = 0;
  for (let x = lo[0] + step / 2; x < hi[0]; x += step)
    for (let y = lo[1] + step / 2; y < hi[1]; y += step)
      for (let z = lo[2] + step / 2; z < hi[2]; z += step) {
        let ok = true;
        for (let k = 0; k < dirs.length && ok; k++) if (dirs[k][0] * x + dirs[k][1] * y + dirs[k][2] * z > h[k]) ok = false;
        if (ok) inside++;
      }
  const hull = inside * step ** 3;
  const calmRaw = hull > 0 ? V / hull : 1;
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort((a, b) => b - a);
  const prop = (r: number) => Math.exp(-2 * Math.log(r / PHI) ** 2);
  const curved = area > 0 ? curvedArea / area : 0;
  const round = Math.max(0, Math.min(1, (sph / Math.max(0.1, boxSphericity) - 0.95) / 0.25));
  const calm = Math.max(0, Math.min(1, (calmRaw - 0.75) / 0.25));
  const ratio = (prop(size[0] / Math.max(1, size[1])) + prop(size[1] / Math.max(1, size[2]))) / 2;
  return { score: 0.35 * curved + 0.25 * round + 0.2 * calm + 0.2 * ratio, curved, round, calm, ratio };
}

const sphericityOf = (m: ShellMesh) => {
  let area = 0;
  const P = m.positions;
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t];
    const b = 3 * I[t + 1];
    const c = 3 * I[t + 2];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return (Math.cbrt(Math.PI) * Math.pow(6 * m.volumeMm3, 2 / 3)) / Math.max(1, area);
};

/** Signature for "same layout" (layout family, size class). */
const layoutKey = (d: Design) => `${d.effectiveTopology}|${Math.round(d.world.width / 10)}|${Math.round(d.world.height / 10)}|${Math.round(d.world.depth / 10)}`;

export function funkify(cfg: DesignConfig, opts: { picks?: number; check3d?: boolean; progress?: (done: number, total: number, label: string) => void } = {}): FunkResult {
  const nPicks = opts.picks ?? 4;
  const base = funkBase(cfg);
  opts.progress?.(0, 1, 'Searching for the coolest layouts');
  const res = solve(base, { wrapMetrics: false, onProgress: (done, total) => opts.progress?.(done, total, 'Searching for the coolest layouts') });
  const valid = res.space.filter((d) => !d.invalid);
  const pool = valid.length ? valid : res.space;
  const floor = pool.reduce((m, d) => Math.max(m, d.flow.worstMargin), -Infinity);
  const thermalBest = pool.find((d) => d.flow.worstMargin === floor)!;
  // Qualifying layouts, coolest first, one per layout family and size.
  const seen = new Set<string>();
  const layouts = [...pool]
    .filter((d) => d.flow.worstMargin >= floor - FUNK_THERMAL_TOL)
    .sort((a, b) => b.flow.worstMargin - a.flow.worstMargin)
    .filter((d) => {
      const k = layoutKey(d);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4);
  const total = layouts.length * SHAPES.length + (opts.check3d === false ? 0 : nPicks * 2 + 1);
  let done = 0;
  const scored: { design: Design; shape: (typeof SHAPES)[number]; look: FunkLook; mesh: ShellMesh }[] = [];
  for (const d of layouts) {
    const boxSph = sphericityOf(meshShell(d, { ...base, prefs: { ...base.prefs, shell: 'box' } }, 0, 0, 0.4));
    for (const s of SHAPES) {
      opts.progress?.(++done, total, `Shaping ${s.name.toLowerCase()} around layout ${layouts.indexOf(d) + 1}`);
      const c = { ...base, prefs: { ...base.prefs, ...s.prefs } };
      const m = meshShell(d, c, c.prefs.organic ?? 0, 0, 0.4);
      scored.push({ design: d, shape: s, look: lookOf(m, boxSph), mesh: m });
    }
  }
  scored.sort((a, b) => b.look.score - a.look.score);
  // Best first, for variety: no shape twice on a layout, at most two picks per shape and per layout.
  const chosen: typeof scored = [];
  const count = (k: string, m: Map<string, number>) => m.get(k) ?? 0;
  const perShape = new Map<string, number>();
  const perLayout = new Map<string, number>();
  for (let pass = 0; pass < 2 && chosen.length < nPicks * 2; pass++)
    for (const s of scored) {
      if (chosen.length >= nPicks * 2) break;
      if (chosen.includes(s)) continue;
      // First pass keeps the variety rules; a second fills up if too few layouts or shapes qualify.
      if (pass === 0 && (count(s.shape.name, perShape) >= 2 || count(s.design.id, perLayout) >= 2)) continue;
      perShape.set(s.shape.name, count(s.shape.name, perShape) + 1);
      perLayout.set(s.design.id, count(s.design.id, perLayout) + 1);
      chosen.push(s);
    }
  let ref: number | undefined;
  if (opts.check3d !== false) {
    opts.progress?.(++done, total, 'Simulating the thermal-best layout in a straight box');
    ref = simulateSteady(thermalBest, { ...base, prefs: { ...base.prefs, shell: 'box' } }, NO_SHAPING, { cells: 12000 }).thermal.worstHeadroomK;
  }
  const picks: FunkPick[] = [];
  let dropped = 0;
  for (const s of chosen) {
    if (picks.length >= nPicks) break;
    const dress = DRESS[picks.length % DRESS.length];
    const prefs: Partial<Preferences> = { ...s.shape.prefs, ...dress, airflowPriority: 1, maxWidth: 0, maxHeight: 0, maxDepth: 0, chambers: 'auto', allowTilt: true, flow: { ...ALL_FLOW } };
    let cfd: FunkPick['cfd'];
    if (ref !== undefined) {
      opts.progress?.(++done, total, `Checking ${s.shape.name.toLowerCase()} in 3D`);
      const c = { ...base, prefs: { ...base.prefs, ...prefs } };
      const k = simulateSteady(s.design, c, NO_SHAPING, { cells: 12000 }).thermal.worstHeadroomK;
      cfd = { headroomK: k, refHeadroomK: ref, kept: k >= ref - FUNK_CFD_TOL };
      if (!cfd.kept) {
        dropped++;
        continue;
      }
    }
    const size = [s.mesh.bbox.max[0] - s.mesh.bbox.min[0], s.mesh.bbox.max[1] - s.mesh.bbox.min[1], s.mesh.bbox.max[2] - s.mesh.bbox.min[2]];
    const world = cfg.prefs.orientation === 'tower' ? { width: size[2], height: size[1], depth: size[0] } : { width: size[1], height: size[2], depth: size[0] };
    picks.push({
      name: `${s.shape.name}${FINISHES.find((f) => f.id === dress.finish) ? ` in ${FINISHES.find((f) => f.id === dress.finish)!.label.toLowerCase()}` : ''}`,
      prefs,
      designId: s.design.id,
      look: s.look,
      margin: s.design.flow.worstMargin,
      floorMargin: floor,
      headroomK: s.design.flow.worstHeadroomK,
      volumeL: s.mesh.volumeMm3 / 1e6,
      world,
      cfd,
    });
  }
  return { picks, stats: { layouts: layouts.length, shapes: scored.length, dropped, floorMargin: floor, floorHeadroomK: thermalBest.flow.worstHeadroomK } };
}
