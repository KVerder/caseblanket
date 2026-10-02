import * as THREE from 'three';
import type { HosePath } from '../solver/hoses';
import type { DesignConfig } from '../model/types';
import type { Design, PlacedPart } from '../solver/evaluate';
import { axisOf, localBoxToWorld, localToWorld, type Vec3 } from '../solver/geometry';
import { boardStack } from '../solver/items';
import { partPoint, TILT_PLATE } from '../solver/tilt';
import type { WorldMap } from './mapping';

export const PART_COLORS: Record<string, string> = {
  board: '#2f7a55',
  gpu: '#6b6f7a',
  psu: '#40444c',
  'rad-cpu': '#9aa1ad',
  'rad-gpu': '#9aa1ad',
  'case-fan': '#3a6ea5',
  extra: '#b08a4a',
};

const matCache = new Map<string, THREE.Material>();
export function mat(color: string, opts: { metal?: number; rough?: number; opacity?: number } = {}): THREE.Material {
  const key = `${color}|${opts.metal ?? 0.2}|${opts.rough ?? 0.6}|${opts.opacity ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      metalness: opts.metal ?? 0.2,
      roughness: opts.rough ?? 0.6,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
    });
    m.userData.shared = true;
    matCache.set(key, m);
  }
  return m;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 32);
unitBox.userData.shared = true;
unitCyl.userData.shared = true;

export class PartBuilder {
  constructor(
    private map: WorldMap,
    private group: THREE.Group,
  ) {}

  /** Axis-aligned box given in a part's local body coordinates. */
  box(part: PlacedPart, lo: Vec3, hi: Vec3, material: THREE.Material): THREE.Mesh {
    const b = this.map.box(localBoxToWorld(part.frame, part.body, lo, hi));
    const size = b.getSize(new THREE.Vector3());
    const mesh = new THREE.Mesh(unitBox, material);
    mesh.scale.set(Math.max(size.x, 0.2), Math.max(size.y, 0.2), Math.max(size.z, 0.2));
    b.getCenter(mesh.position);
    this.group.add(mesh);
    return mesh;
  }

  /** Cylinder whose axis is local axis `k`, centred at local point `c`. */
  disc(part: PlacedPart, c: Vec3, radius: number, length: number, k: 0 | 1 | 2, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(unitCyl, material);
    mesh.scale.set(radius, Math.max(length, 0.2), radius);
    const worldAxis = this.map.axis(axisOf(part.frame.d[k])).index;
    if (worldAxis === 0) mesh.rotation.z = Math.PI / 2;
    else if (worldAxis === 2) mesh.rotation.x = Math.PI / 2;
    mesh.position.copy(this.map.point(localToWorld(part.frame, part.body, c)));
    this.group.add(mesh);
    return mesh;
  }
}

function fan(b: PartBuilder, part: PlacedPart, cx: number, cy: number, z0: number, size: number, thick: number) {
  b.box(part, [cx - size / 2, cy - size / 2, z0], [cx + size / 2, cy + size / 2, z0 + thick], mat('#1d1f24', { rough: 0.8 }));
  b.disc(part, [cx, cy, z0 + thick + 0.3], size / 2 - 3, 0.6, 2, mat('#30343b', { rough: 0.5 }));
  b.disc(part, [cx, cy, z0 + thick + 0.6], size * 0.17, 0.8, 2, mat('#555a63', { rough: 0.4 }));
}

export function buildBoard(b: PartBuilder, part: PlacedPart, cfg: DesignConfig, extraGap: number) {
  const bd = cfg.parts.board;
  const cooler = cfg.parts.cooler;
  const s = boardStack(cfg, extraGap);
  const dv = s.pcbDv;
  const pcbTop = s.surface;
  b.box(part, [0, dv, bd.underside], [bd.depth, dv + bd.edge, pcbTop], mat('#1f6b47', { rough: 0.7 }));
  // PCIe x16 slot
  b.box(part, [45, dv + bd.slotV - 4, pcbTop], [134, dv + bd.slotV + 4, pcbTop + 11], mat('#15171a'));
  // Rear I/O stack
  const ioH = Math.min(bd.componentHeight, 40);
  b.box(part, [0, dv + Math.max(0, bd.edge - 160), pcbTop], [24, dv + bd.edge - 4, pcbTop + ioH], mat('#a7adb6', { metal: 0.7, rough: 0.35 }));
  // Socket
  const sx = bd.socketU;
  const sy = dv + bd.socketV;
  b.box(part, [sx - 22, sy - 22, pcbTop], [sx + 22, sy + 22, pcbTop + bd.socketStack], mat('#c6a15b', { metal: 0.6, rough: 0.4 }));
  const cz = pcbTop + bd.socketStack;
  // RAM, only where the cooler does not cover it.
  const coolerFar = sx + cooler.depth / 2;
  if (coolerFar < bd.depth - 30) {
    for (const off of [26, 14]) {
      b.box(part, [bd.depth - off, dv + (bd.edge - 133) / 2, pcbTop], [bd.depth - off + 7, dv + (bd.edge + 133) / 2, pcbTop + Math.min(bd.componentHeight, 44)], mat('#2a2d33'));
    }
  }
  if (cooler.kind === 'aio') {
    b.disc(part, [sx, sy, cz + cooler.height / 2], 32, cooler.height, 2, mat('#23262b', { rough: 0.4 }));
    b.disc(part, [sx, sy, cz + cooler.height], 26, 1, 2, mat('#6ee7ff', { rough: 0.3 }));
  } else if (cooler.kind === 'air-downdraft') {
    const fanT = cooler.fan.thickness;
    const finTop = cz + cooler.height - fanT;
    b.box(part, [sx - cooler.depth / 2, sy - cooler.width / 2, cz], [sx + cooler.depth / 2, sy + cooler.width / 2, finTop], mat('#c7ccd3', { metal: 0.8, rough: 0.35 }));
    fan(b, part, sx, sy, finTop, Math.min(cooler.fan.size, cooler.width, cooler.depth), fanT);
  } else {
    b.box(part, [sx - cooler.depth / 2, sy - cooler.width / 2, cz], [sx + cooler.depth / 2 - cooler.fan.thickness, sy + cooler.width / 2, cz + cooler.height], mat('#c7ccd3', { metal: 0.8, rough: 0.35 }));
    b.box(part, [sx + cooler.depth / 2 - cooler.fan.thickness, sy - cooler.fan.size / 2, cz + cooler.height - cooler.fan.size], [sx + cooler.depth / 2, sy + cooler.fan.size / 2, cz + cooler.height], mat('#1d1f24'));
  }
}

export function buildGpu(b: PartBuilder, part: PlacedPart, cfg: DesignConfig) {
  const g = cfg.parts.gpu;
  const [L, H, T] = part.size;
  b.box(part, [0, 6, 0], [L, H, 2.5], mat('#2b2e34', { metal: 0.6, rough: 0.4 }));
  b.box(part, [0, 2, 2.5], [L - 4, H - 4, 4.5], mat('#1f6b47'));
  b.box(part, [45, -6, 2.8], [134, 2, 4.2], mat('#c9a24a', { metal: 0.8, rough: 0.3 }));
  b.box(part, [2, 0, 4.5], [L, H, T - 1], mat('#50545d', { metal: 0.4, rough: 0.5 }));
  b.box(part, [-1.2, -4, 0], [0, H + 6, T], mat('#b9bec6', { metal: 0.9, rough: 0.3 }));
  // Power connector on the top edge.
  b.box(part, [L * 0.55, H - 2, T * 0.35], [L * 0.55 + 22, H + 8, T * 0.35 + 9], mat('#111214'));
  if (g.cooling === 'aio') {
    b.disc(part, [L * 0.42, H * 0.52, T - 0.5], 34, 1.5, 2, mat('#6ee7ff', { rough: 0.3 }));
    if (g.cardFan) fan(b, part, L * 0.82, H * 0.5, T - 16, Math.min(80, H - 20), 15);
  } else {
    const n = L > 250 ? 3 : 2;
    const size = Math.min(95, (L - 20) / n, H - 15);
    for (let i = 0; i < n; i++) fan(b, part, 10 + ((L - 20) / n) * (i + 0.5), H / 2, T - 13, size, 12);
  }
}

export function buildPsu(b: PartBuilder, part: PlacedPart, cfg: DesignConfig) {
  const p = cfg.parts.psu;
  const [L, W, H] = part.size;
  b.box(part, [0, 0, 0], [L, W, H], mat('#34373d', { metal: 0.5, rough: 0.5 }));
  if (p.fanOn === 'face') {
    const r = Math.min(L, W) / 2 - 6;
    b.disc(part, [L / 2, W / 2, H + 0.3], r, 0.6, 2, mat('#15171a'));
    b.disc(part, [L / 2, W / 2, H + 0.6], r * 0.3, 0.8, 2, mat('#555a63'));
  } else {
    b.disc(part, [L + 0.3, W / 2, H / 2], Math.min(W, H) / 2 - 3, 0.6, 0, mat('#15171a'));
  }
  // AC inlet (−e1) and modular connectors (+e1)
  b.box(part, [-0.6, W * 0.15, H * 0.3], [0, W * 0.15 + 30, H * 0.3 + 22], mat('#0d0e10'));
  b.box(part, [L, W * 0.1, H * 0.15], [L + 0.6, W * 0.9, H * 0.85], mat('#1a1c20'));
}

export function buildRadiator(b: PartBuilder, part: PlacedPart) {
  const r = part.radiator!;
  const f = part.fan!;
  const n = part.fanCount ?? r.fanCount;
  const [len, wid] = part.size;
  const core = r.coreThickness;
  const tank = 16;
  b.box(part, [tank, 0, 0], [len - tank, wid, core], mat('#b8bec8', { metal: 0.7, rough: 0.45 }));
  b.box(part, [0, 0, 0], [tank, wid, core], mat('#2a2d33'));
  b.box(part, [len - tank, 0, 0], [len, wid, core], mat('#2a2d33'));
  // Ports at the +e1 end
  for (const off of [-14, 14]) b.disc(part, [len + 6, wid / 2 + off, core / 2], 6, 12, 0, mat('#15171a'));
  const span = n * f.size;
  const start = (len - span) / 2;
  for (let i = 0; i < n; i++) fan(b, part, start + f.size * (i + 0.5), wid / 2, core, Math.min(f.size, wid), f.thickness);
}

export function buildCaseFan(b: PartBuilder, part: PlacedPart) {
  const [len, wid, thick] = part.size;
  fan(b, part, len / 2, wid / 2, 0, Math.min(len, wid), part.fan?.thickness ?? thick);
}

/**
 * A tilted part: the same as `part` laid flat in its box (`flat`), and the world transform (in
 * render space) that tilts it into place. Build the part's meshes on `flat`, then apply the matrix.
 */
export function tiltedPose(map: WorldMap, part: PlacedPart): { flat: PlacedPart; matrix: THREE.Matrix4 } | null {
  if (!part.tilt) return null;
  const size = part.tilt.size;
  const body = { min: [...part.body.min] as Vec3, max: [...part.body.min] as Vec3 };
  for (let i = 0; i < 3; i++) body.max[axisOf(part.frame.d[i])] = body.min[axisOf(part.frame.d[i])] + size[i];
  const flat: PlacedPart = { ...part, body, size, tilt: undefined };
  const basis = (f: (p: Vec3) => Vec3) => {
    const o = map.point(f([0, 0, 0]));
    const e = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map((p) => map.point(f(p)).sub(o));
    return new THREE.Matrix4().makeBasis(e[0], e[1], e[2]).setPosition(o);
  };
  const A = basis((p) => localToWorld(flat.frame, flat.body, p));
  const B = basis((p) => partPoint(part, p));
  return { flat, matrix: B.multiply(A.invert()) };
}

/** The printed wedge frame's plate, between the fans and the panel. */
export function buildTiltPlate(b: PartBuilder, flat: PlacedPart) {
  const [L, W, T] = flat.size;
  b.box(flat, [0, 0, T - TILT_PLATE], [L, W, T], mat('#c27a3e', { rough: 0.7, opacity: 0.55 }));
}

export function buildExtra(b: PartBuilder, part: PlacedPart) {
  b.box(part, [0, 0, 0], part.size, mat(PART_COLORS.extra, { rough: 0.7 }));
}

/** AIO hoses and the GPU power cable along the solver's routed paths. */
export function buildRouted(group: THREE.Group, map: WorldMap, paths: HosePath[]) {
  const hose = mat('#141518', { rough: 0.85 });
  const cable = mat('#2a2b30', { rough: 0.7 });
  for (const h of paths) {
    const curve = new THREE.CatmullRomCurve3(h.points.map((p) => map.point(p)), false, 'centripetal');
    const geo = new THREE.TubeGeometry(curve, Math.max(24, h.points.length * 2), h.radius, 10, false);
    group.add(new THREE.Mesh(geo, h.kind === 'cable' ? cable : hose));
  }
}

export function clearanceGhost(map: WorldMap, part: PlacedPart, color: string): THREE.LineSegments {
  const b = map.box(part.clearance);
  const size = b.getSize(new THREE.Vector3());
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
  const line = new THREE.LineSegments(geo, new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.55 }));
  line.computeLineDistances();
  b.getCenter(line.position);
  return line;
}

export function partCenter(map: WorldMap, part: PlacedPart): THREE.Vector3 {
  return map.box(part.body).getCenter(new THREE.Vector3());
}

export function extraGapOf(design: Design) {
  return design.profile.extraGap;
}
