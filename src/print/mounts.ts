import type { DesignConfig, MotherboardSpec, PsuSpec } from '../model/types';
import type { Design, PlacedPart } from '../solver/evaluate';
import { axisOf, localToWorld, opposite, signOf, wallAxes, type Dir, type Vec3 } from '../solver/geometry';
import { boardStack } from '../solver/items';
import { shellField, type ShellMesh } from '../solver/shrinkwrap';

/**
 * Mounting points, so the printed case can be built as it comes off the printer.
 *
 * Sources (opened 2026-10-01): NopSCADlib, github.com/nophead/NopSCADlib — vitamins/fans.scad
 * (120 mm fan hole pitch 52.5 mm from centre, 80 mm 35.75 mm), vitamins/psus.scad (ATX PSU face
 * holes, #6-32 screws), vitamins/inserts.scad (M3 heat-set insert F1BM3: 4.0 mm hole, 5.8 mm long).
 * Marked UNVERIFIED: values from memory where no source could be opened (the spec sites were
 * blocked from the build environment). Print the fit-test plates before the case.
 */

export interface Source {
  text: string;
  verified: boolean;
}

const NOP: Source = { text: 'NopSCADlib (github.com/nophead/NopSCADlib)', verified: true };
const MEMORY: Source = { text: 'typical value, not checked against a spec — print the fit test first', verified: false };

/** M3 brass heat-set insert (NopSCADlib F1BM3). */
export const INSERT = { holeD: 4.0, length: 5.8, bossD: 9, source: NOP };

/**
 * Mini-ITX mounting holes (u from the rear-I/O edge, v from the bottom/slot edge, mm): the ATX
 * holes C, F, H, J — 154.94 mm (6.10 in) apart along u, 157.48 mm (6.20 in) along v, one offset
 * 22.86 mm (0.90 in). UNVERIFIED.
 */
const ITX_HOLES: [number, number][] = [
  [10.16, 6.35],
  [10.16, 163.83],
  [165.1, 33.02],
  [165.1, 163.83],
];

/** Board holes: the board's own list, else the Mini-ITX set (aligned to the top edge for larger ATX-family boards). */
export function boardHoles(b: MotherboardSpec): { holes: [number, number][]; source: Source; note?: string } {
  if (b.mountHoles?.length) return { holes: b.mountHoles, source: { text: 'your board settings', verified: true } };
  if (b.formFactor === 'mini-itx' || b.formFactor === 'thin-mini-itx' || b.formFactor === 'mini-dtx')
    return { holes: ITX_HOLES.map(([u, v]) => [u, v]), source: MEMORY };
  // Mini-ITX holes are a subset of the micro-ATX/ATX set, measured from the rear-I/O edge and the top edge.
  return {
    holes: ITX_HOLES.map(([u, v]) => [u, b.edge - (170 - v)]),
    source: MEMORY,
    note: `${b.formFactor} boards have more holes; four standoffs at the Mini-ITX positions are generated. Add the rest in Parts → Motherboard → mounting holes.`,
  };
}

/** Fan screw spacing (centre to centre along one side), mm. */
export function fanHoleSpacing(size: number): { spacing: number; source: Source } | null {
  if (Math.abs(size - 120) < 3) return { spacing: 105, source: NOP };
  if (Math.abs(size - 80) < 3) return { spacing: 71.5, source: NOP };
  if (Math.abs(size - 140) < 3) return { spacing: 124.5, source: MEMORY };
  if (Math.abs(size - 92) < 3) return { spacing: 82.5, source: MEMORY };
  return null;
}

/** PSU screw holes on the AC face, from its centre: x along the face width, y along its height (toward the fan face). */
export function psuHoles(p: PsuSpec): { holes: [number, number][]; source: Source; opening: { hx: number; hy: number } } | null {
  if (p.formFactor === 'atx')
    // NopSCADlib ATX500, face 150 × 86.
    return { holes: [[-69, -27], [-69, 37], [69, 37], [45, -37]], source: NOP, opening: { hx: 63, hy: 31 } };
  if (p.formFactor === 'sfx' || p.formFactor === 'sfx-l') {
    const hx = p.width / 2 - 6;
    const hy = p.height / 2 - 6;
    return { holes: [[-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]], source: MEMORY, opening: { hx: hx - 5, hy: hy - 5 } };
  }
  return null;
}

