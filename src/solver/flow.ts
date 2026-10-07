import type { FanSpec } from '../model/types';
import { type LossTerm, type NetworkInput } from './airflow';
import { hydraulicDiameter, type Perforation } from '../model/perforation';
import type { Dir, Vec3 } from './geometry';

/**
 * Flow structures: shapes inside and on the case that guide the air, switched on in the Flow tab.
 * Each one changes loss terms in the airflow network (estimates, listed below), is printed where
 * it is built (see printable.ts), and is in the 3D simulation where its size allows (ducts and
 * deflectors; rings, cones and hole chamfers are below its ~1 cm grid and act there through the
 * same loss coefficients only where they are porous layers: the vent holes).
 *
 * Coefficients (textbook values from memory of Idelchik's Handbook of Hydraulic Resistance and the
 * usual rounded-entrance tables, not from pages opened in this project):
 *   Vent panels: Idelchik's thick perforated plate, ζ = [ζ'(1−φ)^0.75 + τ(l/d)(1−φ)^1.375 + (1−φ)²
 *     + λl/d]/φ² (see plateZeta): a 2.4 mm wall on 4–6 mm holes loses 10–20 % less than a thin plate.
 *   Rounded vent-hole entries: the hole entry ζ' falls from 0.5 (sharp) with r/d (entryZeta) and the
 *     contraction term goes with it; the printed 45° chamfer of HOLE_ROUND counts as half that radius.
 *   Bell-mouth fan inlets: entry loss K 0.5 (sharp) falling with lip radius r/D (same table). The
 *     fan's rated curve already includes its own frame inlet, so a bell-mouth only wins back the
 *     proximity loss of a cramped gap, never more.
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

/**
 * Idelchik's entrance coefficient ζ' for an inlet edge rounded to r/d, flush with a wall
 * (Idelchik, Handbook of Hydraulic Resistance, rounded-inlet table; the same values appear in
 * the usual "rounded entrance" tables: 0.5 sharp, ~0.2 at r/d 0.05, 0.03 from r/d 0.2).
 * Values from memory of those tables, not re-checked against a page in this project.
 */
const ENTRY_ROUND: [number, number][] = [
  [0, 0.5],
  [0.01, 0.44],
  [0.02, 0.37],
  [0.03, 0.31],
  [0.04, 0.26],
  [0.05, 0.22],
  [0.06, 0.19],
  [0.08, 0.15],
  [0.12, 0.09],
  [0.16, 0.06],
  [0.2, 0.03],
];
function lerpTable(t: [number, number][], x: number): number {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++)
    if (x <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  return t[t.length - 1][1];
}
export const entryZeta = (rOverD: number) => lerpTable(ENTRY_ROUND, Math.max(0, rOverD));

/**
 * Idelchik's τ for a perforated plate of thickness l on holes of hydraulic diameter d: the jet
 * that contracts at a sharp hole edge partly re-attaches inside a thick plate (τ 1.35 for a thin
 * plate, falling to ~0.02 at l/d 2). From memory of the "thickened plate" diagram; unverified.
 */
const TAU: [number, number][] = [
  [0, 1.35],
  [0.2, 1.22],
  [0.4, 1.1],
  [0.6, 0.84],
  [0.8, 0.42],
  [1, 0.24],
  [1.4, 0.1],
  [2, 0.02],
];
export const plateTau = (lOverD: number) => lerpTable(TAU, Math.max(0, lOverD));

/** Effective edge radius of a 45° chamfer of leg c: half of it (a judgement, see ventZeta). */
export const CHAMFER_AS_RADIUS = 0.5;

/**
 * Loss of a perforated vent panel on its approach (gross) velocity, Idelchik's form
 *   ζ = [ζ'·(1−φ)^0.75 + τ'·(1−φ)^1.375 + (1−φ)² + λ·l/d] / φ²
 * with ζ' the hole entry (0.5 sharp, falling with r/d) and τ' = τ(l/d)·(ζ' − 0.03)/0.47 (the contraction
 * term goes as the edge is rounded; the two ends are Idelchik's sharp thick-plate and rounded-hole
 * formulas). λ = 0.02. A thin sharp plate (l/d → 0) gives back perforatedPlateZeta within 3 %.
 * A 45° chamfer of leg c counts as a radius CHAMFER_AS_RADIUS·c: bevelled-inlet data put a short
 * 45–60° bevel roughly half way between sharp and the same-size radius (judgement, unverified).
 */
