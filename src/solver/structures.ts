import { MATERIALS } from '../model/presets';
import type { DesignConfig } from '../model/types';
import { DEFAULT_SLICER, pieceCost } from '../print/analysis';
import { fanLw, sumDb, ventLw, type NoiseSource } from './acoustics';
import { solveNetwork, type FlowResult, type LossTerm, type NetworkInput } from './airflow';
import type { Design, DesignRecipe } from './evaluate';
import { coolestWithin, noiseTotal, quietestSafe, type NoiseResult } from './fanspeeds';
import { axisOf } from './geometry';
import { STRUCTURE_MIN_GAIN } from '../cfd/run';

/**
 * Flow-shaping and silencing structures, round 2: estimated in the 1D network and noise model.
 *
 * Each structure changes loss coefficients (pressure lost or recovered in a fan's path) and/or the
 * sound power of a source. The fan speeds are then solved again exactly as for the design (same
 * noise budget or quiet mode), so a structure that lowers noise can show up as a cooler design
 * when the freed budget lets the fans speed up, and a structure that costs pressure can show up
 * as more noise. Every coefficient is an estimate (textbook-style values, not checked against
 * reference CFD or a prototype here), so these structures are listed with their trade-offs and
 * kept off the explorer frontier until a reference run or measurement confirms them.
 *
 * Estimates used (not from pages opened in this project; treat as starting values):
 *   Bell-mouth inlet: sharp-edged entry K ≈ 0.5 → rounded lip (r ≥ 0.15·D) K ≈ 0.05, on the fan area.
 *   Exit diffuser: conical, 6° half-angle, pressure-recovery efficiency 0.7 of the ideal
 *     1 − 1/AR² (area ratio AR), credited against the fan-exit velocity head.
 *   Fan-to-radiator plenum: the existing plenum loss (K = 1 on the plenum's side area).
 *   Expansion-chamber silencer: transmission loss of a simple expansion chamber,
 *     TL = 10·log10(1 + ¼(m − 1/m)²·sin²(kL)), averaged over frequency (sin² → ½); a fan radiates
 *     about half its sound through the vent side, so only that half is reduced. Pressure cost:
 *     sudden expansion (1 − 1/m)² plus contraction 0.5·(1 − 1/m), on the fan area.
 */

export type StructureKind = 'bell-mouth' | 'diffuser' | 'plenum' | 'silencer';

export interface StructureMod {
  /** Extra loss terms per fan group (negative ζ = pressure recovered). */
  losses?: Record<string, LossTerm[]>;
  /** Change a group's existing loss terms. */
  mapLoss?: (groupId: string, l: LossTerm) => LossTerm;
  /** Sound power change per source id, dB. */
  lwDelta?: Record<string, number>;
}

export interface StructureState {
  speeds: Record<string, number>;
  flow: FlowResult;
  noise: NoiseResult;
  feasible: boolean;
}

export interface StructureResult {
  id: string;
  kind: StructureKind;
  label: string;
  /** Short name for narrow tables. */
  short: string;
  /** Group the structure is built on. */
  group: string;
  /** What the numbers rest on. */
  basis: string;
  after: StructureState;
  /** Gain on the tightest part: margin (share of its budget) and headroom, K. */
  marginGain: number;
  headroomGainK: number;
  /** Noise change at 1 m, dB(A) (negative = quieter). */
  noiseDeltaDb: number;
  /** Case volume added, L. */
  volumeL: number;
  massG: number;
  printMin: number;
  /** Worth building on these estimates: beats the uncertainty on cooling or noise without costing the other. */
  worthIt: boolean;
  /** Always true here: estimates, kept off the frontier until confirmed. */
  needsReference: true;
  note?: string;
}

