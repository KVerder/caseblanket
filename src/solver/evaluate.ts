import { MATERIALS, VENT_STYLES } from '../model/presets';
import type { DesignConfig, FanSpec, RadiatorSpec, TopologyId } from '../model/types';
import { perforatedPlateZeta, solveFlow, type FanGroupInput, type FlowResult, type LossTerm } from './airflow';
import {
  axisOf,
  localToWorld,
  opposite,
  rectArea,
  rectIntersect,
  rectSubtract,
  signOf,
  wallAxes,
  type Box,
  type Dir,
  type Frame,
  type Rect,
  type Vec3,
} from './geometry';
import { allowedFaceDirs, boardStack, isTwoLayer, type ItemDef, type ItemKind, type LayerId, type Profile } from './items';
import { interiorThickness, type PackNode } from './pack';

export interface PlacedPart {
  id: string;
  kind: ItemKind;
  label: string;
  layer: LayerId;
  frame: Frame;
  size: Vec3;
  body: Box;
  clearance: Box;
  face?: Dir;
  faceAtWall: boolean;
  faceGap: number;
  mode?: 'through' | 'wall';
  radiator?: RadiatorSpec;
  fan?: FanSpec;
  fanCount?: number;
  /** Set after the airflow solve for parts that move air. */
  airflow?: 'in' | 'out' | 'through' | 'internal';
}

export type VentKind = 'fan' | 'through' | 'passive' | 'psu-exhaust' | 'io' | 'bracket';

export interface Vent {
  wall: Dir;
  rect: Rect;
  kind: VentKind;
  flow?: 'in' | 'out';
  groupId?: string;
}

export interface Check {
  level: 'ok' | 'info' | 'warn' | 'error';
  text: string;
}

export interface Design {
  id: string;
  topology: TopologyId;
  /** Two-layer runs that left the back layer empty are really single-layer designs. */
  effectiveTopology: TopologyId;
  profile: Profile;
  interior: Vec3;
  wall: number;
  exterior: Vec3;
  feet: number;
  bottomWall: Dir;
  world: { width: number; height: number; depth: number };
  thickness: number;
  volumeL: number;
  weightKg: number;
  parts: PlacedPart[];
  vents: Vent[];
  spine?: [number, number];
  flow: FlowResult;
  groupParts: Record<string, string>;
  checks: Check[];
  invalid: boolean;
  limited: boolean;
  cost: number;
  compactCost: number;
  /** Why this design is in the shortlist ("Best match", "Thinnest", …). */
  tags: string[];
}

const EPS = 0.5;

export const TOPOLOGY_LABELS: Record<TopologyId, string> = {
  flat: 'Flat — every part in one layer, GPU on a riser',
  sandwich: 'Sandwich — GPU behind the board on a riser',
  direct: 'Direct slot — GPU plugged into the board, one layer',
  'direct-stack': 'Direct slot — GPU in the board, parts stacked behind',
};

export function roundedBoxVolume(a: number, b: number, c: number, r: number, chamfer: boolean): number {
  const rr = Math.min(r, a / 2, b / 2, c / 2);
  if (rr <= 0) return a * b * c;
  const box = a * b * c;
  if (chamfer) {
    // Each edge loses a triangular prism of legs rr; corners are over-subtracted slightly (ignored).
    return box - 4 * (a + b + c) * (rr * rr) / 2;
  }
  // Steiner: inner box + faces + quarter-cylinder edges + sphere corners.
  const ia = a - 2 * rr;
  const ib = b - 2 * rr;
  const ic = c - 2 * rr;
  return ia * ib * ic + 2 * rr * (ia * ib + ib * ic + ia * ic) + Math.PI * rr * rr * (ia + ib + ic) + (4 / 3) * Math.PI * rr ** 3;
}

