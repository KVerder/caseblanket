import type { FanSpec } from '../model/types';
import { perforatedPlateZeta, type LossTerm, type NetworkInput } from './airflow';
import type { Dir, Vec3 } from './geometry';

/**
 * Flow structures: shapes inside and on the case that guide the air, switched on in the Flow tab.
 * Each one changes loss terms in the airflow network (estimates, listed below), is printed where
 * it is built (see printable.ts), and is in the 3D simulation where its size allows (ducts and
 * deflectors; rings, cones and hole chamfers are below its ~1 cm grid and act there through the
 * same loss coefficients only where they are porous layers: the vent holes).
 *
 * Coefficients (textbook-style values from memory, not from pages opened in this project):
 *   Rounded vent-hole entries: a sharp-edged perforated plate loses (0.707·(1−φ)^0.375 + 1 − φ)²/φ²
 *     (Idelchik); rounding the entry removes the vena contracta, leaving about (1 − φ)²/φ² + 0.05.
 *     A chamfer of r = HOLE_ROUND on holes of diameter d gets a share min(1, (r/d)/0.15) of that.
 *   Bell-mouth fan inlets: entry loss K 0.5 (sharp) falling with lip radius r/D, table below.
 *   Exit diffusers: 6° half-angle cone in the fan-to-panel gap, recovery 0.7 × (1 − 1/AR²).
 *   Ducts: the fan-to-vent gap closed by four plates: no proximity loss (the air cannot spill
 *     round the fan), K 0.1 for the short straight duct.
 *   Radiused turns: the frame of a tilted part gets a curved fairing where the air turns from the
 *     panel into the fans: the sharp turn (Weisbach) becomes a smooth bend, K × 0.3.
 *   Deeper plenums: 20 mm more behind every radiator and case fan (real space in the layout).
 *   Exhaust deflectors: louvres throwing exhaust away from the intakes: 3D simulation only (they
 *     change where warm air goes, which the 1D model does not track) and not printed yet.
 */

export interface FlowPrefs {
  ducts: boolean;
  bellMouths: boolean;
  diffusers: boolean;
  roundedHoles: boolean;
  radiusedTurns: boolean;
  deepPlenums: boolean;
  deflectors: boolean;
}

export type FlowKey = keyof FlowPrefs;

export const NO_FLOW: FlowPrefs = { ducts: false, bellMouths: false, diffusers: false, roundedHoles: false, radiusedTurns: false, deepPlenums: false, deflectors: false };
export const ALL_FLOW: FlowPrefs = { ducts: true, bellMouths: true, diffusers: true, roundedHoles: true, radiusedTurns: true, deepPlenums: true, deflectors: true };

export const FLOW_ELEMENTS: { key: FlowKey; label: string; what: string; where: string }[] = [
  { key: 'ducts', label: 'Ducts', what: 'Close the gap between each fan and its vent with four plates, so the fan only breathes through the vent.', where: '1D, 3D, printed' },
  { key: 'bellMouths', label: 'Bell-mouth inlets', what: 'A rounded lip leading air from the panel into each intake fan that has a gap to its vent.', where: '1D, printed (below the 3D grid)' },
  { key: 'diffusers', label: 'Exit diffusers', what: 'A gentle cone from each exhaust fan to its panel, turning speed back into pressure.', where: '1D, printed (below the 3D grid)' },
  { key: 'roundedHoles', label: 'Rounded vent holes', what: 'Chamfer the entry edge of every vent hole, so the air does not contract through it.', where: '1D, 3D, printed' },
  { key: 'radiusedTurns', label: 'Radiused turns', what: 'A curved fairing in the frame of each tilted radiator or fan, where the air turns from the panel into the fans.', where: '1D, printed (below the 3D grid)' },
  { key: 'deepPlenums', label: 'Deeper plenums', what: '20 mm more air behind every radiator and case fan, so it spreads over the whole core.', where: '1D, 3D, layout' },
  { key: 'deflectors', label: 'Exhaust deflectors', what: 'Louvres throwing exhaust away from the intakes.', where: '3D only, not printed yet' },
];

/** Chamfer on the entry edge of a rounded vent hole, mm. */
export const HOLE_ROUND = 0.6;
export const DUCT_ZETA = 0.1;
/** Smallest fan-to-panel gap a bell-mouth or a diffuser is built in, mm. */
export const MIN_GAP_BELL = 4;
export const MIN_GAP_DIFFUSER = 6;
export const DIFFUSER_HALF_ANGLE = (6 * Math.PI) / 180;
/** Plenum behind radiators and case fans, extra, mm. */
export const DEEP_PLENUM = 20;