/** Structures not estimated here, and why. */
export const STRUCTURES_NOT_ESTIMATED = [
  { label: 'Turning vanes and radiused (Coanda) bends', why: 'need the bend geometry and boundary-layer physics: reference CFD only' },
  { label: 'Vortex generators ahead of radiators and fin stacks', why: 'boundary-layer effect below the browser grid: reference CFD only' },
  { label: 'Conformal shrouds closing the fan-to-vent gap', why: 'the 1D model already sends all fan air through the vent; tried in 3D as the "duct" structure' },
  { label: 'Helmholtz resonators tuned to the blade-pass tone', why: 'act on the tone only, and the noise model has no spectrum: cut (priority list)' },
  { label: 'Gyroid / TPMS grilles', why: 'no opened source for their loss coefficients yet: cut (priority list)' },
  { label: 'Labyrinth exhausts', why: 'a folded expansion chamber: use the silencer estimate plus bend losses' },
];

/** Uncertainty on a noise change from these estimates, dB (estimate). */
export const NOISE_MIN_GAIN_DB = 1;

const MM2 = 1e-6;

/** Frequency-averaged transmission loss of a simple expansion chamber of area ratio m, dB. */
export const expansionChamberTl = (m: number) => 10 * Math.log10(1 + 0.125 * (m - 1 / m) ** 2);

/** Pressure recovered by a conical diffuser, as a share of the inlet velocity head. */
export const diffuserRecovery = (areaRatio: number, efficiency = 0.7) => efficiency * (1 - 1 / (areaRatio * areaRatio));

const SHELL_MM = 1.2;

/** Case noise from a design recipe at fan speeds (mirrors the design's own noise sum). */
export function recipeNoise(recipe: DesignRecipe, speeds: Record<string, number>, flow: FlowResult, lwDelta: Record<string, number> = {}): NoiseResult {
  const src: NoiseSource[] = [];
  for (const f of recipe.fans) {
    const sp = speeds[f.id] ?? 1;
    src.push({ id: f.id, label: f.label, lw: fanLw(f.fan, f.count, sp) + f.penaltyDb + (lwDelta[f.id] ?? 0), penaltyDb: f.penaltyDb });
  }
  for (const s of recipe.fixedSources) src.push({ ...s, lw: s.lw + (lwDelta[s.id] ?? 0) });
  let vents = -Infinity;
  for (const g of flow.groups) {
    const a = recipe.ventOpenM2[g.id] ?? 0;
    if (a > 0 && g.flow > 0) vents = sumDb([vents, ventLw(a, g.flow)]);
  }
  const passive = flow.zones.reduce((s, z) => s + Math.abs(z.passiveFlow), 0);
  if (recipe.passiveOpenM2 > 0) vents = sumDb([vents, ventLw(recipe.passiveOpenM2, passive)]);
  if (Number.isFinite(vents)) src.push({ id: 'vents', label: 'Air through the vents', lw: vents });
  return noiseTotal(src);
}

/** A group's flow resistance Σ ζ/A² (velocity heads per unit area²). */
const resistance = (losses: LossTerm[]) => losses.reduce((s, l) => s + (l.area > 0 ? l.zeta / (l.area * l.area) : 0), 0);

/** The network with a structure applied; recovered pressure never cuts a path's resistance below half. */
export function applyMod(net: NetworkInput, mod: StructureMod): NetworkInput {
  return {
    ...net,
    groups: net.groups.map((g) => {
      let losses = mod.mapLoss ? g.losses.map((l) => mod.mapLoss!(g.id, l)) : g.losses;
      const extra = mod.losses?.[g.id];
      if (extra) {
        const r0 = resistance(losses);
        const next = [...losses, ...extra];
        const r1 = resistance(next);
        if (r1 < 0.5 * r0) {
          // Scale the recovered terms back so at least half the resistance remains.
          const neg = resistance(extra.filter((l) => l.zeta < 0));
          const k = neg < 0 ? Math.max(0, (0.5 * r0 - (r1 - neg)) / neg) : 1;
          losses = [...losses, ...extra.map((l) => (l.zeta < 0 ? { ...l, zeta: l.zeta * k } : l))];
        } else losses = next;
      }
      return { ...g, losses };
    }),
  };
}