export const POWER_BUTTON_D = 16;
/** Snap-in IEC C14 panel socket cut-out, mm (typical; check your socket). */
export const IEC_CUTOUT = { w: 27.8, h: 20 };

export interface Standoff {
  label: string;
  /** Top centre (at the PCB underside) and the base centre (embedded in the wall). */
  top: Vec3;
  base: Vec3;
  axis: 0 | 1 | 2;
  length: number;
}

export interface WallHole {
  label: string;
  wall: Dir;
  /** Centre in the wall's two in-plane axes (wallAxes order). */
  x: number;
  y: number;
  d: number;
}

export interface WallOpening {
  label: string;
  wall: Dir;
  rect: { x0: number; y0: number; x1: number; y1: number };
}

export interface HardwareLine {
  item: string;
  qty: number;
  note: string;
}

/** A printed plate inside the case at a face of a part, fused to the nearest wall. */
export interface Bulkhead {
  label: string;
  /** Plate slab (solver box), already reaching into the wall. */
  slab: { min: Vec3; max: Vec3 };
  /** Plate normal axis; holes and the opening go through along it. */
  axis: 0 | 1 | 2;
  holes: { x: number; y: number; d: number }[];
  opening?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * A printed bar that clamps the GPU's bracket plate against the rear wall, screwed into insert
 * bosses. Bar-local coordinates (mm): x across the bracket width, y along the card's height.
 */
export interface BracketClamp {
  size: [number, number];
  holes: [number, number][];
  /** The part of the bar that steps down onto the bracket plate. */
  press: { x0: number; x1: number; y0: number; y1: number };
  /** Height of the boss tops above the wall surface. */
  rise: number;
}

export interface MountPlan {
  standoffs: Standoff[];
  clamp?: BracketClamp;
  bulkheads: Bulkhead[];
  /** Spots on a wall kept solid (no perforation), e.g. under a standoff. */
  solid: { wall: Dir; x: number; y: number; r: number }[];
  holes: WallHole[];
  openings: WallOpening[];
  hardware: HardwareLine[];
  warnings: string[];
  sources: string[];
}

/** Screw clearance hole in a printed panel: oversized so meshing error can't close it; the head covers the slack. */
const PANEL_HOLE_D = 5;

export function mountPlan(design: Design, cfg: DesignConfig): MountPlan {
  const out: MountPlan = { standoffs: [], bulkheads: [], solid: [], holes: [], openings: [], hardware: [], warnings: [], sources: [] };
  const src = new Set<string>();
  const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
  const wall = design.wall;
  const inWall = (p: Vec3) => F(p) >= -wall;

  // ---- motherboard standoffs: from the PCB underside down (−t) to the wall behind the board.
  const board = design.parts.find((p) => p.kind === 'board')!;
  const b = cfg.parts.board;
  const bh = boardHoles(b);
  src.add(`board holes: ${bh.source.text}`);
  if (bh.note) out.warnings.push(bh.note);
  // PCB origin as in evaluate.ts: the board is axis-aligned, u = +x from the rear wall, v = +y, t = +z.
  const origin: Vec3 = [board.body.min[0], board.body.min[1] + boardStack(cfg, design.profile.extraGap).pcbDv, board.body.min[2]];
  const pcbBottom = origin[2] + b.underside;
  bh.holes.forEach(([u, v], i) => {
    const top: Vec3 = [origin[0] + u, origin[1] + v, pcbBottom];
    let z = pcbBottom;
    let hit = false;
    for (let s = 0; s < 400; s++) {
      z -= 0.25;
      if (inWall([top[0], top[1], z])) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      out.warnings.push(`Standoff ${i + 1}: no wall within 100 mm behind the board — the board needs a mounting plate here.`);
      return;
    }
    const base: Vec3 = [top[0], top[1], z - wall * 0.6];
    const length = top[2] - base[2];
    out.standoffs.push({ label: `standoff ${i + 1}`, top, base, axis: 2, length });
    out.solid.push({ wall: 5, x: top[0], y: top[1], r: INSERT.bossD / 2 + 2 });
  });
  const tall = out.standoffs.filter((s) => s.length - wall > 30);
  if (tall.length) out.warnings.push(`${tall.length} standoff${tall.length > 1 ? 's are' : ' is'} over 30 mm tall: print that piece with the wall flat on the bed and consider a printed brace.`);
  if (out.standoffs.length) out.hardware.push({ item: 'M3 brass heat-set insert, 4.0 mm hole × 5.8 mm (e.g. F1BM3)', qty: out.standoffs.length, note: 'One per standoff; set with a soldering iron at the filament’s print temperature.' });
  if (out.standoffs.length) out.hardware.push({ item: 'M3 × 6 mm screw (board to standoff)', qty: out.standoffs.length, note: 'M3 fits the board’s 3.96 mm holes; tie one standoff to PSU ground (the board grounds through its holes).' });

  // ---- radiator fans: screw holes through the vented panel, at the fan pattern.
  let fanScrews = 0;
  for (const p of design.parts) {
    if ((p.kind !== 'rad-cpu' && p.kind !== 'rad-gpu') || !p.fan || p.face === undefined || !p.faceAtWall) continue;
    const sp = fanHoleSpacing(p.fan.size);
    if (!sp) {
      out.warnings.push(`${p.label}: no screw pattern known for ${p.fan.size} mm fans; drill through the panel at the fan holes.`);
      continue;
    }
    src.add(`${p.fan.size} mm fan holes: ${sp.source.text}`);
    const a = axisOf(p.face);
    const [xa, ya] = wallAxes(a);
    const [len, wid] = p.size;
    const n = p.fanCount ?? 1;
    const start = (len - n * p.fan.size) / 2;
    for (let i = 0; i < n; i++) {
      const cx = start + p.fan.size * (i + 0.5);
      const cy = wid / 2;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const w = localToWorld(p.frame, p.body, [cx + (dx * sp.spacing) / 2, cy + (dy * sp.spacing) / 2, 0]);
        out.holes.push({ label: `${p.label} fan ${i + 1}`, wall: p.face, x: w[xa], y: w[ya], d: PANEL_HOLE_D });
        fanScrews++;
      }
    }
    const rad = p.radiator!;
    out.hardware.push({
      item: `Radiator screw, M3 or #6-32 to match your radiator, ≥ ${Math.ceil(p.fan.thickness + wall + 5)} mm`,
      qty: n * 4,
      note: `${p.label}: through the panel and the ${p.fan.thickness} mm fan into the radiator (${rad.coreThickness} mm core). Most AIO kits include 30 mm screws; with the ${wall} mm panel check they still reach 5 mm of thread.`,
    });
  }