/** How much two walls meeting at an edge must move out so a box corner clears the inner fillet. */
function filletPush(da: number, db: number, ri: number, chamfer: boolean): number {
  if (ri <= 0) return 0;
  if (chamfer) return Math.max(0, (ri - da - db) / 2);
  if (da >= ri || db >= ri) return 0;
  const inside = (d: number) => (ri - da - d) ** 2 + (ri - db - d) ** 2 <= ri * ri || da + d >= ri || db + d >= ri;
  let lo = 0;
  let hi = ri;
  if (inside(0)) return 0;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (inside(m)) hi = m;
    else lo = m;
  }
  return hi;
}

function projectBox(b: Box, wall: Dir): Rect {
  const [x, y] = wallAxes(axisOf(wall));
  return { x0: b.min[x], y0: b.min[y], x1: b.max[x], y1: b.max[y] };
}

function wallRect(interior: Vec3, wall: Dir, inset: number): Rect {
  const [x, y] = wallAxes(axisOf(wall));
  return { x0: inset, y0: inset, x1: interior[x] - inset, y1: interior[y] - inset };
}

function expand(r: Rect, d: number): Rect {
  return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d };
}

function faceGapOf(p: PlacedPart, interior: Vec3): number {
  if (p.face === undefined) return 0;
  const a = axisOf(p.face);
  return signOf(p.face) > 0 ? interior[a] - p.body.max[a] : p.body.min[a];
}

const MM2 = 1e-6;

export interface EvalContext {
  cfg: DesignConfig;
  topology: TopologyId;
  profile: Profile;
  items: ItemDef[];
}