/** Solve fan speeds and noise for the recipe with a structure, as the design itself was solved. */
export function solveWith(recipe: DesignRecipe, mod: StructureMod = {}): StructureState {
  const net = applyMod(recipe.net, mod);
  const problem = {
    controls: recipe.fans.map((f) => ({ id: f.id, min: f.min })),
    evaluate: (sp: Record<string, number>) => solveNetwork({ ...net, groups: net.groups.map((g) => (g.id in sp ? { ...g, speed: sp[g.id] } : g)) }),
    noise: (sp: Record<string, number>, f: FlowResult) => recipeNoise(recipe, sp, f, mod.lwDelta),
  };
  const s = recipe.control.quiet ? quietestSafe(problem) : coolestWithin(problem, recipe.control.budgetDb);
  return { speeds: s.speeds, flow: s.flow, noise: s.noise, feasible: s.feasible };
}

/** Area of the case wall a fan faces (mm²), for volume added by deepening that side. */
function wallFaceArea(recipe: DesignRecipe, wall: number | undefined) {
  const e = recipe.exterior;
  if (wall === undefined) return Math.max(e[0] * e[1], e[1] * e[2], e[0] * e[2]);
  const a = axisOf(wall as never);
  return a === 0 ? e[1] * e[2] : a === 1 ? e[0] * e[2] : e[0] * e[1];
}

/** Filament and print time of a thin printed surface (mm²). */
function printCost(areaMm2: number, cfg: DesignConfig) {
  const mat = MATERIALS.find((m) => m.id === cfg.prefs.materialId) ?? MATERIALS[0];
  const c = pieceCost({ volumeMm3: areaMm2 * SHELL_MM, areaMm2: 2 * areaMm2 } as never, 0, mat, DEFAULT_SLICER);
  return { massG: c.massG, printMin: c.timeMin };
}

interface Candidate {
  id: string;
  kind: StructureKind;
  label: string;
  short: string;
  group: string;
  basis: string;
  mod: StructureMod;
  volumeMm3: number;
  surfaceMm2: number;
  note?: string;
}