  // ---- PSU: screw holes and an opening for the mains inlet and switch on the AC face.
  const psu = design.parts.find((p) => p.kind === 'psu')!;
  const ph = psuHoles(cfg.parts.psu);
  const acDir = opposite(psu.frame.d[0]) as Dir;
  const acAtWall = design.vents.some((v) => v.kind === 'psu-exhaust' && v.wall === acDir);
  if (!acAtWall && ph) {
    // The AC end is inside the case: a 3 mm plate against it, fused to the nearest wall, holds the PSU
    // by its own screw holes; mains comes in through an IEC extension to a panel socket.
    const a = axisOf(acDir);
    const [xa, ya] = wallAxes(a);
    const faceAt = signOf(acDir) > 0 ? psu.body.max[a] : psu.body.min[a];
    const slab = { min: [...psu.body.min] as Vec3, max: [...psu.body.max] as Vec3 };
    slab.min[a] = signOf(acDir) > 0 ? faceAt : faceAt - 3;
    slab.max[a] = signOf(acDir) > 0 ? faceAt + 3 : faceAt;
    // Reach the nearest wall in the plate's plane (into the wall material).
    let best: { ax: number; lo: boolean; gap: number } | null = null;
    for (const ax of [xa, ya])
      for (const lo of [true, false]) {
        const gap = lo ? slab.min[ax] : design.interior[ax] - slab.max[ax];
        if (!best || gap < best.gap) best = { ax, lo, gap };
      }
    if (best) {
      // March from the plate's edge to the wall material (a shrinkwrapped wall needn't sit at the
      // interior bound), and end the plate half a wall into it, along the whole edge.
      const step = best.lo ? -0.25 : 0.25;
      const other = best.ax === xa ? ya : xa;
      let reach = best.lo ? slab.min[best.ax] : slab.max[best.ax];
      for (const f of [0.1, 0.5, 0.9]) {
        const p: Vec3 = [0, 0, 0];
        p[a] = (slab.min[a] + slab.max[a]) / 2;
        p[other] = slab.min[other] + f * (slab.max[other] - slab.min[other]);
        let t = best.lo ? slab.min[best.ax] : slab.max[best.ax];
        for (let k = 0; k < 400; k++, t += step) {
          p[best.ax] = t;
          if (inWall(p)) break;
        }
        reach = best.lo ? Math.min(reach, t - wall / 2) : Math.max(reach, t + wall / 2);
      }
      if (best.lo) slab.min[best.ax] = reach;
      else slab.max[best.ax] = reach;
    }
    // Room for the mains plug in front of the plate's opening.
    const plugRoom = (() => {
      let room = 60;
      for (const q of design.parts) {
        if (q === psu) continue;
        const overlaps = [xa, ya].every((ax) => q.body.min[ax] < slab.max[ax] && q.body.max[ax] > slab.min[ax]);
        if (!overlaps) continue;
        const gap = signOf(acDir) > 0 ? q.body.min[a] - faceAt : faceAt - q.body.max[a];
        if (gap >= 0) room = Math.min(room, gap);
      }
      return room;
    })();
    if (plugRoom < 35)
      out.warnings.push(
        plugRoom < 18
          ? `Only ${Math.round(plugRoom)} mm in front of the PSU inlet: even a right-angle C13 plug (~18 mm) won't fit. Choose another layout or move the PSU.`
          : `${Math.round(plugRoom)} mm in front of the PSU inlet: use a right-angle (angled) C13 plug on the internal lead; a straight one needs ~35 mm.`,
      );
    const c = localToWorld(psu.frame, psu.body, [0, psu.size[1] / 2, psu.size[2] / 2]);
    const at = (x: number, y: number): Vec3 => {
      const v: Vec3 = [...c] as Vec3;
      v[axisOf(psu.frame.d[1])] += signOf(psu.frame.d[1]) * x;
      v[axisOf(psu.frame.d[2])] += signOf(psu.frame.d[2]) * y;
      return v;
    };
    const o1 = at(-ph.opening.hx, -ph.opening.hy);
    const o2 = at(ph.opening.hx, ph.opening.hy);
    out.bulkheads.push({
      label: 'PSU plate',
      slab,
      axis: a as 0 | 1 | 2,
      holes: ph.holes.map(([x, y]) => {
        const w = at(x, y);
        return { x: w[xa], y: w[ya], d: PANEL_HOLE_D };
      }),
      opening: { x0: Math.min(o1[xa], o2[xa]), y0: Math.min(o1[ya], o2[ya]), x1: Math.max(o1[xa], o2[xa]), y1: Math.max(o1[ya], o2[ya]) },
    });
    src.add(`PSU holes: ${ph.source.text}`);
    out.hardware.push({ item: '#6-32 UNC × 6 mm screw (PSU to its printed plate)', qty: ph.holes.length, note: 'Standard PSU screws, through the plate into the PSU.' });
    const avoid = out.holes.filter((h) => h.wall === 1).map((h) => ({ x: h.x, y: h.y, r: h.d / 2 }));
    const sock = findSpot(design, F, wall, 1, IEC_CUTOUT.w, IEC_CUTOUT.h, 6, avoid);
    if (sock) {
      out.openings.push({ label: 'IEC socket', wall: 1, rect: { x0: sock.x - IEC_CUTOUT.w / 2, y0: sock.y - IEC_CUTOUT.h / 2, x1: sock.x + IEC_CUTOUT.w / 2, y1: sock.y + IEC_CUTOUT.h / 2 } });
      src.add(`IEC snap-in cut-out ${IEC_CUTOUT.w} × ${IEC_CUTOUT.h} mm: ${MEMORY.text}`);
    } else out.warnings.push('No clear spot on the rear panel for the IEC socket cut-out: cut one where it fits.');
    out.hardware.push({
      item: `IEC C14 snap-in panel socket for a ${IEC_CUTOUT.w} × ${IEC_CUTOUT.h} mm cut-out, with a short C14→C13 lead (internal mains extension)`,
      qty: 1,
      note: 'The PSU’s inlet is inside the case: the socket snaps into the rear-panel cut-out and its lead plugs into the PSU through the plate opening. Check your socket’s cut-out size against the fit test.',
    });
    out.warnings.push('Mains: the PSU sits inside the case, so its inlet is reached by an IEC extension. Use a fused, earthed panel socket and route the lead away from the fans.');
  } else if (!acAtWall) out.warnings.push(`No screw pattern known for ${cfg.parts.psu.formFactor} PSUs: hold the PSU with a printed bracket (not generated) and run an IEC extension to a panel socket.`);
  else if (!ph) out.warnings.push(`No screw pattern known for ${cfg.parts.psu.formFactor} PSUs: mark the holes through the PSU onto the panel and drill 4 mm.`);
  else {
    src.add(`PSU holes: ${ph.source.text}`);
    const a = axisOf(acDir);
    const [xa, ya] = wallAxes(a);
    // Face centre and its width (local axis 1) and height (local axis 2) directions.
    const c = localToWorld(psu.frame, psu.body, [0, psu.size[1] / 2, psu.size[2] / 2]);
    const along = (k: 1 | 2, d: number): Vec3 => {
      const v: Vec3 = [0, 0, 0];
      v[axisOf(psu.frame.d[k])] = signOf(psu.frame.d[k]) * d;
      return v;
    };
    const at = (x: number, y: number) => {
      const wx = along(1, x);
      const wy = along(2, y);
      return [c[0] + wx[0] + wy[0], c[1] + wx[1] + wy[1], c[2] + wx[2] + wy[2]] as Vec3;
    };
    for (const [x, y] of ph.holes) {
      const w = at(x, y);
      out.holes.push({ label: 'PSU', wall: acDir, x: w[xa], y: w[ya], d: PANEL_HOLE_D });
    }
    const o1 = at(-ph.opening.hx, -ph.opening.hy);
    const o2 = at(ph.opening.hx, ph.opening.hy);
    out.openings.push({ label: 'PSU inlet and switch', wall: acDir, rect: { x0: Math.min(o1[xa], o2[xa]), y0: Math.min(o1[ya], o2[ya]), x1: Math.max(o1[xa], o2[xa]), y1: Math.max(o1[ya], o2[ya]) } });
    out.hardware.push({ item: '#6-32 UNC × 6 mm screw (PSU)', qty: ph.holes.length, note: 'Standard PSU screws; the asymmetric ATX hole only lines up one way round — check on the fit-test plate.' });
  }