/** Perforated plate with rounded hole entries (r/d), see above. */
export function roundedPlateZeta(openRatio: number, rOverD: number): number {
  const f = Math.min(0.95, Math.max(0.05, openRatio));
  const sharp = perforatedPlateZeta(f);
  const round = (1 - f) ** 2 / (f * f) + 0.05;
  const g = Math.min(1, Math.max(0, rOverD / 0.15));
  return sharp + (round - sharp) * g;
}

/** Entry loss of a bell-mouth inlet with lip radius r on a fan of diameter D (r/D), K on the fan area. */
export function bellMouthZeta(rOverD: number): number {
  const t: [number, number][] = [
    [0, 0.5],
    [0.02, 0.28],
    [0.04, 0.18],
    [0.06, 0.12],
    [0.1, 0.07],
    [0.15, 0.04],
  ];
  if (rOverD >= 0.15) return 0.04;
  for (let i = 1; i < t.length; i++)
    if (rOverD <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((y1 - y0) * (rOverD - x0)) / (x1 - x0);
    }
  return 0.04;
}

/** Pressure recovered by a conical diffuser, as a share of the inlet velocity head. */
export const coneRecovery = (areaRatio: number, efficiency = 0.7) => efficiency * (1 - 1 / (areaRatio * areaRatio));

/** A fan that faces a panel: what the flow structures need to know about it. */
export interface FlowFan {
  /** Fan group id in the airflow network. */
  id: string;
  fan: FanSpec;
  count: number;
  /** Gap between the fan face and the panel, mm. */
  gap: number;
  atWall: boolean;
  tilted: boolean;
  /** A duct can close its gap (a wall-facing part with a gap, not tilted, not through-flow). */
  ductable: boolean;
  /** Fan discs facing the panel, for bell-mouths and diffusers: centre on the fan face, panel side. */
  discs: { centre: Vec3; wall: Dir; radius: number }[];
}

const VENT_LABELS = new Set(['vent', 'intake vent', 'far vent']);

/** Lip radius of a bell-mouth that fits a fan's gap, mm (0: none). */
export const bellLip = (f: FlowFan) => (f.atWall && !f.tilted && f.gap >= MIN_GAP_BELL && f.discs.length ? Math.min(0.15 * f.fan.size, f.gap) : 0);
/** Area ratio of a diffuser in a fan's gap (0: none). */
export function diffuserRatio(f: FlowFan): number {
  if (!f.atWall || f.tilted || f.gap < MIN_GAP_DIFFUSER || !f.discs.length) return 0;
  const R = f.fan.size / 2;
  return ((R + f.gap * Math.tan(DIFFUSER_HALF_ANGLE)) / R) ** 2;
}

/**
 * The network with the flow structures applied: loss terms changed per fan group (by label) and
 * the passive vents' coefficient, from the vents' open ratio. Recovered pressure never cuts a
 * group's resistance below half (as for the estimated structures).
 */
export function applyFlow(net: NetworkInput, prefs: Partial<FlowPrefs> | undefined, fans: FlowFan[], openRatio: number, holeD: number): NetworkInput {
  if (!prefs) return net;
  const p = { ...NO_FLOW, ...prefs };
  const rOverD = HOLE_ROUND / Math.max(1, holeD);
  const dVent = (phi: number) => (p.roundedHoles ? roundedPlateZeta(phi, rOverD) - perforatedPlateZeta(phi) : 0);
  const byId = new Map(fans.map((f) => [f.id, f]));
  const MM2 = 1e-6;
  const groups = net.groups.map((g) => {
    const f = byId.get(g.id);
    let losses: LossTerm[] = g.losses.map((l) => {
      if (VENT_LABELS.has(l.label)) return { ...l, zeta: l.zeta + dVent(openRatio) };
      if (l.label === 'AC-end grille') return { ...l, zeta: l.zeta + dVent(0.6) };
      if (p.ducts && f?.ductable && l.label === 'fan proximity') return { ...l, zeta: 0 };
      if (p.radiusedTurns && l.label === 'tilt turn') return { ...l, zeta: l.zeta * 0.3 };
      return l;
    });
    if (!f) return { ...g, losses };
    const fanArea = f.count * f.fan.size * f.fan.size * MM2;
    const extra: LossTerm[] = [];
    if (p.ducts && f.ductable) extra.push({ label: 'duct', zeta: DUCT_ZETA, area: fanArea });
    const lip = bellLip(f);
    if (p.bellMouths && lip > 0 && g.source === 'outside') extra.push({ label: 'bell-mouth', zeta: -(0.5 - bellMouthZeta(lip / f.fan.size)), area: fanArea });
    const ar = diffuserRatio(f);
    if (p.diffusers && ar > 0 && g.sink === 'outside') extra.push({ label: 'diffuser', zeta: -coneRecovery(ar), area: fanArea });
    if (extra.length) {
      const res = (ls: LossTerm[]) => ls.reduce((s, l) => s + (l.area > 0 ? l.zeta / (l.area * l.area) : 0), 0);
      const r0 = res(losses);
      let next = [...losses, ...extra];
      const r1 = res(next);
      if (r1 < 0.5 * r0) {
        const neg = res(extra.filter((l) => l.zeta < 0));
        const k = neg < 0 ? Math.max(0, (0.5 * r0 - (r1 - neg)) / neg) : 1;
        next = [...losses, ...extra.map((l) => (l.zeta < 0 ? { ...l, zeta: l.zeta * k } : l))];
      }
      losses = next;
    }
    return { ...g, losses };
  });
  const zones = net.zones.map((z) => ({ ...z, passiveZeta: z.passiveZeta + dVent(openRatio) }));
  return { ...net, groups, zones };
}

