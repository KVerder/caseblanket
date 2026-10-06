import { SLIM_RAD_FAN } from '../model/presets';
import { DEEP_PLENUM } from './flow';
import { TILT_ANGLES, TILT_PLATE, tiltDims, type Tilt } from './tilt';
import type { DesignConfig, FanSpec, RadiatorSpec, TopologyId } from '../model/types';
import {
  allFrames,
  axisOf,
  crossDir,
  IDENTITY,
  localToWorld,
  orient,
  sideToWorld,
  type Box,
  type Clearance,
  type Dir,
  type Frame,
  type Oriented,
  type Vec3,
} from './geometry';

export type LayerId = 'M' | 'A' | 'B' | 'AB';
export const LAYER_BITS: Record<LayerId, number> = { M: 1, A: 1, B: 2, AB: 3 };

export type ItemKind = 'board' | 'gpu' | 'psu' | 'rad-cpu' | 'rad-gpu' | 'case-fan' | 'extra';

export interface Profile {
  id: string;
  label: string;
  /** Added to every fan gap and radiator plenum. */
  extraGap: number;
  /** Swap 120 mm radiator fans for 15 mm slim fans. */
  slim: boolean;
}

export const PROFILES: Profile[] = [
  { id: 'tight', label: 'Tight gaps', extraGap: 0, slim: false },
  { id: 'balanced', label: 'Balanced gaps', extraGap: 6, slim: false },
  { id: 'open', label: 'Generous gaps', extraGap: 12, slim: false },
  { id: 'tight-slim', label: 'Tight gaps, slim radiator fans', extraGap: 0, slim: true },
  { id: 'balanced-slim', label: 'Balanced gaps, slim radiator fans', extraGap: 6, slim: true },
];

export interface VariantPart {
  kind: ItemKind;
  o: Oriented;
  /** Offset of this part's clearance box inside the variant footprint. */
  du: number;
  dv: number;
  align: 'low' | 'high';
  /** World direction of the fan face, if the part has one. */
  face?: Dir;
  faceRequired: boolean;
  faceGap: number;
  /** Radiators and case fans. */
  mode?: 'through' | 'wall';
  fan?: FanSpec;
  fanCount?: number;
  radiator?: RadiatorSpec;
  /** Tilted against its panel (radiators and case fans on a wall). */
  tilt?: Tilt;
}

export interface Variant {
  layer: LayerId;
  bits: number;
  parts: VariantPart[];
  w: number;
  h: number;
  rearAnchor: boolean;
  /** In-plane walls this variant must sit against (fan faces). */
  commits: Dir[];
  minT: number;
  /** Riser endpoints in variant footprint coordinates: board x16 slot, card PCIe fingers. */
  riserSlot?: [number, number];
  riserFinger?: [number, number];
}

export interface ItemDef {
  id: string;
  kind: ItemKind;
  label: string;
  variants: Variant[];
  minArea: number;
  minT: number;
}

export interface BuildContext {
  cfg: DesignConfig;
  topology: TopologyId;
  profile: Profile;
}

/** Distance from the rear edge / bracket to the centre of the x16 slot and fingers (typical). */
export const RISER_U = 90;

export const isTwoLayer = (t: TopologyId) => t === 'sandwich' || t === 'direct-stack';
export const isDirect = (t: TopologyId) => t === 'direct' || t === 'direct-stack';

/** Board + cooler stack height and the cooler's footprint, shared by solver and renderer. */
export function boardStack(cfg: DesignConfig, extraGap: number) {
  const { board, cooler } = cfg.parts;
  const surface = board.underside + board.pcbThickness;
  const coolerTop = board.socketStack + cooler.height;
  const bodyAbovePcb = Math.max(board.componentHeight, coolerTop);
  const needAbovePcb = Math.max(
    board.componentHeight,
    coolerTop + (cooler.kind === 'air-downdraft' ? cfg.advanced.coolerFanGap + extraGap : 1),
  );
  const coolerFoot = cooler.kind === 'aio' ? { du: cooler.depth, dv: cooler.width } : { du: cooler.depth, dv: cooler.width };
  // Footprint may grow where the cooler overhangs the PCB (never past the rear edge).
  const cu0 = board.socketU - coolerFoot.du / 2;
  const cu1 = board.socketU + coolerFoot.du / 2;
  const cv0 = board.socketV - coolerFoot.dv / 2;
  const cv1 = board.socketV + coolerFoot.dv / 2;
  const padV0 = Math.max(0, -cv0);
  return {
    surface,
    bodyT: surface + bodyAbovePcb,
    topClear: needAbovePcb - bodyAbovePcb,
    depth: Math.max(board.depth, cu1),
    edge: Math.max(board.edge, cv1) + padV0,
    /** PCB offset (v) inside the footprint when the cooler overhangs the bottom edge. */
    pcbDv: padV0,
    coolerOverhangsRear: cu0 < 0,
  };
}