  // ---- power button: a 16 mm hole on the front panel, clear of vents and edges.
  const spot = findSpot(design, F, wall, 0, POWER_BUTTON_D, POWER_BUTTON_D, 8);
  const btn: WallHole | null = spot ? { label: 'power button', wall: 0, x: spot.x, y: spot.y, d: POWER_BUTTON_D } : null;
  if (btn) {
    out.holes.push(btn);
    out.hardware.push({ item: '16 mm momentary push button, normally open, with leads', qty: 1, note: 'Wire it to the board’s front-panel PWR_SW pins (polarity doesn’t matter).' });
  } else out.warnings.push('No clear spot on the front panel for a 16 mm power button: drill one where convenient, or use a remote switch.');

  const bracket = design.vents.find((v) => v.kind === 'bracket');
  if (bracket) {
    const clamp = bracketClamp(design, bracket, inWall, wall);
    if (clamp) {
      out.clamp = clamp.clamp;
      out.standoffs.push(...clamp.bosses);
      for (const b of clamp.bosses) out.solid.push({ wall: 1, x: b.top[1], y: b.top[2], r: INSERT.bossD / 2 + 2 });
      out.hardware.push({ item: 'M3 brass heat-set insert (GPU bracket clamp)', qty: 2, note: 'In the two bosses beside the bracket opening.' });
      out.hardware.push({ item: 'M3 × 8 mm screw (GPU bracket clamp)', qty: 2, note: 'Through gpu-bracket-clamp.stl into the bosses; the bar presses the bracket plate flat against the panel near its top.' });
    } else out.warnings.push('GPU bracket: no room for the clamp bosses beside the bracket opening. Hold the bracket with its own screw: mark through the tab, drill 4 mm and set an M3 insert.');
  }
  if (fanScrews === 0 && !design.parts.some((p) => p.kind === 'rad-cpu' || p.kind === 'rad-gpu')) {
    // Nothing to add: parts' own fans are fixed to their parts.
  }
  out.hardware.push({ item: 'Self-adhesive rubber feet', qty: 4, note: 'Under the bottom panel (the feet height in the design keeps the bottom vents clear).' });
  out.sources = [...src];
  return out;
}