// ------------------------------------------------------------------ printed geometry

/** Wall of a printed flow structure, mm. */
export const FLOW_WALL = 1.6;

/** A printed flow structure as a signed distance (negative inside) with a bounding box. */
export interface FlowSolid {
  label: string;
  sdf: (p: Vec3) => number;
  min: Vec3;
  max: Vec3;
}

/**
 * Bell-mouths and diffusers, in the gap between a fan and its panel. `s` is the distance from the
 * panel's inner surface toward the fan, ρ the distance from the fan's axis.
 *   bell-mouth  a quarter-round lip of radius r from ρ = R + r at the panel to ρ = R at s = r,
 *               then straight to the fan
 *   diffuser    a 6° cone from ρ = R at the fan out to the panel
 * Both a FLOW_WALL thick skin just outside that surface.
 */
export function fanRings(fans: FlowFan[], prefs: Partial<FlowPrefs> | undefined, interior: Vec3, groupSink: (id: string) => 'in' | 'out' | null): FlowSolid[] {
  const p = { ...NO_FLOW, ...prefs };
  const out: FlowSolid[] = [];
  for (const f of fans) {
    const dir = groupSink(f.id);
    const lip = bellLip(f);
    const ar = diffuserRatio(f);
    const bell = p.bellMouths && lip > 0 && dir === 'in';
    const cone = p.diffusers && ar > 0 && dir === 'out';
    if (!bell && !cone) continue;
    for (const d of f.discs) {
      const a = d.wall >> 1;
      const sign = d.wall & 1 ? -1 : 1;
      const panel = sign > 0 ? interior[a] : 0;
      const R = d.radius;
      const gap = f.gap;
      const surface = (s: number) => {
        if (bell) return s < lip ? R + lip - Math.sqrt(Math.max(0, lip * lip - (lip - s) ** 2)) : R;
        return R + (gap - s) * Math.tan(DIFFUSER_HALF_ANGLE);
      };
      const sdf = (q: Vec3) => {
        const s = sign > 0 ? panel - q[a] : q[a] - panel;
        let r2 = 0;
        for (let k = 0; k < 3; k++) if (k !== a) r2 += (q[k] - d.centre[k]) ** 2;
        const rho = Math.sqrt(r2);
        const ring = Math.abs(rho - surface(Math.max(0, Math.min(gap, s))) - FLOW_WALL / 2) - FLOW_WALL / 2;
        // From well past the panel plane (the shell may sit further out; the print clips it at the
        // wall's mid-plane, so it fuses wherever the wall is) to the fan face.
        return Math.max(ring, -s - 40, s - gap);
      };
      const reach = R + (bell ? lip : gap * Math.tan(DIFFUSER_HALF_ANGLE)) + FLOW_WALL + 1;
      const min: Vec3 = [d.centre[0] - reach, d.centre[1] - reach, d.centre[2] - reach];
      const max: Vec3 = [d.centre[0] + reach, d.centre[1] + reach, d.centre[2] + reach];
      min[a] = sign > 0 ? panel - gap - 1 : panel - 40;
      max[a] = sign > 0 ? panel + 40 : panel + gap + 1;
      out.push({ label: `${bell ? 'bell-mouth' : 'diffuser'} ${f.id}`, sdf, min, max });
    }
  }
  return out;
}
