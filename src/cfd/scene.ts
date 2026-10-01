import { VENT_STYLES } from '../model/presets';
import type { DesignConfig, FanSpec } from '../model/types';
import { MMH2O_TO_PA, perforatedPlateZeta } from '../solver/airflow';
import type { Design, PlacedPart } from '../solver/evaluate';
import { axisOf, dirVec, localBoxToWorld, signOf, wallAxes, type Box, type Dir, type Vec3 } from '../solver/geometry';
import { boardStack } from '../solver/items';
import { shellField } from '../solver/shrinkwrap';
import type { Partition } from '../solver/chambers';
import { CELL_SOLID, type FanDisk, type HeatSource, type Louvre, type Scene } from './solver';

/** Flow-shaping features the optimiser can switch on. */
export interface Shaping {
  /** Exhaust deflectors: vent index → in-plane direction the louvres throw the air toward. */
  louvres: { vent: number; toward: Dir }[];
  /** Part ids whose fan gets a duct sealing the gap to its vent. */
  ducts: string[];
  /** Radiators whose fans are reversed relative to the design. */
  flipped: string[];
  /** Extra internal partitions to try (on top of the design's own chambers). */
  partitions?: Partition[];
  /** Leave out the design's own partitions (to check them against one chamber). */
  noChambers?: boolean;
}

export const NO_SHAPING: Shaping = { louvres: [], ducts: [], flipped: [] };

const RHO = 1.2; // kg/m³
export const LOUVRE_ANGLE = (40 * Math.PI) / 180;
const SWIRL = 0.35;

export interface SceneOptions {
  /** Target cell count; the cell size follows from it. */
  cells?: number;
  margin?: number;
}

/** Which way is "up" in solver axes for the case orientation. */
export function upAxis(cfg: DesignConfig) {
  return cfg.prefs.orientation === 'tower' ? { axis: 1, sign: 1 } : { axis: 2, sign: 1 };
}

/** The scene's geometry in solver millimetres (what the grid was built from). */
export interface SceneGeometry {
  solids: Box[];
  porous: { box: Box; along: number[]; zeta: number; thickness: number; label: string }[];
  heat: { id: string; label: string; box: Box; watts: number }[];
  fans: { slab: Box; center: Vec3; axis: number; sign: number; radius: number; group: string; spec: FanSpec; count: number }[];
  partitions?: Partition[];
}

/**
 * Fan disk forcing from a fan's rated curve: free-air axial speed over the disk area, and the
 * acceleration at stall that builds the fan's maximum static pressure across `layers` cells.
 */
export function fanForcing(spec: FanSpec, areaMm2: number, layers: number, h: number) {
  const vmax = ((spec.maxAirflowM3h / 3600) * 1e9) / areaMm2;
  const depthM = (layers * h) / 1000;
  const a0 = ((spec.maxPressureMmH2O * MMH2O_TO_PA) / (RHO * depthM)) * 1000; // mm/s²
  return { vmax, a0 };
}

/**
 * Quadratic porous loss per mm of travel for a block `cells` thick: Δp = ζ·½ρv² spread over the
 * faces the drag acts on. Drag acts on every face touching a porous cell, so a block n cells thick
 * has n + 1 such faces along the flow.
 */
export function porousBeta(zeta: number, cells: number, h: number) {
  return zeta / (2 * (cells + 1) * h);
}