/**
 * A spot on a wall for a w × h cut-out, clear of openings (passive perforation gives way) and of
 * edges by `margin`, on a flat patch of the shell (the wall position varies by under 1 mm across
 * it). Prefers the top of the wall.
 */
function findSpot(design: Design, F: (p: Vec3) => number, wallT: number, wall: Dir, w: number, h: number, margin: number, avoid: { x: number; y: number; r: number }[] = [], depth = 30) {
  const a = axisOf(wall);
  const [xa, ya] = wallAxes(a);
  const vents = design.vents.filter((v) => v.wall === wall && v.kind !== 'passive');
  const s = signOf(wall);
  // Where the wall is along its normal at (x, y): march outward from the middle of the case.
  const wallAt = (x: number, y: number) => {
    const p: Vec3 = [0, 0, 0];
    p[xa] = x;
    p[ya] = y;
    for (let t = design.interior[a] / 2; t >= -40 && t <= design.interior[a] + 40; t += s * 0.5) {
      p[a] = t;
      if (F(p) >= -wallT) return t;
    }
    return NaN;
  };
  let best: { x: number; y: number; score: number } | null = null;
  for (let x = w / 2 + margin; x <= design.interior[xa] - w / 2 - margin; x += 4)
    for (let y = h / 2 + margin; y <= design.interior[ya] - h / 2 - margin; y += 4) {
      let ok = true;
      for (const v of vents) {
        const dx = Math.max(v.rect.x0 - (x + w / 2), 0, x - w / 2 - v.rect.x1);
        const dy = Math.max(v.rect.y0 - (y + h / 2), 0, y - h / 2 - v.rect.y1);
        if (Math.hypot(dx, dy) < margin) ok = false;
      }
      for (const o of avoid) if (Math.hypot(x - o.x, y - o.y) < o.r + Math.max(w, h) / 2 + margin) ok = false;
      if (!ok) continue;
      // Room behind the panel for the part's body (no part body within `depth` of the wall).
      const t0 = wallAt(x, y);
      const lo = s > 0 ? t0 - depth : t0;
      const hi = s > 0 ? t0 : t0 + depth;
      if (
        design.parts.some(
          (p) => p.body.min[a] < hi && p.body.max[a] > lo && p.body.min[xa] < x + w / 2 && p.body.max[xa] > x - w / 2 && p.body.min[ya] < y + h / 2 && p.body.max[ya] > y - h / 2,
        )
      )
        continue;
      const ts = [wallAt(x, y), wallAt(x - w / 2 - margin / 2, y - h / 2 - margin / 2), wallAt(x + w / 2 + margin / 2, y + h / 2 + margin / 2), wallAt(x - w / 2 - margin / 2, y + h / 2 + margin / 2), wallAt(x + w / 2 + margin / 2, y - h / 2 - margin / 2)];
      if (ts.some((t) => !Number.isFinite(t)) || Math.max(...ts) - Math.min(...ts) > 1) continue;
      if (!best || y > best.score) best = { x, y, score: y };
    }
  return best;
}

