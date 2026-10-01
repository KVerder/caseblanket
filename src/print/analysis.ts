import { MATERIALS, PRINT_HDT_MARGIN, type Material } from '../model/presets';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Box, type Dir, type Vec3 } from '../solver/geometry';
import type { ShellMesh } from '../solver/shrinkwrap';

/** Slicer assumptions for mass and time (typical FDM defaults; estimate, editable). */
export interface SlicerSettings {
  layerMm: number;
  walls: number;
  lineMm: number;
  infill: number;
  speedMmS: number;
}

export const DEFAULT_SLICER: SlicerSettings = { layerMm: 0.2, walls: 3, lineMm: 0.42, infill: 0.15, speedMmS: 100 };

/** Overhangs steeper than this from vertical need support. */
export const OVERHANG_DEG = 45;
/** Sparse support density (share of the supported volume printed). */
const SUPPORT_DENSITY = 0.15;
/** Travel, retraction and acceleration overhead on the pure extrusion time (estimate). */
const TIME_OVERHEAD = 1.35;

const DIR_LABEL = ['+u', '−u', '+v', '−v', '+t', '−t'];

export interface Orientation {
  /** Solver direction that points up on the bed. */
  up: Dir;
  overhangMm2: number;
  supportMm3: number;
  heightMm: number;
}

/**
 * Best of the six axis-aligned orientations: the one needing the least support, then the lowest.
 * A triangle needs support when it faces down more steeply than OVERHANG_DEG from vertical and
 * isn't on the bed; its support column runs from the bed to the triangle.
 */