export function buildScene(design: Design, cfg: DesignConfig, shaping: Shaping = NO_SHAPING, opts: SceneOptions = {}): Scene {
  const margin = opts.margin ?? 60;
  const target = opts.cells ?? 45000;
  const span: Vec3 = [design.interior[0] + 2 * margin, design.interior[1] + 2 * margin, design.interior[2] + 2 * margin];
  const h = Math.max(6, Math.cbrt((span[0] * span[1] * span[2]) / target));
  const n = span.map((s) => Math.max(4, Math.ceil(s / h))) as [number, number, number];
  const origin: [number, number, number] = [-margin, -margin, -margin];
  const [nx, ny, nz] = n;
  const total = nx * ny * nz;
  const cellType = new Uint8Array(total);
  const beta: [Float32Array, Float32Array, Float32Array] = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];
  const centre = (c: number): Vec3 => {
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    return [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
  };
  const toGrid = (p: Vec3): [number, number, number] => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];

  /** Cells overlapping a box; thin boxes are fattened to one cell so they can't leak. */
  const cellsIn = (b: Box): number[] => {
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      let mn = b.min[a];
      let mx = b.max[a];
      if (mx - mn < h) {
        const c = (mn + mx) / 2;
        mn = c - h / 2;
        mx = c + h / 2;
      }
      lo[a] = Math.max(0, Math.round((mn - origin[a]) / h));
      hi[a] = Math.min(n[a] - 1, Math.round((mx - origin[a]) / h) - 1);
    }
    const out: number[] = [];
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) out.push(i + nx * (j + ny * k));
    return out;
  };
  const setPorous = (cells: number[], along: number[], low: number, high: number) => {
    for (const c of cells) {
      if (cellType[c] === CELL_SOLID) continue;
      for (let a = 0; a < 3; a++) beta[a][c] = Math.max(beta[a][c], along.includes(a) ? low : high);
    }
  };

  // Geometry in solver millimetres, for exporting the same scene to other solvers.
  const geom: SceneGeometry = { solids: [], porous: [], heat: [], fans: [] };
  const solidBox = (b: Box) => {
    geom.solids.push(b);
    for (const c of cellsIn(b)) cellType[c] = CELL_SOLID;
  };
  const porousBox = (b: Box, along: number[], zeta: number, thickness: number, label: string) => {
    geom.porous.push({ box: b, along, zeta, thickness, label });
    const cells = cellsIn(b);
    setPorous(cells, along, betaFor(zeta, thickness), HIGH);
    return cells;
  };
  /** Quadratic loss coefficient per mm of travel: ζ spread over the block thickness. */
  const betaFor = (zeta: number, thickness: number) => porousBeta(zeta, Math.max(1, Math.round(thickness / h)), h);
  const HIGH = 0.5; // 1/mm: effectively blocks flow across fins / boards

  // ------------------------------------------------ shell: solid band, vents porous
  const field = shellField(design, cfg, cfg.prefs.organic ?? 0);
  const wall = design.wall;
  const vs = VENT_STYLES.find((v) => v.id === cfg.prefs.ventStyleId) ?? VENT_STYLES[0];
  const ventBeta = betaFor(perforatedPlateZeta(vs.openRatio) + (cfg.prefs.dustFilters ? cfg.advanced.dustFilterLossK : 0), h);
  const interior: number[] = [];
  const ventCells: number[][] = design.vents.map(() => []);
  const fieldVals = new Float32Array(total);
  for (let c = 0; c < total; c++) fieldVals[c] = field(centre(c));
  const grad = (p: Vec3): Vec3 => {
    const e = h * 0.5;
    const g: Vec3 = [
      field([p[0] + e, p[1], p[2]]) - field([p[0] - e, p[1], p[2]]),
      field([p[0], p[1] + e, p[2]]) - field([p[0], p[1] - e, p[2]]),
      field([p[0], p[1], p[2] + e]) - field([p[0], p[1], p[2] - e]),
    ];
    const l = Math.hypot(...g) || 1;
    return [g[0] / l, g[1] / l, g[2] / l];
  };
  const wallCell = new Uint8Array(total);
  for (let c = 0; c < total; c++) {
    const f = fieldVals[c];
    if (f < -wall - 0.5 * h) {
      interior.push(c);
      continue;
    }
    if (f > 0.5 * h) continue;
    wallCell[c] = 1;
    const p = centre(c);
    const nrm = grad(p);
    let vent = -1;
    design.vents.forEach((v, idx) => {
      const a = axisOf(v.wall);
      if (nrm[a] * signOf(v.wall) < 0.5) return;
      const [xa, ya] = wallAxes(a);
      if (p[xa] < v.rect.x0 - 0.3 * h || p[xa] > v.rect.x1 + 0.3 * h || p[ya] < v.rect.y0 - 0.3 * h || p[ya] > v.rect.y1 + 0.3 * h) return;
      if (vent < 0 || design.vents[vent].kind === 'passive') vent = idx;
    });
    const kind = vent >= 0 ? design.vents[vent].kind : null;
    if (kind && kind !== 'io' && kind !== 'bracket') {
      for (let a = 0; a < 3; a++) beta[a][c] = ventBeta;
      ventCells[vent].push(c);
    } else {
      cellType[c] = CELL_SOLID;
    }
  }

  // ------------------------------------------------ parts
  const fans: FanDisk[] = [];
  const heat: HeatSource[] = [];
  const groupFlow = (id: string) => design.flow.groups.find((g) => g.id === id);
  const local = (part: PlacedPart, lo: Vec3, hi: Vec3) => localBoxToWorld(part.frame, part.body, lo, hi);
  const axisWorld = (part: PlacedPart, k: 0 | 1 | 2) => axisOf(part.frame.d[k]);

  /** Fan frame: the slab around a disk is solid so air can't loop back around the blades. */
  const shroud = (slab: Box, disk: number[]) => {
    const keep = new Set(disk);
    for (const c of cellsIn(slab)) if (!keep.has(c) && !wallCell[c]) cellType[c] = CELL_SOLID;
  };
  /** Disk cells of `radius` around `centreW` in a slab, plus a shrouded frame. */
  const pushFan = (slab: Box, centreW: Vec3, ax: number, radius: number, sign: number, group: string, count: number, frame: Box | null, spec: FanSpec): number[] => {
    const usable = cellsIn(slab).filter((c) => {
      if (cellType[c] === CELL_SOLID) return false;
      const p = centre(c);
      let d2 = 0;
      for (let a = 0; a < 3; a++) if (a !== ax) d2 += (p[a] - centreW[a]) ** 2;
      return d2 <= (radius + h * 0.35) ** 2;
    });
    if (!usable.length) return [];
    if (frame) shroud(frame, usable);
    const flow = groupFlow(group)?.flow ?? 0;
    const layers = Math.max(1, Math.round((slab.max[ax] - slab.min[ax]) / h));
    const crossCells = usable.length / layers;
    const area = Math.max(h * h, crossCells * h * h); // mm²
    const speed = (flow * 1e9) / count / area;
    const { vmax, a0 } = fanForcing(spec, area, layers, h);
    fans.push({ cells: Int32Array.from(usable), axis: ax, sign, speed, vmax, a0, center: toGrid(centreW), swirl: SWIRL, group, layers, pmaxPa: spec.maxPressureMmH2O * MMH2O_TO_PA });
    geom.fans.push({ slab, center: centreW, axis: ax, sign, radius, group, spec, count });
    return usable;
  };
  /** A fan disk in a part's local frame: centre (c1, c2) on the e3 slab [z0, z1], blowing along ±e3. */
  const addFan = (part: PlacedPart, c1: number, c2: number, radius: number, z0: number, z1: number, blowLocalSign: number, group: string, spec: FanSpec, count = 1, shrouded = true) => {
    const slab = local(part, [c1 - radius, c2 - radius, z0], [c1 + radius, c2 + radius, z1]);
    const centreW: Vec3 = [(slab.min[0] + slab.max[0]) / 2, (slab.min[1] + slab.max[1]) / 2, (slab.min[2] + slab.max[2]) / 2];
    return pushFan(slab, centreW, axisWorld(part, 2), radius, signOf(part.frame.d[2]) * blowLocalSign, group, count, shrouded ? slab : null, spec);
  };

  const fanDir = (part: PlacedPart) => {
    const base = part.airflow;
    if (!shaping.flipped.includes(part.id) || base === 'through') return base;
    return base === 'in' ? 'out' : base === 'out' ? 'in' : base;
  };

  const bs = boardStack(cfg, design.profile.extraGap);
  const bp = cfg.parts.board;
  const cooler = cfg.parts.cooler;
  const gpuSpec = cfg.parts.gpu;
  let boardHeatCells: number[] = [];

  for (const part of design.parts) {
    if (part.kind === 'board') {
      const o: Vec3 = [part.body.min[0], part.body.min[1] + bs.pcbDv, part.body.min[2]];
      const box = (lo: Vec3, hi: Vec3): Box => ({ min: [o[0] + lo[0], o[1] + lo[1], o[2] + lo[2]], max: [o[0] + hi[0], o[1] + hi[1], o[2] + hi[2]] });
      solidBox(box([0, 0, bp.underside], [bp.depth, bp.edge, bs.surface]));
      solidBox(box([0, Math.max(0, bp.edge - 160), bs.surface], [24, bp.edge - 4, bs.surface + Math.min(bp.componentHeight, 40)]));
      const sx = bp.socketU;
      const sy = bp.socketV;
      const cz = bs.surface + bp.socketStack;
      boardHeatCells = cellsIn(box([0, 0, bs.surface], [bp.depth, bp.edge, bs.surface + Math.min(15, bp.componentHeight)])).filter((c) => cellType[c] !== CELL_SOLID);
      if (cooler.kind === 'aio') {
        solidBox(box([sx - 30, sy - 30, cz], [sx + 30, sy + 30, cz + cooler.height]));
      } else if (cooler.kind === 'air-downdraft') {
        const finTop = cz + cooler.height - cooler.fan.thickness;
        const fins = porousBox(box([sx - cooler.depth / 2, sy - cooler.width / 2, cz], [sx + cooler.depth / 2, sy + cooler.width / 2, finTop]), [2], cfg.advanced.finStackLossK, finTop - cz, 'CPU fins');
        heat.push({ id: 'cpu', label: 'CPU cooler', cells: Int32Array.from(fins.filter((c) => cellType[c] !== CELL_SOLID)), watts: groupFlow('cpu')?.heatW ?? cooler.cpuPowerW });
        // Fan on top, blowing down through the fins onto the board (board frame = world axes).
        const r = Math.min(cooler.fan.size, cooler.width, cooler.depth) / 2;
        const top = finTop + Math.max(cooler.fan.thickness, h);
        pushFan(
          box([sx - r, sy - r, finTop], [sx + r, sy + r, top]),
          [o[0] + sx, o[1] + sy, o[2] + (finTop + top) / 2],
          2,
          r,
          -1,
          'cpu',
          1,
          box([sx - cooler.depth / 2, sy - cooler.width / 2, finTop], [sx + cooler.depth / 2, sy + cooler.width / 2, top]),
          cooler.fan,
        );
      } else {
        const fins = porousBox(box([sx - cooler.depth / 2, sy - cooler.width / 2, cz], [sx + cooler.depth / 2, sy + cooler.width / 2, cz + cooler.height]), [0], cfg.advanced.finStackLossK, cooler.depth, 'CPU fins');
        heat.push({ id: 'cpu', label: 'CPU cooler', cells: Int32Array.from(fins.filter((c) => cellType[c] !== CELL_SOLID)), watts: groupFlow('cpu')?.heatW ?? cooler.cpuPowerW });
      }
    } else if (part.kind === 'gpu') {
      const [L, H, T] = part.size;
      const g = groupFlow('gpu-card');
      if (gpuSpec.cardFan) {
        const body = porousBox(part.body, [axisWorld(part, 0), axisWorld(part, 2)], 3, L / 2, 'GPU shroud');
        heat.push({ id: 'gpu-card', label: g?.label ?? 'GPU card', cells: Int32Array.from(body.filter((c) => cellType[c] !== CELL_SOLID)), watts: g?.heatW ?? 0 });
        if (gpuSpec.cooling === 'aio') addFan(part, L * 0.82, H * 0.5, Math.min(80, H - 20) / 2, T - Math.max(15, h), T, -1, 'gpu-card', gpuSpec.cardFanSpec);
        else {
          const nF = L > 250 ? 3 : 2;
          const size = Math.min(95, (L - 20) / nF, H - 15);
          for (let i = 0; i < nF; i++) addFan(part, 10 + ((L - 20) / nF) * (i + 0.5), H / 2, size / 2, T - Math.max(13, h), T, -1, 'gpu-card', { ...gpuSpec.cardFanSpec, maxAirflowM3h: gpuSpec.cardFanSpec.maxAirflowM3h / nF }, nF);
        }
      } else {
        solidBox(part.body);
      }
    } else if (part.kind === 'psu') {
      const [L, W, H] = part.size;
      const body = porousBox(part.body, [axisWorld(part, 0), axisWorld(part, 2)], cfg.advanced.psuLossK, L, 'PSU');
      const g = groupFlow('psu');
      heat.push({ id: 'psu', label: 'Power supply', cells: Int32Array.from(body.filter((c) => cellType[c] !== CELL_SOLID)), watts: g?.heatW ?? 0 });
      if (cfg.parts.psu.fanOn === 'face') {
        const z0 = H - Math.max(15, h);
        const disk = addFan(part, L / 2, W / 2, Math.min(L, W) / 2 - 6, z0, H, -1, 'psu', cfg.parts.psu.fan, 1, false);
        shroud(local(part, [0, 0, z0], [L, W, H]), disk);
      } else {
        // End fan at the cable end, blowing toward the AC end.
        const slab = local(part, [L - Math.max(15, h), 0, 0], [L, W, H]);
        const ax = axisWorld(part, 0);
        const ctr: Vec3 = [(slab.min[0] + slab.max[0]) / 2, (slab.min[1] + slab.max[1]) / 2, (slab.min[2] + slab.max[2]) / 2];
        pushFan(slab, ctr, ax, Math.max(W, H), -signOf(part.frame.d[0]), 'psu', 1, null, cfg.parts.psu.fan);
      }
    } else if (part.kind === 'rad-cpu' || part.kind === 'rad-gpu') {
      const rad = part.radiator!;
      const fan = part.fan!;
      const [len, wid] = part.size;
      const core = porousBox(local(part, [16, 0, 0], [len - 16, wid, rad.coreThickness]), [axisWorld(part, 2)], cfg.advanced.radLossK * (rad.coreThickness / 27), rad.coreThickness, `${part.label} core`);
      solidBox(local(part, [0, 0, 0], [16, wid, rad.coreThickness]));
      solidBox(local(part, [len - 16, 0, 0], [len, wid, rad.coreThickness]));
      const g = groupFlow(part.id);
      heat.push({ id: part.id, label: g?.label ?? part.label, cells: Int32Array.from(core.filter((c) => cellType[c] !== CELL_SOLID)), watts: g?.heatW ?? 0 });
      // +e3 points at the vented wall: 'out'/'through' blow toward it, 'in' away from it.
      const blow = fanDir(part) === 'in' ? -1 : 1;
      const nF = part.fanCount ?? rad.fanCount;
      const start = (len - nF * fan.size) / 2;
      const fanTop = rad.coreThickness + Math.max(fan.thickness, h);
      const disks: number[] = [];
      for (let i = 0; i < nF; i++) disks.push(...addFan(part, start + fan.size * (i + 0.5), wid / 2, Math.min(fan.size, wid) / 2 - 2, rad.coreThickness, fanTop, blow, part.id, fan, nF, false));
      // One frame across the whole fan row.
      shroud(local(part, [0, 0, rad.coreThickness], [len, wid, fanTop]), disks);
    } else {
      solidBox(part.body);
    }

    // Duct: seal the gap between the part's fan face and its vented wall with four side plates.
    if (shaping.ducts.includes(part.id) && part.face !== undefined) {
      const a = axisOf(part.face);
      const out = signOf(part.face) > 0;
      const gapBox: Box = { min: [...part.body.min] as Vec3, max: [...part.body.max] as Vec3 };
      if (part.kind === 'board') {
        gapBox.min = [part.body.min[0] + bp.socketU - cooler.depth / 2, part.body.min[1] + bs.pcbDv + bp.socketV - cooler.width / 2, part.body.min[2]];
        gapBox.max = [part.body.min[0] + bp.socketU + cooler.depth / 2, part.body.min[1] + bs.pcbDv + bp.socketV + cooler.width / 2, part.body.max[2]];
      }
      if (out) {
        gapBox.min[a] = part.body.max[a] - h;
        gapBox.max[a] = design.interior[a] + wall;
      } else {
        gapBox.min[a] = -wall;
        gapBox.max[a] = part.body.min[a] + h;
      }
      for (const plate of ductPlates(gapBox, a, h * 0.5)) {
        // Only inside the shell, and never on top of a part's own cells.
        for (const c of cellsIn(plate)) if (fieldVals[c] < -wall - 0.25 * h && cellType[c] !== CELL_SOLID && beta[0][c] === 0) cellType[c] = CELL_SOLID;
      }
    }
  }

  // Board, extras and (fanless) card heat go into the air just above the board.
  // Same load as the design's airflow model (its zones hold the heat released into case air).
  const internal = design.flow.zones?.length
    ? design.flow.zones.reduce((sum, z) => sum + z.heatW, 0)
    : cfg.parts.board.heatW +
      cfg.parts.extras.reduce((sum, e) => sum + e.heatW, 0) +
      (gpuSpec.cardFan ? 0 : gpuSpec.boardPowerW * (1 - (gpuSpec.cooling === 'aio' ? gpuSpec.radiatorHeatShare : 0)));
  heat.push({ id: 'board', label: 'Board (VRM, RAM, SSD)', cells: Int32Array.from(boardHeatCells.filter((c) => cellType[c] !== CELL_SOLID)), watts: internal });

  // ------------------------------------------------ internal partitions (solid plates in the gaps)
  const cuts = [...(shaping.noChambers ? [] : (design.chamber?.cuts ?? [])), ...(shaping.partitions ?? [])];
  if (cuts.length) {
    const fanCells = new Set<number>();
    for (const f of fans) for (const c of f.cells) fanCells.add(c);
    for (const cut of cuts) {
      const min = [...cut.region.min] as Vec3;
      const max = [...cut.region.max] as Vec3;
      min[cut.axis] = cut.at - 0.5;
      max[cut.axis] = cut.at + 0.5;
      for (const c of cellsIn({ min, max })) if (cellType[c] !== CELL_SOLID && !fanCells.has(c) && beta[0][c] === 0 && beta[1][c] === 0 && beta[2][c] === 0) cellType[c] = CELL_SOLID;
    }
  }

  // ------------------------------------------------ louvres
  const louvres: Louvre[] = [];
  for (const l of shaping.louvres) {
    const v = design.vents[l.vent];
    if (!v) continue;
    const cells = ventCells[l.vent].filter((c) => cellType[c] !== CELL_SOLID);
    if (!cells.length) continue;
    louvres.push({ cells: Int32Array.from(cells), dir: louvreDirection(v.wall, l.toward), normal: dirVec(v.wall) as [number, number, number] });
  }

  // Heat sources as boxes (the bounding box of their cells).
  for (const src of heat) {
    if (!src.cells.length || src.watts <= 0) continue;
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of src.cells) {
      const p = centre(c);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a] - h / 2);
        hi[a] = Math.max(hi[a], p[a] + h / 2);
      }
    }
    geom.heat.push({ id: src.id, label: src.label, box: { min: lo, max: hi }, watts: src.watts });
  }
  geom.partitions = cuts;

  return {
    geometry: geom,
    n,
    h,
    origin,
    cellType,
    beta,
    fans,
    louvres,
    heat: heat.filter((s) => s.watts > 0 && s.cells.length > 0),
    up: upAxis(cfg),
    interior: Int32Array.from(interior.filter((c) => cellType[c] !== CELL_SOLID)),
  };
}