/**
 * Clamp for the GPU bracket: bosses on the rear wall 20 mm in from the bracket's tab end, one each
 * side of the opening when there is room both sides, else two side by side on the open side with
 * the bar reaching across the plate.
 */
function bracketClamp(design: Design, v: Design['vents'][number], inWall: (p: Vec3) => boolean, wallT: number) {
  const gpu = design.parts.find((p) => p.kind === 'gpu');
  if (!gpu) return null;
  // Rear wall (−u): wall coordinates x = v (axis 1), y = t (axis 2). The tab is at the card's top
  // edge (its height axis, away from the PCIe fingers).
  const ah = axisOf(gpu.frame.d[1]);
  const sh = signOf(gpu.frame.d[1]);
  if (ah === 0) return null;
  const hK = ah === 1 ? 0 : 1; // wall coordinate index along the card height
  const wK = 1 - hK;
  const r = v.rect;
  const lo = [r.x0, r.y0];
  const hi = [r.x1, r.y1];
  const lim = [design.interior[1], design.interior[2]];
  const along = sh > 0 ? hi[hK] - 20 : lo[hK] + 20;
  const R = INSERT.bossD / 2;
  const gap = R + 4;
  const RISE = INSERT.length + 1.5;
  const boss = (w: number, h: number): Standoff | null => {
    const c = [0, 0];
    c[wK] = w;
    c[hK] = h;
    if (c[0] < R + 1 || c[0] > lim[0] - R - 1 || c[1] < R + 1 || c[1] > lim[1] - R - 1) return null;
    let u = 10;
    let hit = false;
    for (let k = 0; k < 120; k++, u -= 0.25)
      if (inWall([u, c[0], c[1]])) {
        hit = true;
        break;
      }
    if (!hit) return null;
    const top: Vec3 = [u + RISE, c[0], c[1]];
    const base: Vec3 = [u - wallT * 0.6, c[0], c[1]];
    if (design.parts.some((p) => p !== gpu && p.body.min[0] < top[0] && p.body.max[0] > base[0] && p.body.min[1] < c[0] + R && p.body.max[1] > c[0] - R && p.body.min[2] < c[1] + R && p.body.max[2] > c[1] - R)) return null;
    return { label: 'GPU bracket clamp boss', top, base, axis: 0, length: top[0] - base[0] };
  };
  const span = hi[wK] - lo[wK];
  const a = boss(lo[wK] - gap, along);
  const b = boss(hi[wK] + gap, along);
  if (a && b) {
    const L = span + 2 * gap + 10;
    return {
      bosses: [a, b],
      clamp: { size: [L, 10] as [number, number], holes: [[5, 5], [L - 5, 5]] as [number, number][], press: { x0: 5 + gap - 1, x1: L - 5 - gap + 1, y0: 0, y1: 10 }, rise: RISE },
    };
  }
  // One side only: two bosses 14 mm apart along the height, the bar reaching across the plate.
  for (const side of [1, -1]) {
    const w = side > 0 ? hi[wK] + gap : lo[wK] - gap;
    const pair = [boss(w, along - 7), boss(w, along + 7)];
    if (!pair[0] || !pair[1]) continue;
    const L = span + gap + 6;
    // Bar-local x runs from the far edge of the plate to past the screws (mirrored when the open side is low).
    const hx = side > 0 ? L - 5 : 5;
    return {
      bosses: pair as Standoff[],
      clamp: {
        size: [L, 24] as [number, number],
        holes: [[hx, 5], [hx, 19]] as [number, number][],
        press: side > 0 ? { x0: 0, x1: span + 1, y0: 0, y1: 24 } : { x0: L - span - 1, x1: L, y0: 0, y1: 24 },
        rise: RISE,
      },
    };
  }
  return null;
}