function candidates(design: Design): Candidate[] {
  const r = design.recipe;
  const out: Candidate[] = [];
  for (const f of r.fans) {
    if (!f.atWall) continue;
    const g = r.net.groups.find((x) => x.id === f.id);
    if (!g) continue;
    const D = f.fan.size;
    const fanArea = f.count * D * D * MM2;
    const wallArea = wallFaceArea(r, f.wall);
    const intake = g.source === 'outside';
    const exhaust = g.sink === 'outside';
    if (intake) {
      const lip = 0.15 * D;
      out.push({
        id: `bell-${f.id}`,
        kind: 'bell-mouth',
        label: `Bell-mouth inlet on the ${f.label} (lip radius ${Math.round(lip)} mm)`,
        short: `Bell-mouth · ${f.label}`,
        group: f.id,
        basis: 'estimate: entry loss K 0.5 → 0.05',
        mod: { losses: { [f.id]: [{ label: 'bell-mouth', zeta: -0.45, area: fanArea }] } },
        volumeMm3: Math.max(0, lip - f.gapMm) * wallArea,
        surfaceMm2: f.count * Math.PI * D * ((Math.PI / 2) * lip),
        note: 'Quieter inflow (less turbulence into the blades) is likely but not credited.',
      });
    }
    if (exhaust) {
      for (const extra of [0, 25]) {
        const L = f.gapMm + extra;
        if (L < 5) continue;
        const R = D / 2;
        const R2 = R + L * Math.tan((6 * Math.PI) / 180);
        const ar = (R2 / R) ** 2;
        const cp = diffuserRecovery(ar);
        out.push({
          id: `diffuser-${f.id}-${extra}`,
          kind: 'diffuser',
          label: `Exit diffuser on the ${f.label}, ${Math.round(L)} mm long${extra ? ` (case +${extra} mm)` : ' (in the existing gap)'}`,
          short: `Diffuser ${Math.round(L)} mm · ${f.label}`,
          group: f.id,
          basis: `estimate: 6° cone, area ratio ${ar.toFixed(2)}, recovery 0.7 × ideal = ${cp.toFixed(2)} of the exit head`,
          mod: { losses: { [f.id]: [{ label: 'diffuser', zeta: -cp, area: fanArea }] } },
          volumeMm3: extra * wallArea,
          surfaceMm2: f.count * Math.PI * (R + R2) * L,
          note: 'With a hub-wake fill cone behind the motor (included in the 0.7 recovery).',
        });
      }
    }
    // Expansion-chamber silencer between the fan and its vent.
    const m = Math.min(4, Math.max(1.5, (0.8 * wallArea * MM2) / fanArea));
    const L = 60;
    const tl = expansionChamberTl(m);
    const fanSide = 10 * Math.log10(0.5 + 0.5 * 10 ** (-tl / 10));
    out.push({
      id: `silencer-${f.id}`,
      kind: 'silencer',
      label: `Expansion-chamber silencer on the ${f.label} vent (${L} mm deep, ${m.toFixed(1)}× the fan area)`,
      short: `Silencer · ${f.label}`,
      group: f.id,
      basis: `standard expansion-chamber formula: ${tl.toFixed(1)} dB averaged over frequency on the vent side → ${fanSide.toFixed(1)} dB on this fan`,
      mod: {
        losses: { [f.id]: [{ label: 'silencer', zeta: (1 - 1 / m) ** 2 + 0.5 * (1 - 1 / m), area: fanArea }] },
        lwDelta: { [f.id]: fanSide },
      },
      volumeMm3: Math.max(0, L - f.gapMm) * wallArea,
      surfaceMm2: 2 * m * fanArea / MM2 + 4 * Math.sqrt((m * fanArea) / MM2) * L,
      note: 'An absorbing lining (felt or foam) would add high-frequency loss; not credited.',
    });
    // Deeper fan-to-radiator plenum.
    if (g.isRadiator && g.losses.some((l) => l.label === 'plenum')) {
      const core = g.losses.find((l) => l.label === 'radiator core')?.area ?? Infinity;
      const plen = Math.max(1, r.plenumMm);
      for (const add of [10, 20]) {
        const k = (plen + add) / plen;
        const perimMm = (g.losses.find((l) => l.label === 'plenum')!.area / MM2) / plen;
        out.push({
          id: `plenum-${f.id}-${add}`,
          kind: 'plenum',
          label: `${add} mm deeper fan-to-radiator plenum on the ${f.label}`,
          short: `Plenum +${add} mm · ${f.label}`,
          group: f.id,
          basis: 'model: plenum loss K 1 on the plenum side area',
          mod: { mapLoss: (gid, l) => (gid === f.id && l.label === 'plenum' ? { ...l, area: Math.min(core, l.area * k) } : l) },
          volumeMm3: add * wallArea,
          surfaceMm2: perimMm * add,
          note: 'A deeper plenum also evens the flow over the core behind the fan hub; see the 3D flow-uniformity index.',
        });
      }
    }
  }
  return out;
}

/** Every structure for the design, best first; the baseline is the design re-solved the same way. */
export function evaluateStructures(design: Design, cfg: DesignConfig) {
  const baseline = solveWith(design.recipe);
  const results: StructureResult[] = candidates(design).map((c) => {
    const after = solveWith(design.recipe, c.mod);
    const marginGain = after.flow.worstMargin - baseline.flow.worstMargin;
    const headroomGainK = after.flow.worstHeadroomK - baseline.flow.worstHeadroomK;
    const noiseDeltaDb = after.noise.spl - baseline.noise.spl;
    const cost = printCost(c.surfaceMm2, cfg);
    // Budget mode buys cooling at a fixed noise; quiet mode buys silence with every part safe.
    const cooler = !design.recipe.control.quiet && marginGain > STRUCTURE_MIN_GAIN && noiseDeltaDb < 0.5;
    const quieter = noiseDeltaDb <= -NOISE_MIN_GAIN_DB && (design.recipe.control.quiet || marginGain > -0.01);
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      short: c.short,
      group: c.group,
      basis: c.basis,
      after,
      marginGain,
      headroomGainK,
      noiseDeltaDb,
      volumeL: c.volumeMm3 / 1e6,
      massG: cost.massG,
      printMin: cost.printMin,
      worthIt: (cooler || quieter) && after.feasible,
      needsReference: true,
      note: c.note,
    };
  });
  results.sort((a, b) => Number(b.worthIt) - Number(a.worthIt) || b.marginGain - a.marginGain || a.noiseDeltaDb - b.noiseDeltaDb);
  return { baseline, results };
}