export function orientPiece(mesh: ShellMesh): Orientation {
  const P = mesh.positions;
  const I = mesh.indices;
  const cos = Math.cos((OVERHANG_DEG * Math.PI) / 180);
  let best: Orientation | null = null;
  for (let up = 0 as Dir; up < 6; up = (up + 1) as Dir) {
    const a = axisOf(up);
    const sg = signOf(up);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < P.length; i += 3) {
      const h = sg * P[i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    let overhang = 0;
    let support = 0;
    for (let t = 0; t < I.length; t += 3) {
      const ia = 3 * I[t];
      const ib = 3 * I[t + 1];
      const ic = 3 * I[t + 2];
      const ux = P[ib] - P[ia];
      const uy = P[ib + 1] - P[ia + 1];
      const uz = P[ib + 2] - P[ia + 2];
      const vx = P[ic] - P[ia];
      const vy = P[ic + 1] - P[ia + 1];
      const vz = P[ic + 2] - P[ia + 2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const area2 = Math.hypot(n[0], n[1], n[2]);
      if (area2 < 1e-12) continue;
      const down = (-sg * n[a]) / area2; // cosine between the outward normal and straight down
      if (down <= cos) continue;
      const h = (sg * (P[ia + a] + P[ib + a] + P[ic + a])) / 3 - lo;
      if (h < 0.6) continue; // on the bed
      const projected = (area2 / 2) * down;
      overhang += area2 / 2;
      support += projected * h;
    }
    const o: Orientation = { up, overhangMm2: overhang, supportMm3: support, heightMm: hi - lo };
    if (!best || o.supportMm3 < best.supportMm3 - 1 || (Math.abs(o.supportMm3 - best.supportMm3) <= 1 && o.heightMm < best.heightMm)) best = o;
  }
  return best!;
}

export const orientationLabel = (cfg: DesignConfig, up: Dir) => {
  // Solver → world: tower x = −t, y = v, z = u; console x = v, y = t, z = u.
  const tower = cfg.prefs.orientation === 'tower';
  const names: Record<string, string> = tower
    ? { '+u': 'front face up', '−u': 'back face up', '+v': 'top up (as it stands)', '−v': 'upside down', '+t': 'left side up', '−t': 'right side up' }
    : { '+u': 'front face up', '−u': 'back face up', '+v': 'right side up', '−v': 'left side up', '+t': 'top up (as it stands)', '−t': 'upside down' };
  return names[DIR_LABEL[up]];
};

/** Filament mass (g) and print time (min) of a piece: perimeters solid, the rest at infill, plus sparse support. */
export function pieceCost(mesh: ShellMesh, supportMm3: number, mat: Material, s: SlicerSettings) {
  const shellPart = Math.min(mesh.volumeMm3, mesh.areaMm2 * s.walls * s.lineMm);
  const printed = shellPart + Math.max(0, mesh.volumeMm3 - shellPart) * s.infill + supportMm3 * SUPPORT_DENSITY;
  const massG = (printed * mat.densityGcm3) / 1000;
  const rate = s.speedMmS * s.lineMm * s.layerMm; // mm³/s
  const timeMin = ((printed / rate) * TIME_OVERHEAD) / 60;
  return { massG, timeMin, printedMm3: printed };
}

const boxesTouch = (a: Box, b: Box, pad = 0) => [0, 1, 2].every((k) => a.min[k] - pad <= b.max[k] && b.min[k] - pad <= a.max[k]);

/**
 * Hottest air a piece meets at sustained full load (°C): the air of every chamber it bounds, and the
 * exhaust of every fan group whose vent it carries.
 */
export function pieceAirC(design: Design, cfg: DesignConfig, box: Box): number {
  const f = design.thermal.full;
  let rise = Math.max(0, ...f.zones.map((z) => z.riseC));
  for (const v of design.vents) {
    if (v.flow !== 'out' || !v.groupId) continue;
    const a = axisOf(v.wall);
    const [xa, ya] = wallAxes(a);
    const at = signOf(v.wall) > 0 ? design.interior[a] : 0;
    const vb: Box = { min: [0, 0, 0], max: [0, 0, 0] };
    vb.min[a] = at - design.wall;
    vb.max[a] = at + design.wall;
    vb.min[xa] = v.rect.x0;
    vb.max[xa] = v.rect.x1;
    vb.min[ya] = v.rect.y0;
    vb.max[ya] = v.rect.y1;
    if (!boxesTouch(vb, box)) continue;
    const g = f.groups.find((x) => x.id === v.groupId || (v.groupId === 'gpu' && x.id === 'gpu-card'));
    if (g) rise = Math.max(rise, g.exitRiseC);
  }
  return cfg.prefs.ambientC + rise;
}

const PRINT_ORDER = ['pla', 'petg', 'asa', 'pc-fr', 'pa-cf'];

/**
 * Filament for a piece: the preferred one if its heat-deflection temperature clears the air by
 * PRINT_HDT_MARGIN, otherwise the next one up that does. PLA is never chosen above its own limit.
 */
export function chooseFilament(preferredId: string, airC: number): { mat: Material; upgraded: boolean } {
  const pref = MATERIALS.find((m) => m.id === preferredId && m.print) ?? MATERIALS.find((m) => m.id === 'petg')!;
  const ok = (m: Material) => !!m.print && m.print.hdtC - PRINT_HDT_MARGIN >= airC;
  if (ok(pref)) return { mat: pref, upgraded: false };
  for (const id of PRINT_ORDER.slice(PRINT_ORDER.indexOf(pref.id) + 1)) {
    const m = MATERIALS.find((x) => x.id === id)!;
    if (ok(m)) return { mat: m, upgraded: true };
  }
  return { mat: MATERIALS.find((x) => x.id === 'pa-cf')!, upgraded: true };
}

/** Within this distance of the PSU a printed piece should be flame-retardant (UL 94 V-0). */
export const PSU_FIRE_ZONE_MM = 30;

export function nearPsu(design: Design, box: Box): boolean {
  const psu = design.parts.find((p) => p.kind === 'psu');
  return !!psu && boxesTouch(psu.body, box, PSU_FIRE_ZONE_MM);
}

/** Threaded inserts and grounding points (M3 heat-set inserts; positions from the board and PSU outlines). */
export function insertPlan(design: Design, cfg: DesignConfig) {
  const out: { what: string; count: number; note: string }[] = [];
  const board = design.parts.find((p) => p.kind === 'board');
  if (board) {
    const ff = cfg.parts.board.formFactor;
    const n = ff === 'mini-itx' || ff === 'thin-mini-itx' ? 4 : ff === 'mini-dtx' ? 4 : ff === 'micro-atx' ? 8 : ff === 'atx' ? 9 : 4;
    out.push({ what: 'Motherboard standoffs', count: n, note: 'M3 brass heat-set inserts in printed bosses; tie them together to the PSU ground (the board grounds through its mounting holes).' });
  }
  out.push({ what: 'PSU mounting', count: 4, note: 'Inserts for the PSU’s #6-32 screws; run a ground lead from one to the board standoffs.' });
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  if (gpu && gpu.body.min[0] < 2) out.push({ what: 'GPU bracket', count: 1, note: 'Insert for the bracket screw at the rear I/O; ground it with the board.' });
  return out;
}

export type { Vec3 };

export interface ManifestRow {
  name: string;
  sizeMm: [number, number, number];
  orientation: string;
  supportCm3: number;
  airC: number;
  filament: string;
  upgraded: boolean;
  needsV0: boolean;
  massG: number;
  timeMin: number;
}

export interface Manifest {
  rows: ManifestRow[];
  totalMassG: number;
  totalTimeMin: number;
  totalSupportCm3: number;
  inserts: ReturnType<typeof insertPlan>;
  flags: string[];
}

/** Per-piece print plan: orientation, support, filament by temperature, flame rating, mass and time. */
export function buildManifest(design: Design, cfg: DesignConfig, pieces: { name: string; box: Box; mesh: ShellMesh }[], preferredId: string, s: SlicerSettings, liner: boolean): Manifest {
  const rows: ManifestRow[] = pieces.map((p) => {
    const o = orientPiece(p.mesh);
    const airC = pieceAirC(design, cfg, p.mesh.bbox);
    const { mat, upgraded } = chooseFilament(preferredId, airC);
    const cost = pieceCost(p.mesh, o.supportMm3, mat, s);
    const b = p.mesh.bbox;
    return {
      name: p.name,
      sizeMm: [0, 1, 2].map((a) => Math.round(b.max[a] - b.min[a])) as [number, number, number],
      orientation: orientationLabel(cfg, o.up),
      supportCm3: o.supportMm3 / 1000,
      airC,
      filament: mat.label.replace('3D print — ', ''),
      upgraded,
      needsV0: nearPsu(design, p.mesh.bbox) && mat.print?.ul94 !== 'V-0',
      massG: cost.massG,
      timeMin: cost.timeMin,
    };
  });
  const flags: string[] = [];
  const v0 = rows.filter((r) => r.needsV0);
  if (v0.length)
    flags.push(
      `${v0.map((r) => r.name).join(', ')} sit${v0.length === 1 ? 's' : ''} within ${PSU_FIRE_ZONE_MM} mm of the PSU and the chosen filament is not UL 94 V-0 (typical PETG, ASA and PLA grades are HB): print ${v0.length === 1 ? 'it' : 'them'} in a V-0 filament such as flame-retardant PC, or keep the PSU in its metal enclosure with a metal plate between it and the print.`,
    );
  const up = rows.filter((r) => r.upgraded);
  if (up.length) flags.push(`${up.map((r) => `${r.name} (${Math.round(r.airC)} °C air → ${r.filament})`).join(', ')}: hotter than the preferred filament allows with a ${PRINT_HDT_MARGIN} K margin below its heat-deflection temperature.`);
  flags.push(
    liner
      ? 'Conductive liner: line the inside with copper or aluminium tape (overlapping, bonded to the ground lug) or a nickel EMI paint; it is the only shielding a printed case has.'
      : 'A plastic shell provides no EMI shielding. Add a conductive liner (copper or aluminium tape, or nickel paint, bonded to ground) if that matters where the PC sits.',
  );
  return {
    rows,
    totalMassG: rows.reduce((a, r) => a + r.massG, 0),
    totalTimeMin: rows.reduce((a, r) => a + r.timeMin, 0),
    totalSupportCm3: rows.reduce((a, r) => a + r.supportCm3, 0),
    inserts: insertPlan(design, cfg),
    flags,
  };
}

export function manifestCsv(m: Manifest): string {
  const head = 'piece,size_mm,orientation,support_cm3,max_air_C,filament,needs_V0,mass_g,time_h';
  const rows = m.rows.map((r) =>
    [r.name, r.sizeMm.join('x'), `"${r.orientation}"`, r.supportCm3.toFixed(1), r.airC.toFixed(0), `"${r.filament}"`, r.needsV0 ? 'yes' : 'no', r.massG.toFixed(0), (r.timeMin / 60).toFixed(1)].join(','),
  );
  return [head, ...rows].join('\n') + '\n';
}