function withTol(clears: Clearance[], tol: number, exempt: Dir[] = []): Clearance[] {
  const out: Clearance[] = [];
  for (let s = 0 as Dir; s < 6; s = (s + 1) as Dir) {
    const own = clears.filter((c) => c.side === s).reduce((m, c) => Math.max(m, c.depth), 0);
    out.push({ side: s, depth: exempt.includes(s) ? own : Math.max(own, tol) });
  }
  return out;
}

function alignFor(layer: LayerId, face: Dir | undefined): 'low' | 'high' {
  if (face === 4) return 'high';
  if (face === 5) return 'low';
  return layer === 'B' ? 'high' : 'low';
}

/** Is a fan face direction physically allowed for this layer? (never into the spine) */
function faceAllowed(layer: LayerId, face: Dir): boolean {
  if (layer === 'A') return face !== 5;
  if (layer === 'B') return face !== 4;
  return true;
}

function makeVariant(layer: LayerId, parts: VariantPart[], rearAnchor: boolean): Variant {
  let minU = Infinity;
  let minV = Infinity;
  for (const p of parts) {
    minU = Math.min(minU, p.du);
    minV = Math.min(minV, p.dv);
  }
  let w = 0;
  let h = 0;
  let minT = 0;
  const commits: Dir[] = [];
  for (const p of parts) {
    p.du -= minU;
    p.dv -= minV;
    w = Math.max(w, p.du + p.o.ext[0]);
    h = Math.max(h, p.dv + p.o.ext[1]);
    minT = Math.max(minT, p.o.ext[2]);
    if (p.faceRequired && p.face !== undefined && axisOf(p.face) !== 2 && !commits.includes(p.face)) commits.push(p.face);
  }
  return { layer, bits: LAYER_BITS[layer], parts, w, h, rearAnchor, commits, minT };
}

function signature(v: Variant): string {
  return (
    v.layer +
    '|' +
    v.parts
      .map((p) => `${p.o.ext.map((x) => x.toFixed(1)).join(',')}/${p.face ?? '-'}/${p.mode ?? ''}/${p.o.frame.d.join('')}`)
      .join(';')
  );
}