/** Turn a packed node into a full design: 3D placement, vents, checks and airflow. */
export function evaluate(node: PackNode, ctx: EvalContext, index: number): Design {
  const { cfg, topology, profile, items } = ctx;
  const { prefs, advanced } = cfg;
  const two = isTwoLayer(topology);
  const s = prefs.spineThickness;
  const T0 = interiorThickness(node, two, s);
  const hasB = two && node.tB > 0;
  const range: Record<LayerId, [number, number]> = {
    M: [0, T0],
    A: hasB ? [node.tB + s, T0] : [0, T0],
    B: [0, node.tB],
    AB: [0, T0],
  };

  // ---- place parts in 3D (solver interior coordinates, before fillet margins)
  const parts: PlacedPart[] = [];
  for (const pl of node.placements) {
    const item = items[pl.item];
    const variant = item.variants[pl.variant];
    const [lo, hi] = range[variant.layer];
    for (const vp of variant.parts) {
      const u0 = pl.u + vp.du;
      const v0 = pl.v + vp.dv - node.v0;
      const tExt = vp.o.ext[2];
      const t0 = vp.align === 'low' ? lo : hi - tExt;
      const clearance: Box = { min: [u0, v0, t0], max: [u0 + vp.o.ext[0], v0 + vp.o.ext[1], t0 + tExt] };
      const body: Box = {
        min: [u0 + vp.o.off[0], v0 + vp.o.off[1], t0 + vp.o.off[2]],
        max: [u0 + vp.o.off[0] + vp.o.body[0], v0 + vp.o.off[1] + vp.o.body[1], t0 + vp.o.off[2] + vp.o.body[2]],
      };
      const id = vp.kind === 'extra' ? item.id : vp.kind;
      parts.push({
        id,
        kind: vp.kind,
        label: vp.kind === 'gpu' ? 'Graphics card' : vp.kind === 'board' ? 'Motherboard' : item.label,
        layer: variant.layer,
        frame: vp.o.frame,
        size: vp.o.size,
        body,
        clearance,
        face: vp.face,
        faceAtWall: false,
        faceGap: vp.faceGap,
        mode: vp.mode,
        radiator: vp.radiator,
        fan: vp.fan,
        fanCount: vp.fanCount,
      });
    }
  }

  let interior: Vec3 = [node.u1, node.v1 - node.v0, T0];

  // ---- which fan faces reach an exterior wall (before fillet margins move the walls)
  for (const p of parts) {
    if (p.face === undefined) continue;
    const a = axisOf(p.face);
    if (a === 2) {
      // Nothing shares a layer footprint, so a t-facing part in an outer layer sees its wall.
      p.faceAtWall = !two || p.layer === 'AB' || (p.layer === 'A' && p.face === 4) || (p.layer === 'B' && p.face === 5);
    } else {
      const edge = signOf(p.face) > 0 ? p.clearance.max[a] : p.clearance.min[a];
      const wallPos = signOf(p.face) > 0 ? interior[a] : 0;
      p.faceAtWall = Math.abs(edge - wallPos) < EPS;
    }
  }

  // ---- fillet margins: grow the interior where a part corner would hit the rounded inner edge
  const wall = prefs.wallThickness;
  const chamfer = prefs.edgeStyle === 'chamfer';
  const ri = Math.max(0, prefs.edgeRadius - wall);
  const mLo: Vec3 = [0, 0, 0];
  const mHi: Vec3 = [0, 0, 0];
  if (ri > 0) {
    for (const p of parts) {
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) {
          for (const sa of [0, 1]) {
            for (const sb of [0, 1]) {
              const da = sa ? interior[a] - p.body.max[a] : p.body.min[a];
              const db = sb ? interior[b] - p.body.max[b] : p.body.min[b];
              const push = filletPush(da, db, ri, chamfer);
              if (push <= 0) continue;
              if (sa) mHi[a] = Math.max(mHi[a], push);
              else mLo[a] = Math.max(mLo[a], push);
              if (sb) mHi[b] = Math.max(mHi[b], push);
              else mLo[b] = Math.max(mLo[b], push);
            }
          }
        }
      }
    }
    for (const p of parts) {
      for (let a = 0; a < 3; a++) {
        p.body.min[a] += mLo[a];
        p.body.max[a] += mLo[a];
        p.clearance.min[a] += mLo[a];
        p.clearance.max[a] += mLo[a];
      }
    }
    interior = [interior[0] + mLo[0] + mHi[0], interior[1] + mLo[1] + mHi[1], interior[2] + mLo[2] + mHi[2]];
  }
  const spine: [number, number] | undefined = hasB ? [node.tB + mLo[2], node.tB + s + mLo[2]] : undefined;

  // ---- vents
  const vs = VENT_STYLES.find((v) => v.id === prefs.ventStyleId) ?? VENT_STYLES[0];
  const allowed = allowedFaceDirs(cfg);
  const inset = Math.max(prefs.edgeRadius, 3);
  const vents: Vent[] = [];
  const addVent = (w: Dir, r: Rect, kind: VentKind, groupId?: string) => {
    const clipped = rectIntersect(r, wallRect(interior, w, kind === 'io' || kind === 'bracket' ? 0 : inset));
    if (clipped) vents.push({ wall: w, rect: clipped, kind, groupId });
  };
  const board = parts.find((p) => p.kind === 'board')!;
  const gpu = parts.find((p) => p.kind === 'gpu')!;
  const psu = parts.find((p) => p.kind === 'psu')!;
  const bs = boardStack(cfg, profile.extraGap);
  const bp = cfg.parts.board;
  const pcbOrigin: Vec3 = [board.body.min[0], board.body.min[1] + bs.pcbDv, board.body.min[2]];

  const cooler = cfg.parts.cooler;
  const coolerRect: Box = {
    min: [pcbOrigin[0] + bp.socketU - cooler.depth / 2, pcbOrigin[1] + bp.socketV - cooler.width / 2, pcbOrigin[2] + bs.surface],
    max: [pcbOrigin[0] + bp.socketU + cooler.depth / 2, pcbOrigin[1] + bp.socketV + cooler.width / 2, pcbOrigin[2] + bs.surface + bp.socketStack + cooler.height],
  };

  for (const p of parts) {
    if (p.face === undefined || !p.faceAtWall) continue;
    p.faceGap = faceGapOf(p, interior);
    if (!allowed.has(p.face)) {
      p.faceAtWall = false;
      continue;
    }
    const src = p.kind === 'board' ? coolerRect : p.body;
    const r = expand(projectBox(src, p.face), Math.min(p.faceGap, 20));
    if (p.mode === 'through') {
      addVent(p.face, r, 'through', p.id);
      addVent(opposite(p.face), expand(projectBox(src, opposite(p.face)), 5), 'through', p.id);
    } else if (p.kind === 'board') {
      if (cooler.kind === 'air-downdraft') addVent(p.face, r, 'fan', 'cpu');
    } else {
      addVent(p.face, r, 'fan', p.id);
    }
  }

  // Rear I/O and GPU bracket openings; PSU AC-end grille.
  const ioH = Math.min(bp.componentHeight, 44);
  addVent(1, { x0: pcbOrigin[1] + Math.max(0, bp.edge - 162), y0: pcbOrigin[2] + bs.surface - 3, x1: pcbOrigin[1] + bp.edge, y1: pcbOrigin[2] + bs.surface + ioH }, 'io');
  if (gpu.body.min[0] < EPS + mLo[0]) addVent(1, projectBox(gpu.body, 1), 'bracket');
  const acDir = opposite(psu.frame.d[0]);
  const acAtWall = (() => {
    const a = axisOf(acDir);
    const pos = signOf(acDir) > 0 ? psu.body.max[a] : psu.body.min[a];
    const w = signOf(acDir) > 0 ? interior[a] : 0;
    return Math.abs(pos - w) < cfg.prefs.tolerance + EPS + Math.max(mLo[a], mHi[a]);
  })();
  if (acAtWall) addVent(acDir, projectBox(psu.body, acDir), 'psu-exhaust', 'psu');

  // Passive perforation on the remaining free wall area.
  let freeTotal = 0;
  const freeByWall: { w: Dir; r: Rect }[] = [];
  for (const w of [0, 1, 2, 3, 4, 5] as Dir[]) {
    if (!allowed.has(w)) continue;
    let free: Rect[] = [wallRect(interior, w, inset)];
    for (const v of vents) {
      if (v.wall !== w) continue;
      free = free.flatMap((f) => rectSubtract(f, expand(v.rect, 4)));
    }
    for (const r of free) {
      if (r.x1 - r.x0 < 20 || r.y1 - r.y0 < 20) continue;
      freeByWall.push({ w, r });
      freeTotal += rectArea(r);
    }
  }
  // Spread the perforation evenly: every free patch is shrunk about its centre to the chosen coverage.
  let passiveArea = 0;
  const k = Math.sqrt(Math.max(0, Math.min(1, prefs.passiveVentCoverage)));
  if (k > 0 && freeTotal > 0) {
    for (const f of freeByWall) {
      const r = f.r;
      const cx = (r.x0 + r.x1) / 2;
      const cy = (r.y0 + r.y1) / 2;
      const hw = ((r.x1 - r.x0) * k) / 2;
      const hh = ((r.y1 - r.y0) * k) / 2;
      if (hw < 8 || hh < 8) continue;
      const pr = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
      vents.push({ wall: f.w, rect: pr, kind: 'passive' });
      passiveArea += rectArea(pr);
    }
  }

  // ---- airflow groups
  const zVent = perforatedPlateZeta(vs.openRatio) + (prefs.dustFilters ? advanced.dustFilterLossK : 0);
  const ventAreaFor = (groupId: string, w?: Dir) =>
    vents.filter((v) => v.groupId === groupId && (w === undefined || v.wall === w)).reduce((s2, v) => s2 + rectArea(v.rect), 0) * MM2;
  const prox = (gap: number, fan: FanSpec): number => {
    const q = fan.size / 4;
    return 1.5 * Math.max(0, 1 - gap / q) ** 2;
  };
  const fanArea = (fan: FanSpec, n: number) => n * fan.size * fan.size * MM2;

  const gpuSpec = cfg.parts.gpu;
  const psuSpec = cfg.parts.psu;
  const dcLoad = cooler.cpuPowerW + gpuSpec.boardPowerW + bp.heatW + cfg.parts.extras.reduce((a, e) => a + e.heatW, 0);
  const psuLoss = Math.min(dcLoad, psuSpec.ratedW) * (1 / Math.max(0.5, psuSpec.efficiency) - 1);

  const groupParts: Record<string, string> = {};
  const baseGroups: FanGroupInput[] = [];
  const radParts: PlacedPart[] = [];

  // CPU
  if (cooler.kind === 'air-downdraft') {
    const atWall = board.faceAtWall && vents.some((v) => v.groupId === 'cpu');
    const losses: LossTerm[] = [
      { label: 'fin stack', zeta: advanced.finStackLossK, area: cooler.width * cooler.depth * MM2 },
      { label: 'fan proximity', zeta: prox(atWall ? board.faceGap : 30, cooler.fan), area: fanArea(cooler.fan, 1) },
    ];
    if (atWall) losses.push({ label: 'vent', zeta: zVent, area: ventAreaFor('cpu') });
    baseGroups.push({
      id: 'cpu',
      label: 'CPU cooler',
      heatW: cooler.cpuPowerW,
      fan: cooler.fan,
      fanCount: 1,
      source: atWall ? 'outside' : 'case',
      sink: 'case',
      losses,
      isRadiator: false,
    });
    groupParts.cpu = 'board';
    board.airflow = atWall ? 'in' : 'internal';
  } else if (cooler.kind === 'air-tower') {
    baseGroups.push({
      id: 'cpu',
      label: 'CPU cooler',
      heatW: cooler.cpuPowerW,
      fan: cooler.fan,
      fanCount: 1,
      source: 'case',
      sink: 'case',
      losses: [{ label: 'fin stack', zeta: advanced.finStackLossK, area: cooler.width * cooler.height * MM2 }],
      isRadiator: false,
    });
    groupParts.cpu = 'board';
    board.airflow = 'internal';
  }

  // GPU card fan
  const gpuCardHeat = gpuSpec.cooling === 'aio' ? gpuSpec.boardPowerW * (1 - gpuSpec.radiatorHeatShare) : gpuSpec.boardPowerW;
  let internalHeat = bp.heatW + cfg.parts.extras.reduce((a, e) => a + e.heatW, 0);
  if (gpuSpec.cardFan) {
    const atWall = gpu.faceAtWall && vents.some((v) => v.groupId === 'gpu');
    const losses: LossTerm[] = [
      { label: 'shroud', zeta: 3, area: fanArea(gpuSpec.cardFanSpec, 1) },
      { label: 'fan proximity', zeta: prox(atWall ? gpu.faceGap : 30, gpuSpec.cardFanSpec), area: fanArea(gpuSpec.cardFanSpec, 1) },
    ];
    if (atWall) losses.push({ label: 'vent', zeta: zVent, area: ventAreaFor('gpu') });
    baseGroups.push({
      id: 'gpu-card',
      label: gpuSpec.cooling === 'aio' ? 'GPU card (VRM/VRAM fan)' : 'GPU cooler',
      heatW: gpuCardHeat,
      fan: gpuSpec.cardFanSpec,
      fanCount: 1,
      source: atWall ? 'outside' : 'case',
      sink: 'case',
      losses,
      isRadiator: false,
    });
    groupParts['gpu-card'] = 'gpu';
    gpu.airflow = atWall ? 'in' : 'internal';
  } else {
    internalHeat += gpuCardHeat;
  }

  // PSU
  {
    const faceAtWall = psuSpec.fanOn === 'face' && psu.faceAtWall && vents.some((v) => v.groupId === 'psu' && v.kind === 'fan');
    const losses: LossTerm[] = [{ label: 'PSU internals', zeta: advanced.psuLossK, area: fanArea(psuSpec.fan, 1) }];
    if (faceAtWall) {
      losses.push({ label: 'intake vent', zeta: zVent, area: ventAreaFor('psu', psu.face) });
      losses.push({ label: 'fan proximity', zeta: prox(psu.faceGap, psuSpec.fan), area: fanArea(psuSpec.fan, 1) });
    }
    if (acAtWall) losses.push({ label: 'AC-end grille', zeta: perforatedPlateZeta(0.6), area: ventAreaFor('psu', acDir) });
    baseGroups.push({
      id: 'psu',
      label: 'Power supply',
      heatW: psuLoss,
      fan: psuSpec.fan,
      fanCount: 1,
      source: faceAtWall ? 'outside' : 'case',
      sink: acAtWall ? 'outside' : 'case',
      losses,
      isRadiator: false,
    });
    groupParts.psu = 'psu';
    psu.airflow = faceAtWall && acAtWall ? 'through' : faceAtWall ? 'in' : acAtWall ? 'out' : 'internal';
  }

  // Radiators (direction decided below)
  const radHeat: Record<string, number> = {
    'rad-cpu': cooler.kind === 'aio' ? cooler.cpuPowerW : 0,
    'rad-gpu': gpuSpec.cooling === 'aio' ? gpuSpec.boardPowerW * gpuSpec.radiatorHeatShare : 0,
  };
  for (const p of parts) if (p.kind === 'rad-cpu' || p.kind === 'rad-gpu') radParts.push(p);

  const radGroup = (p: PlacedPart, dir: 'in' | 'out' | 'through'): FanGroupInput => {
    const rad = p.radiator!;
    const fan = p.fan!;
    const coreArea = rad.length * rad.width * MM2;
    const losses: LossTerm[] = [
      { label: 'radiator core', zeta: advanced.radLossK * (rad.coreThickness / 27), area: coreArea },
      { label: 'fan proximity', zeta: prox(p.faceAtWall ? p.faceGap : 0, fan), area: fanArea(fan, p.fanCount!) },
    ];
    if (p.faceAtWall) losses.push({ label: 'vent', zeta: zVent, area: ventAreaFor(p.id, p.face) });
    else losses.push({ label: 'blocked face', zeta: 40, area: coreArea });
    if (dir === 'through') {
      losses.push({ label: 'far vent', zeta: perforatedPlateZeta(vs.openRatio), area: ventAreaFor(p.id, opposite(p.face!)) || coreArea });
    } else {
      const plen = cfg.advanced.radPlenumGap + profile.extraGap;
      const perim = 2 * (rad.length + rad.width);
      losses.push({ label: 'plenum', zeta: 1, area: Math.min(coreArea, perim * plen * MM2) });
    }
    return {
      id: p.id,
      label: p.kind === 'rad-cpu' ? 'CPU radiator' : 'GPU radiator',
      heatW: radHeat[p.id],
      fan,
      fanCount: p.fanCount!,
      source: dir === 'out' ? 'case' : 'outside',
      sink: dir === 'in' ? 'case' : 'outside',
      losses,
      isRadiator: true,
    };
  };

  const wallRads = radParts.filter((p) => p.mode !== 'through');
  const pref = prefs.radDirection;
  const combos: ('in' | 'out')[][] = [];
  const n = wallRads.length;
  for (let m = 0; m < 1 << n; m++) {
    const c = wallRads.map((_, i) => ((m >> i) & 1 ? 'out' : 'in') as 'in' | 'out');
    if (pref === 'intake' && c.some((x) => x !== 'in')) continue;
    if (pref === 'exhaust' && c.some((x) => x !== 'out')) continue;
    combos.push(c);
  }
  if (combos.length === 0) combos.push([]);
  let best: { flow: FlowResult; dirs: ('in' | 'out')[] } | null = null;
  const passiveZeta = perforatedPlateZeta(vs.openRatio) + (prefs.dustFilters ? advanced.dustFilterLossK : 0);
  for (const c of combos) {
    const groups = [...baseGroups];
    for (const p of radParts) {
      const i = wallRads.indexOf(p);
      groups.push(radGroup(p, i < 0 ? 'through' : c[i]));
    }
    const flow = solveFlow({
      groups,
      internalHeatW: internalHeat,
      passiveArea: passiveArea * MM2,
      passiveZeta,
      ambientC: prefs.ambientC,
      targetRiseC: prefs.targetRiseC,
      radEffectiveness: advanced.radEffectiveness,
    });
    if (!best || flow.score > best.flow.score + 1e-9) best = { flow, dirs: c };
  }
  const flow = best!.flow;
  for (const p of radParts) {
    const i = wallRads.indexOf(p);
    p.airflow = i < 0 ? 'through' : best!.dirs[i];
    groupParts[p.id] = p.id;
  }
  for (const v of vents) {
    if (!v.groupId) continue;
    const g = flow.groups.find((x) => x.id === v.groupId || (v.groupId === 'gpu' && x.id === 'gpu-card'));
    if (!g) continue;
    if (v.kind === 'psu-exhaust') v.flow = 'out';
    else if (v.kind === 'through') v.flow = v.wall === parts.find((p) => p.id === v.groupId)?.face ? 'out' : 'in';
    else v.flow = g.source === 'outside' ? 'in' : 'out';
  }

  // ---- checks
  const checks: Check[] = [];
  if (!isDirectTopo(topology)) {
    const slot: Vec3 = [pcbOrigin[0] + 90, pcbOrigin[1] + bp.slotV, pcbOrigin[2] + bs.surface];
    const fingers = localToWorld(gpu.frame, gpu.body, [90, 0, gpuSpec.thickness * 0.3]);
    const path = Math.abs(slot[0] - fingers[0]) + Math.abs(slot[1] - fingers[1]) + Math.abs(slot[2] - fingers[2]) + 30;
    if (path > prefs.riserLength) {
      checks.push({ level: 'error', text: `Riser path ≈ ${Math.round(path)} mm, longer than the ${prefs.riserLength} mm riser.` });
    } else {
      checks.push({ level: 'ok', text: `Riser path ≈ ${Math.round(path)} mm fits the ${prefs.riserLength} mm riser.` });
    }
  }
  const tubeCheck = (label: string, from: Vec3, rad: PlacedPart | undefined, length: number | undefined) => {
    if (!rad || !length) return;
    const r = rad.radiator!;
    const port = localToWorld(rad.frame, rad.body, [r.length, r.width / 2, r.coreThickness / 2]);
    const d = Math.abs(from[0] - port[0]) + Math.abs(from[1] - port[1]) + Math.abs(from[2] - port[2]) + 40;
    checks.push(
      d > length
        ? { level: 'error', text: `${label} tubes need ≈ ${Math.round(d)} mm, only ${length} mm available.` }
        : { level: 'ok', text: `${label} tube run ≈ ${Math.round(d)} mm of ${length} mm.` },
    );
  };
  if (cooler.kind === 'aio') {
    const pump: Vec3 = [pcbOrigin[0] + bp.socketU, pcbOrigin[1] + bp.socketV, pcbOrigin[2] + bs.surface + bp.socketStack + cooler.height / 2];
    tubeCheck('CPU AIO', pump, parts.find((p) => p.kind === 'rad-cpu'), cooler.tubeLength);
  }
  if (gpuSpec.cooling === 'aio') {
    const exit =
      gpuSpec.tubeExit === 'end'
        ? localToWorld(gpu.frame, gpu.body, [gpuSpec.length, gpuSpec.height / 2, gpuSpec.thickness / 2])
        : localToWorld(gpu.frame, gpu.body, [gpuSpec.length * 0.6, gpuSpec.height, gpuSpec.thickness / 2]);
    tubeCheck('GPU AIO', exit, parts.find((p) => p.kind === 'rad-gpu'), gpuSpec.tubeLength);
  }
  if (!acAtWall) checks.push({ level: 'info', text: 'PSU AC inlet is inside the case — route it to the back with a short internal extension cable (common in small cases).' });
  if (bs.coolerOverhangsRear) checks.push({ level: 'warn', text: 'CPU cooler overhangs the rear edge of the board.' });
  for (const p of radParts) {
    if (!p.faceAtWall) checks.push({ level: 'error', text: `${p.label} fans do not reach a vented panel.` });
  }
  if (psuSpec.fanOn === 'face' && !psu.faceAtWall) checks.push({ level: 'info', text: 'PSU fan draws warm case air (fan does not face a panel).' });
  if (gpuSpec.cardFan && !gpu.faceAtWall) checks.push({ level: 'info', text: 'GPU card fan draws case air (does not face a panel).' });

  // ---- exterior, world mapping
  const exterior: Vec3 = [interior[0] + 2 * wall, interior[1] + 2 * wall, interior[2] + 2 * wall];
  const bottomWall: Dir = prefs.orientation === 'tower' ? 3 : 5;
  const feet = vents.some((v) => v.wall === bottomWall && v.kind !== 'io') ? prefs.feetHeight : 0;
  const world =
    prefs.orientation === 'tower'
      ? { width: exterior[2], height: exterior[1] + feet, depth: exterior[0] }
      : { width: exterior[1], height: exterior[2] + feet, depth: exterior[0] };
  const limits: [string, number, number][] = [
    ['width', world.width, prefs.maxWidth],
    ['height', world.height, prefs.maxHeight],
    ['depth', world.depth, prefs.maxDepth],
  ];
  for (const [name, val, lim] of limits) {
    if (lim > 0 && val > lim + 0.5) checks.push({ level: 'error', text: `External ${name} ${Math.round(val)} mm exceeds your ${lim} mm limit.` });
  }

  const volumeMm3 = roundedBoxVolume(exterior[0], exterior[1], exterior[2], prefs.edgeRadius, chamfer);
  const surface = 2 * (exterior[0] * exterior[1] + exterior[1] * exterior[2] + exterior[0] * exterior[2]);
  const openArea = vents.reduce((a, v) => a + rectArea(v.rect) * (v.kind === 'io' || v.kind === 'bracket' ? 1 : vs.openRatio), 0);
  const mat = MATERIALS.find((m) => m.id === prefs.materialId) ?? MATERIALS[0];
  const weightKg = (Math.max(0, surface - openArea) * wall * mat.densityGcm3) / 1e6;

  const worst = flow.worstAdequacy;
  const limited = worst < prefs.minAirflowAdequacy;
  if (limited) {
    checks.push({
      level: 'warn',
      text: `Weakest heat path gets ${Math.round(worst * 100)}% of the airflow it needs (your floor is ${Math.round(prefs.minAirflowAdequacy * 100)}%).`,
    });
  }

  return {
    id: `${topology}-${profile.id}-${index}`,
    topology,
    effectiveTopology: two && !hasB ? (topology === 'sandwich' ? 'flat' : 'direct') : topology,
    profile,
    interior,
    wall,
    exterior,
    feet,
    bottomWall,
    world,
    thickness: Math.min(world.width, world.height, world.depth),
    volumeL: volumeMm3 / 1e6,
    weightKg,
    parts,
    vents,
    spine,
    flow,
    groupParts,
    checks,
    invalid: checks.some((c) => c.level === 'error'),
    limited,
    cost: 0,
    compactCost: 0,
    tags: [],
  };
}

const isDirectTopo = (t: TopologyId) => t === 'direct' || t === 'direct-stack';