/** Direction louvres on `wall` throw air: tilted LOUVRE_ANGLE from the wall normal toward `toward`. */
export function louvreDirection(wall: Dir, toward: Dir): [number, number, number] {
  const nrm = dirVec(wall);
  const tan = dirVec(toward);
  return [0, 1, 2].map((a) => Math.cos(LOUVRE_ANGLE) * nrm[a] + Math.sin(LOUVRE_ANGLE) * tan[a]) as [number, number, number];
}

/** The four side plates of a duct around `gap` (open along axis `a`). */
export function ductPlates(gap: Box, a: number, thick: number): Box[] {
  const [xa, ya] = wallAxes(a as 0 | 1 | 2);
  const out: Box[] = [];
  for (const ax of [xa, ya])
    for (const side of [0, 1]) {
      const plate: Box = { min: [...gap.min] as Vec3, max: [...gap.max] as Vec3 };
      if (side === 0) {
        plate.max[ax] = gap.min[ax];
        plate.min[ax] = gap.min[ax] - thick;
      } else {
        plate.min[ax] = gap.max[ax];
        plate.max[ax] = gap.max[ax] + thick;
      }
      out.push(plate);
    }
  return out;
}

function ventCentre(design: Design, v: Design['vents'][number]): Vec3 {
  const a = axisOf(v.wall);
  const [xa, ya] = wallAxes(a);
  const p: Vec3 = [0, 0, 0];
  p[a] = signOf(v.wall) > 0 ? design.interior[a] : 0;
  p[xa] = (v.rect.x0 + v.rect.x1) / 2;
  p[ya] = (v.rect.y0 + v.rect.y1) / 2;
  return p;
}