/**
 * A closed boss mesh: a cylinder from `base` to `top` along an axis, with a blind insert hole from
 * the top. Exact geometry, independent of the wall's meshing grid; slicers merge it with the wall
 * it is embedded in.
 */
export function bossMesh(s: Standoff, outerD = INSERT.bossD, holeD = INSERT.holeD, holeDepth = INSERT.length + 1, seg = 40): ShellMesh {
  const [ua, va] = wallAxes(s.axis);
  const dirSign = Math.sign(s.top[s.axis] - s.base[s.axis]) || 1;
  const depth = Math.min(holeDepth, s.length - 1.2);
  const zt = s.top[s.axis];
  const zb = s.base[s.axis];
  const zh = zt - dirSign * depth;
  const ro = outerD / 2;
  const ri = holeD / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  const P = (r: number, k: number, z: number) => {
    const t = (2 * Math.PI * k) / seg;
    const p: Vec3 = [0, 0, 0];
    p[ua] = s.top[ua] + r * Math.cos(t);
    p[va] = s.top[va] + r * Math.sin(t);
    p[s.axis] = z;
    pos.push(p[0], p[1], p[2]);
    return pos.length / 3 - 1;
  };
  const ring = (r: number, z: number) => Array.from({ length: seg }, (_, k) => P(r, k, z));
  const oTop = ring(ro, zt);
  const oBot = ring(ro, zb);
  const iTop = ring(ri, zt);
  const iBot = ring(ri, zh);
  const cBot = P(0, 0, zb);
  const cHole = P(0, 0, zh);
  // Orientation: right-handed (ua, va, axis); flip when the boss points the other way.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => (flip ? idx.push(a, c, b, a, d, c) : idx.push(a, b, c, a, c, d));
  const tri = (a: number, b: number, c: number, flip: boolean) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
  const f = dirSign < 0;
  for (let k = 0; k < seg; k++) {
    const k1 = (k + 1) % seg;
    quad(oBot[k], oBot[k1], oTop[k1], oTop[k], f); // outer wall, facing out
    quad(oTop[k], oTop[k1], iTop[k1], iTop[k], f); // top annulus, facing +dir
    quad(iTop[k], iTop[k1], iBot[k1], iBot[k], f); // hole wall, facing the hole axis
    tri(cHole, iBot[k], iBot[k1], f); // hole floor, facing +dir
    tri(cBot, oBot[k1], oBot[k], f); // bottom, facing −dir
  }
  const positions = new Float32Array(pos);
  const indices = new Uint32Array(idx);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], positions[i + a]);
      hi[a] = Math.max(hi[a], positions[i + a]);
    }
  const area = Math.PI * outerD * s.length;
  const vol = Math.PI * ro * ro * s.length - Math.PI * ri * ri * depth;
  return { positions, normals: new Float32Array(positions.length), indices, bbox: { min: lo, max: hi }, volumeMm3: vol, areaMm2: area };
}

/** Append meshes (separate shells in one object). */
export function mergeMeshes(meshes: ShellMesh[]): ShellMesh {
  const nPos = meshes.reduce((s, m) => s + m.positions.length, 0);
  const nIdx = meshes.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float32Array(nPos);
  const normals = new Float32Array(nPos);
  const indices = new Uint32Array(nIdx);
  let po = 0;
  let io = 0;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  let area = 0;
  for (const m of meshes) {
    positions.set(m.positions, po);
    normals.set(m.normals, po);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + po / 3;
    po += m.positions.length;
    io += m.indices.length;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], m.bbox.min[a]);
      hi[a] = Math.max(hi[a], m.bbox.max[a]);
    }
    vol += m.volumeMm3;
    area += m.areaMm2;
  }
  return { positions, normals, indices, bbox: { min: lo, max: hi }, volumeMm3: vol, areaMm2: area };
}

export type { PlacedPart };