export function plateZeta(openRatio: number, lOverD: number, rOverD = 0): number {
  const f = Math.min(0.95, Math.max(0.05, openRatio));
  const e = entryZeta(rOverD);
  const tau = plateTau(lOverD) * Math.max(0, (e - 0.03) / (0.5 - 0.03));
  return (e * (1 - f) ** 0.75 + tau * (1 - f) ** 1.375 + (1 - f) ** 2 + 0.02 * lOverD) / (f * f);
}

/** The vent panel's loss for a perforation style, wall thickness and (optional) chamfered hole entries. */
export function ventZeta(openRatio: number, p: Perforation, wall: number, rounded: boolean): number {
  const d = hydraulicDiameter(p);
  return plateZeta(openRatio, wall / d, rounded ? (CHAMFER_AS_RADIUS * HOLE_ROUND) / d : 0);
}

/** Perforated plate with rounded hole entries (r/d), as a thin plate (kept for the AC-end grille and old callers). */
export function roundedPlateZeta(openRatio: number, rOverD: number): number {
  return plateZeta(openRatio, 0, rOverD);
}

/** Entry loss of a bell-mouth inlet with lip radius r on a fan of diameter D (r/D), K on the fan area. */
export const bellMouthZeta = (rOverD: number) => entryZeta(rOverD);

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
export function applyFlow(net: NetworkInput, prefs: Partial<FlowPrefs> | undefined, fans: FlowFan[], openRatio: number, holeD: number, lOverD = 0): NetworkInput {
  if (!prefs) return net;
  const p = { ...NO_FLOW, ...prefs };
  const rOverD = (CHAMFER_AS_RADIUS * HOLE_ROUND) / Math.max(1, holeD);
  const dVent = (phi: number, l = lOverD) => (p.roundedHoles ? plateZeta(phi, l, rOverD) - plateZeta(phi, l, 0) : 0);
  const byId = new Map(fans.map((f) => [f.id, f]));
  const MM2 = 1e-6;
  const groups = net.groups.map((g) => {
    const f = byId.get(g.id);
    let losses: LossTerm[] = g.losses.map((l) => {
      if (VENT_LABELS.has(l.label)) return { ...l, zeta: l.zeta + dVent(openRatio) };
      if (l.label === 'AC-end grille') return { ...l, zeta: l.zeta + dVent(0.6, 0) };
      if (p.ducts && f?.ductable && l.label === 'fan proximity') return { ...l, zeta: 0 };
      if (p.radiusedTurns && l.label === 'tilt turn') return { ...l, zeta: l.zeta * 0.3 };
      return l;
    });
    if (!f) return { ...g, losses };
    const fanArea = f.count * f.fan.size * f.fan.size * MM2;
    const extra: LossTerm[] = [];
    if (p.ducts && f.ductable) extra.push({ label: 'duct', zeta: DUCT_ZETA, area: fanArea });
    const lip = bellLip(f);
    // A fan's rated curve already includes its own frame inlet (rated on a plenum chamber), so a
    // bell-mouth can only win back the extra loss of breathing through a cramped gap: at most the
    // proximity loss charged, and at most what rounding the entry saves (0.5 → ζ'(r/D)).
    const prox = g.losses.find((l) => l.label === 'fan proximity');
    const proxZ = prox && prox.area > 0 ? prox.zeta * (fanArea / prox.area) ** 2 : 0;
    const bellGain = Math.min(0.5 - bellMouthZeta(lip / f.fan.size), proxZ);
    if (p.bellMouths && lip > 0 && g.source === 'outside' && bellGain > 0) extra.push({ label: 'bell-mouth', zeta: -bellGain, area: fanArea });
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