/** Exhaust vents the optimiser may fit with deflectors, each pointing away from the intakes. */
export function louvreCandidates(design: Design): { vent: number; toward: Dir }[] {
  const intakes = design.vents.filter((v) => v.flow === 'in' && v.kind !== 'passive');
  const ref: Vec3 = intakes.length
    ? (intakes
        .map((v) => ventCentre(design, v))
        .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
        .map((x) => x / intakes.length) as Vec3)
    : [design.interior[0] / 2, design.interior[1] / 2, design.interior[2] / 2];
  const out: { vent: number; toward: Dir }[] = [];
  design.vents.forEach((v, idx) => {
    if (v.flow !== 'out' || v.kind === 'passive') return;
    const c = ventCentre(design, v);
    const [xa, ya] = wallAxes(axisOf(v.wall));
    const dx = c[xa] - ref[xa];
    const dy = c[ya] - ref[ya];
    const axis = Math.abs(dx) >= Math.abs(dy) ? xa : ya;
    const s = (axis === xa ? dx : dy) >= 0 ? 1 : -1;
    out.push({ vent: idx, toward: (axis * 2 + (s < 0 ? 1 : 0)) as Dir });
  });
  return out;
}

/** Parts whose fan could get a duct to its vent. */
export function ductCandidates(design: Design): string[] {
  return design.parts.filter((p) => p.face !== undefined && p.faceAtWall && p.mode !== 'through' && p.faceGap > 2).map((p) => p.id);
}

/** Radiators whose fan direction the optimiser may reverse. */
export function flipCandidates(design: Design): string[] {
  return design.parts.filter((p) => (p.kind === 'rad-cpu' || p.kind === 'rad-gpu') && p.mode === 'wall').map((p) => p.id);
}