function dedupe(vs: Variant[], keyFn: (v: Variant) => string = signature): Variant[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const k = keyFn(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function finish(id: string, kind: ItemKind, label: string, variants: Variant[]): ItemDef {
  return {
    id,
    kind,
    label,
    variants,
    minArea: variants.reduce((m, v) => Math.min(m, v.w * v.h), Infinity),
    minT: variants.reduce((m, v) => Math.min(m, v.minT), Infinity),
  };
}

/** Panels the user allows vents on, as solver directions. */
export function allowedFaceDirs(cfg: DesignConfig): Set<Dir> {
  const p = cfg.prefs.ventPanels;
  const set = new Set<Dir>();
  if (p.front) set.add(0);
  if (p.back) set.add(1);
  if (cfg.prefs.orientation === 'tower') {
    // x = -t, y = v, z = u
    if (p.top) set.add(2);
    if (p.bottom) set.add(3);
    if (p.left) set.add(4);
    if (p.right) set.add(5);
  } else {
    // x = v, y = t, z = u
    if (p.right) set.add(2);
    if (p.left) set.add(3);
    if (p.top) set.add(4);
    if (p.bottom) set.add(5);
  }
  return set;
}

// ------------------------------------------------------------------ builders

function boardParts(ctx: BuildContext): VariantPart {
  const { cfg, profile } = ctx;
  const tol = cfg.prefs.tolerance / 2;
  const s = boardStack(cfg, profile.extraGap);
  const size: Vec3 = [s.depth, s.edge, s.bodyT];
  const clears = withTol([{ side: 4, depth: s.topClear }], tol, [1]);
  const o = orient(size, IDENTITY, clears);
  return {
    kind: 'board',
    o,
    du: 0,
    dv: 0,
    align: 'low',
    face: cfg.parts.cooler.kind === 'air-downdraft' ? 4 : undefined,
    faceRequired: false,
    faceGap: cfg.advanced.coolerFanGap + profile.extraGap,
  };
}

function gpuClearances(ctx: BuildContext, direct: boolean): Clearance[] {
  const { cfg, profile } = ctx;
  const g = cfg.parts.gpu;
  const aio = g.cooling === 'aio';
  const tol = cfg.prefs.tolerance / 2;
  const clears: Clearance[] = [
    { side: 0, depth: aio && g.tubeExit === 'end' ? g.tubeClearance : 0 },
    { side: 2, depth: Math.max(g.connectorClearance, aio && g.tubeExit === 'top' ? g.tubeClearance : 0) },
    { side: 4, depth: g.cardFan ? cfg.advanced.cardFanGap + profile.extraGap : 0 },
  ];
  if (direct) {
    const s = boardStack(cfg, profile.extraGap);
    // Fingers sit in the slot: the card starts at the PCB surface.
    clears.push({ side: 3, depth: s.surface });
    return withTol(clears, tol, [1, 3]);
  }
  // Riser plug + cable bend at the fingers edge (estimate).
  clears.push({ side: 3, depth: 15 });
  return withTol(clears, tol, [1]);
}

function gpuVariants(ctx: BuildContext, layers: LayerId[]): Variant[] {
  const g = ctx.cfg.parts.gpu;
  const size: Vec3 = [g.length, g.height, g.thickness];
  const clears = gpuClearances(ctx, false);
  const out: Variant[] = [];
  for (const d2 of [2, 3, 4, 5] as Dir[]) {
    const frame: Frame = { d: [0, d2, crossDir(0, d2)] };
    const o = orient(size, frame, clears);
    const face = sideToWorld(frame, 4);
    for (const layer of layers) {
      if (!faceAllowed(layer, face)) continue;
      const v = makeVariant(
        layer,
        [{ kind: 'gpu', o, du: 0, dv: 0, align: alignFor(layer, face), face, faceRequired: false, faceGap: ctx.cfg.advanced.cardFanGap }],
        true,
      );
      const body: Box = { min: [o.off[0], o.off[1], o.off[2]], max: [o.off[0] + o.body[0], o.off[1] + o.body[1], o.off[2] + o.body[2]] };
      const f = localToWorld(frame, body, [RISER_U, 0, g.thickness * 0.3]);
      v.riserFinger = [f[0], f[1]];
      out.push(v);
    }
  }
  return out;
}

function directGroupVariant(ctx: BuildContext, layer: LayerId): Variant {
  const { cfg } = ctx;
  const g = cfg.parts.gpu;
  const board = boardParts(ctx);
  const s = boardStack(cfg, ctx.profile.extraGap);
  // Card plugged straight in: length along +u, height up (+t), cooler facing -v (down, away from the socket).
  const frame: Frame = { d: [0, 4, crossDir(0, 4)] };
  const clears = gpuClearances(ctx, true);
  const o = orient([g.length, g.height, g.thickness], frame, clears);
  // PCB (backplate side) sits ~5 mm above the slot centre line; the cooler hangs below it.
  const cardTopV = s.pcbDv + cfg.parts.board.slotV + 5;
  // Put the card body's top (+v) edge at cardTopV: body spans [dv+off, dv+off+body].
  const card: VariantPart = {
    kind: 'gpu',
    o,
    du: 0,
    dv: cardTopV - o.off[1] - o.body[1],
    align: 'low',
    face: sideToWorld(frame, 4),
    faceRequired: false,
    faceGap: cfg.advanced.cardFanGap,
  };
  return makeVariant(layer, [board, card], true);
}

function oriented24(
  size: Vec3,
  clears: (frame: Frame) => Clearance[],
  build: (o: Oriented, frame: Frame) => void,
) {
  for (const frame of allFrames()) build(orient(size, frame, clears(frame)), frame);
}

/** Room in front of a PSU inlet inside the case for a right-angle C13 plug, mm (typical ~18). */
export const PSU_PLUG_ROOM = 20;

function psuVariants(ctx: BuildContext, layers: LayerId[]): Variant[] {
  const { cfg, profile } = ctx;
  const p = cfg.parts.psu;
  const tol = cfg.prefs.tolerance / 2;
  const fanGap = cfg.advanced.psuFanGap + profile.extraGap;
  const clears = withTol(
    [
      { side: 0, depth: p.fanOn === 'end' ? Math.max(p.cableClearance, fanGap) : p.cableClearance },
      { side: 4, depth: p.fanOn === 'face' ? fanGap : 0 },
      // Inlet inside the case (fed by an IEC extension): room for a right-angle C13 plug.
      { side: 1, depth: cfg.prefs.psuInletAtBack ? 0 : PSU_PLUG_ROOM },
    ],
    tol,
  );
  const out: Variant[] = [];
  oriented24(
    [p.length, p.width, p.height],
    () => clears,
    (o, frame) => {
      if (cfg.prefs.psuInletAtBack && sideToWorld(frame, 1) !== 1) return;
      // End-fan PSUs (Flex ATX, TFX) breathe through the cable end: no panel face needed.
      const face = p.fanOn === 'face' ? sideToWorld(frame, 4) : undefined;
      for (const layer of layers) {
        if (face !== undefined && !faceAllowed(layer, face)) continue;
        out.push(
          makeVariant(layer, [{ kind: 'psu', o, du: 0, dv: 0, align: alignFor(layer, face), face, faceRequired: false, faceGap: fanGap }], cfg.prefs.psuInletAtBack),
        );
      }
    },
  );
  // Frames that differ only by a mirror of the featureless e2 axis give identical boxes.
  return dedupe(out, (v) => `${v.layer}|${v.parts[0].o.ext.join(',')}|${v.parts[0].face}|${sideToWorld(v.parts[0].o.frame, 0)}`);
}

/** Clearance depths along a part's own axes (side 0/1 = ±e1, 2/3 = ±e2, 4/5 = ±e3). */
function localClear(clears: Clearance[]): { lo: Vec3; hi: Vec3 } {
  const d = (side: number) => clears.filter((c) => c.side === side).reduce((m, c) => Math.max(m, c.depth), 0);
  return { lo: [d(1), d(3), d(5)], hi: [d(0), d(2), d(4)] };
}

/** Tilt angles to try against a panel (flat only, unless tilting is allowed). */
function tiltsFor(cfg: DesignConfig): number[] {
  return cfg.prefs.allowTilt === false ? [0] : TILT_ANGLES;
}

function radVariants(
  ctx: BuildContext,
  kind: 'rad-cpu' | 'rad-gpu',
  rad: RadiatorSpec,
  layers: LayerId[],
  allowed: Set<Dir>,
): Variant[] {
  const { cfg, profile } = ctx;
  const tol = cfg.prefs.tolerance / 2;
  const fan = profile.slim && rad.fan.size === 120 ? SLIM_RAD_FAN : rad.fan;
  const size: Vec3 = [rad.length, rad.width, rad.coreThickness + fan.thickness];
  const wallGap = cfg.advanced.radWallGap + profile.extraGap / 2;
  const plenum = cfg.advanced.radPlenumGap + profile.extraGap + (cfg.prefs.flow?.deepPlenums ? DEEP_PLENUM : 0);
  const out: Variant[] = [];
  for (const frame of allFrames()) {
    const face = sideToWorld(frame, 4);
    if (!allowed.has(face)) continue;
    for (const layer of layers) {
      if (!faceAllowed(layer, face)) continue;
      const through = (layer === 'M' || layer === 'AB') && axisOf(face) === 2 && allowed.has((face ^ 1) as Dir);
      const clears = withTol(
        [
          { side: 0, depth: rad.portClearance },
          { side: 4, depth: wallGap },
          { side: 5, depth: through ? 0 : plenum },
        ],
        tol,
        [4],
      );
      for (const deg of through ? [0] : tiltsFor(cfg)) {
        const tilt: Tilt | undefined = deg > 0 ? { deg, size: [size[0], size[1], size[2] + TILT_PLATE], clear: localClear(clears) } : undefined;
        const o = orient(tilt ? tiltDims(tilt.size, deg) : size, frame, clears);
        out.push(
          makeVariant(
            layer,
            [
              {
                kind,
                o,
                du: 0,
                dv: 0,
                align: alignFor(layer, face),
                face,
                faceRequired: true,
                faceGap: wallGap,
                mode: through ? 'through' : 'wall',
                fan,
                fanCount: rad.fanCount,
                radiator: rad,
                tilt,
              },
            ],
            face === 1,
          ),
        );
      }
    }
  }
  return dedupe(out, (v) => `${v.layer}|${v.parts[0].o.ext.join(',')}|${v.parts[0].face}|${sideToWorld(v.parts[0].o.frame, 0)}|${v.parts[0].tilt?.deg ?? 0}`);
}

/** A case fan screwed to a vented panel, with a plenum behind it like a radiator's. */
function caseFanVariants(ctx: BuildContext, fan: FanSpec, layers: LayerId[], allowed: Set<Dir>): Variant[] {
  const { cfg, profile } = ctx;
  const tol = cfg.prefs.tolerance / 2;
  const size: Vec3 = [fan.size, fan.size, fan.thickness];
  const wallGap = cfg.advanced.radWallGap + profile.extraGap / 2;
  const plenum = cfg.advanced.radPlenumGap + profile.extraGap + (cfg.prefs.flow?.deepPlenums ? DEEP_PLENUM : 0);
  const clears = withTol(
    [
      { side: 4, depth: wallGap },
      { side: 5, depth: plenum },
    ],
    tol,
    [4],
  );
  const out: Variant[] = [];
  for (const frame of allFrames()) {
    const face = sideToWorld(frame, 4);
    if (!allowed.has(face)) continue;
    for (const deg of tiltsFor(cfg)) {
      const tilt: Tilt | undefined = deg > 0 ? { deg, size: [size[0], size[1], size[2] + TILT_PLATE], clear: localClear(clears) } : undefined;
      const o = orient(tilt ? tiltDims(tilt.size, deg) : size, frame, clears);
      for (const layer of layers) {
        if (!faceAllowed(layer, face)) continue;
        out.push(
          makeVariant(
            layer,
            [{ kind: 'case-fan', o, du: 0, dv: 0, align: alignFor(layer, face), face, faceRequired: true, faceGap: wallGap, mode: 'wall', fan, fanCount: 1, tilt }],
            face === 1,
          ),
        );
      }
    }
  }
  // A square fan looks the same turned about its axis (untilted).
  return dedupe(out, (v) => `${v.layer}|${v.parts[0].o.ext.join(',')}|${v.parts[0].face}|${v.parts[0].tilt ? sideToWorld(v.parts[0].o.frame, 0) : ''}|${v.parts[0].tilt?.deg ?? 0}`);
}

function extraVariants(ctx: BuildContext, e: { x: number; y: number; z: number }, layers: LayerId[]): Variant[] {
  const tol = ctx.cfg.prefs.tolerance / 2;
  const clears = withTol([], tol);
  const out: Variant[] = [];
  oriented24(
    [e.x, e.y, e.z],
    () => clears,
    (o) => {
      for (const layer of layers) {
        out.push(makeVariant(layer, [{ kind: 'extra', o, du: 0, dv: 0, align: alignFor(layer, undefined), faceRequired: false, faceGap: 0 }], false));
      }
    },
  );
  return dedupe(out, (v) => `${v.layer}|${v.parts[0].o.ext.join(',')}`);
}

export function buildItems(ctx: BuildContext): ItemDef[] {
  const { cfg, topology } = ctx;
  const two = isTwoLayer(topology);
  const inner: LayerId[] = two ? ['A'] : ['M'];
  const any: LayerId[] = two ? ['A', 'B', 'AB'] : ['M'];
  const allowed = allowedFaceDirs(cfg);
  const items: ItemDef[] = [];

  if (isDirect(topology)) {
    items.push(finish('board', 'board', 'Motherboard + GPU', [directGroupVariant(ctx, inner[0])]));
  } else {
    const b = boardParts(ctx);
    const bv = makeVariant(inner[0], [b], true);
    const bs = boardStack(cfg, ctx.profile.extraGap);
    bv.riserSlot = [b.o.off[0] + RISER_U, b.o.off[1] + bs.pcbDv + cfg.parts.board.slotV];
    items.push(finish('board', 'board', 'Motherboard', [bv]));
    // A sandwich puts the card behind the board; the card-beside-board case is the flat family.
    items.push(finish('gpu', 'gpu', 'Graphics card', gpuVariants(ctx, topology === 'sandwich' ? ['B', 'AB'] : any)));
  }
  items.push(finish('psu', 'psu', 'Power supply', psuVariants(ctx, any)));
  const { cooler, gpu } = cfg.parts;
  if (cooler.kind === 'aio' && cooler.radiator) {
    items.push(finish('rad-cpu', 'rad-cpu', 'CPU radiator', radVariants(ctx, 'rad-cpu', cooler.radiator, any, allowed)));
  }
  if (gpu.cooling === 'aio' && gpu.radiator) {
    items.push(finish('rad-gpu', 'rad-gpu', 'GPU radiator', radVariants(ctx, 'rad-gpu', gpu.radiator, any, allowed)));
  }
  const caseFans = cfg.parts.caseFans;
  for (let i = 0; i < Math.min(2, caseFans?.count ?? 0); i++) {
    items.push(finish(`fan-${i + 1}`, 'case-fan', `Case fan ${i + 1}`, caseFanVariants(ctx, caseFans.fan, any, allowed)));
  }
  for (const e of cfg.parts.extras) {
    items.push(finish(`extra-${e.id}`, 'extra', e.name, extraVariants(ctx, e, any)));
  }
  return items;
}
