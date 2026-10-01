import * as THREE from 'three';
import type { SimFrame } from '../cfd/run';
import { ductPlates, louvreDirection, type Shaping } from '../cfd/scene';
import { CELL_SOLID } from '../cfd/solver';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Box, type Vec3 } from '../solver/geometry';
import { boardStack } from '../solver/items';
import type { DesignConfig } from '../model/types';
import type { WorldMap } from './mapping';

const N = 3200;
/** Slow motion: real air at 1–3 m/s would cross the case in a fraction of a second. */
const SLOWMO = 0.1;

/** Room temperature → hottest: deep blue, cyan, pale yellow, orange, red. */
function heatColour(t: number, out: THREE.Color) {
  const stops: [number, number, number, number][] = [
    [0, 0.16, 0.38, 0.95],
    [0.25, 0.12, 0.78, 0.92],
    [0.5, 0.98, 0.93, 0.45],
    [0.75, 0.99, 0.55, 0.15],
    [1, 0.9, 0.12, 0.1],
  ];
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (x - a[0]) / (b[0] - a[0]);
      out.setRGB(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
      return;
    }
  }
}

export class FlowLayer {
  readonly group = new THREE.Group();
  private frame: SimFrame | null = null;
  private map: WorldMap | null = null;
  private pos = new Float32Array(N * 3); // grid mm
  private life = new Float32Array(N);
  private seeds: Int32Array = new Int32Array(0);
  private lines: THREE.LineSegments;
  private linePos = new Float32Array(N * 6);
  private lineCol = new Float32Array(N * 6);
  private slice: THREE.Mesh | null = null;
  private sliceTex: THREE.DataTexture | null = null;
  private sliceFrac = 0.5;
  private sliceOn = false;
  readonly shapingGroup = new THREE.Group();
  /** Temperature rise shown as full red. */
  scaleMax = 20;
  private colour = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.group.add(this.lines);
    this.group.visible = false;
  }

  get active() {
    return this.group.visible && this.frame !== null;
  }

  clear() {
    this.frame = null;
    this.seeds = new Int32Array(0);
    this.linePos.fill(0);
    this.lines.geometry.attributes.position.needsUpdate = true;
    if (this.slice) {
      this.group.remove(this.slice);
      this.slice.geometry.dispose();
      this.sliceTex?.dispose();
      this.slice = null;
      this.sliceTex = null;
    }
    this.clearShaping();
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  setFrame(f: SimFrame, map: WorldMap) {
    const first = !this.frame || this.frame.n.join() !== f.n.join();
    this.frame = f;
    this.map = map;
    this.scaleMax = Math.max(8, Math.min(40, f.stats.maxRise * 0.8));
    // Seeds: cells where air is actually moving, so particles show the flow paths.
    const n = f.T.length;
    const moving: number[] = [];
    for (let c = 0; c < n; c++) {
      if (f.solid[c] === CELL_SOLID) continue;
      const s = Math.hypot(f.vel[3 * c], f.vel[3 * c + 1], f.vel[3 * c + 2]);
      if (s > 120) moving.push(c);
    }
    this.seeds = Int32Array.from(moving);
    if (first) for (let i = 0; i < N; i++) this.respawn(i, Math.random() * 3);
    if (this.sliceOn) this.buildSlice();
  }

  private respawn(i: number, life = 1.5 + Math.random() * 3) {
    const f = this.frame;
    if (!f || !this.seeds.length) {
      this.life[i] = 0;
      return;
    }
    const c = this.seeds[(Math.random() * this.seeds.length) | 0];
    const [nx, ny] = f.n;
    const ci = c % nx;
    const cj = Math.floor(c / nx) % ny;
    const ck = Math.floor(c / (nx * ny));
    this.pos[3 * i] = (ci + Math.random()) * f.h;
    this.pos[3 * i + 1] = (cj + Math.random()) * f.h;
    this.pos[3 * i + 2] = (ck + Math.random()) * f.h;
    this.life[i] = life;
  }

  /** Trilinear sample of the cell-centred velocity (component q) or temperature (q = 3). */
  private sample(x: number, y: number, z: number, q: number): number {
    const f = this.frame!;
    const [nx, ny, nz] = f.n;
    const fx = Math.min(nx - 1.001, Math.max(0, x / f.h - 0.5));
    const fy = Math.min(ny - 1.001, Math.max(0, y / f.h - 0.5));
    const fz = Math.min(nz - 1.001, Math.max(0, z / f.h - 0.5));
    const i = fx | 0;
    const j = fy | 0;
    const k = fz | 0;
    const a = fx - i;
    const b = fy - j;
    const c = fz - k;
    const at = (di: number, dj: number, dk: number) => {
      const id = i + di + nx * (j + dj + ny * (k + dk));
      return q === 3 ? f.T[id] : f.vel[3 * id + q];
    };
    const c00 = at(0, 0, 0) * (1 - a) + at(1, 0, 0) * a;
    const c10 = at(0, 1, 0) * (1 - a) + at(1, 1, 0) * a;
    const c01 = at(0, 0, 1) * (1 - a) + at(1, 0, 1) * a;
    const c11 = at(0, 1, 1) * (1 - a) + at(1, 1, 1) * a;
    return (c00 * (1 - b) + c10 * b) * (1 - c) + (c01 * (1 - b) + c11 * b) * c;
  }

  private toWorld(x: number, y: number, z: number, out: Float32Array, o: number) {
    const f = this.frame!;
    const p = this.map!.point([x + f.origin[0], y + f.origin[1], z + f.origin[2]]);
    out[o] = p.x;
    out[o + 1] = p.y;
    out[o + 2] = p.z;
  }

  /** Advance particles by real time dt (s). */
  update(dt: number) {
    const f = this.frame;
    if (!f || !this.group.visible) return;
    const [nx, ny, nz] = f.n;
    const h = f.h;
    const step = Math.min(dt, 0.05) * SLOWMO;
    for (let i = 0; i < N; i++) {
      let x = this.pos[3 * i];
      let y = this.pos[3 * i + 1];
      let z = this.pos[3 * i + 2];
      // RK2 midpoint
      const vx0 = this.sample(x, y, z, 0);
      const vy0 = this.sample(x, y, z, 1);
      const vz0 = this.sample(x, y, z, 2);
      const vx = this.sample(x + 0.5 * step * vx0, y + 0.5 * step * vy0, z + 0.5 * step * vz0, 0);
      const vy = this.sample(x + 0.5 * step * vx0, y + 0.5 * step * vy0, z + 0.5 * step * vz0, 1);
      const vz = this.sample(x + 0.5 * step * vx0, y + 0.5 * step * vy0, z + 0.5 * step * vz0, 2);
      x += step * vx;
      y += step * vy;
      z += step * vz;
      this.life[i] -= dt;
      const ci = Math.floor(x / h);
      const cj = Math.floor(y / h);
      const ck = Math.floor(z / h);
      const speed = Math.hypot(vx, vy, vz);
      const out = ci < 0 || cj < 0 || ck < 0 || ci >= nx || cj >= ny || ck >= nz;
      if (out || this.life[i] <= 0 || speed < 25 || f.solid[ci + nx * (cj + ny * ck)] === CELL_SOLID) {
        this.respawn(i);
        x = this.pos[3 * i];
        y = this.pos[3 * i + 1];
        z = this.pos[3 * i + 2];
      } else {
        this.pos[3 * i] = x;
        this.pos[3 * i + 1] = y;
        this.pos[3 * i + 2] = z;
      }
      // Streak: head at the particle, tail behind it along the flow.
      const tail = Math.min(28, 0.022 * speed) / Math.max(speed, 1);
      this.toWorld(x, y, z, this.linePos, 6 * i);
      this.toWorld(x - vx * tail, y - vy * tail, z - vz * tail, this.linePos, 6 * i + 3);
      heatColour(this.sample(x, y, z, 3) / this.scaleMax, this.colour);
      const fade = Math.min(1, this.life[i] * 2);
      this.lineCol[6 * i] = this.colour.r * fade;
      this.lineCol[6 * i + 1] = this.colour.g * fade;
      this.lineCol[6 * i + 2] = this.colour.b * fade;
      this.lineCol[6 * i + 3] = this.colour.r * 0.15 * fade;
      this.lineCol[6 * i + 4] = this.colour.g * 0.15 * fade;
      this.lineCol[6 * i + 5] = this.colour.b * 0.15 * fade;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  /** Temperature slice through the case, across the thickness axis at `frac` (0..1). */
  setSlice(on: boolean, frac = this.sliceFrac) {
    this.sliceOn = on;
    this.sliceFrac = frac;
    if (!on) {
      if (this.slice) this.slice.visible = false;
      return;
    }
    this.buildSlice();
  }

  private buildSlice() {
    const f = this.frame;
    const map = this.map;
    if (!f || !map) return;
    const [nx, ny, nz] = f.n;
    const k = Math.min(nz - 1, Math.max(0, Math.round(this.sliceFrac * (nz - 1))));
    const data = new Uint8Array(nx * ny * 4);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const o = 4 * (i + nx * j);
        if (f.solid[c] === CELL_SOLID) {
          data[o + 3] = 0;
          continue;
        }
        heatColour(f.T[c] / this.scaleMax, this.colour);
        data[o] = this.colour.r * 255;
        data[o + 1] = this.colour.g * 255;
        data[o + 2] = this.colour.b * 255;
        data[o + 3] = 170;
      }
    if (!this.sliceTex || this.sliceTex.image.width !== nx || this.sliceTex.image.height !== ny) {
      this.sliceTex?.dispose();
      this.sliceTex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat);
      this.sliceTex.magFilter = THREE.LinearFilter;
      this.sliceTex.minFilter = THREE.LinearFilter;
    } else {
      (this.sliceTex.image.data as Uint8Array).set(data);
    }
    this.sliceTex.needsUpdate = true;
    const t = f.origin[2] + (k + 0.5) * f.h;
    const u0 = f.origin[0];
    const v0 = f.origin[1];
    const u1 = f.origin[0] + nx * f.h;
    const v1 = f.origin[1] + ny * f.h;
    const corners = [map.point([u0, v0, t]), map.point([u1, v0, t]), map.point([u1, v1, t]), map.point([u0, v1, t])];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((p) => [p.x, p.y, p.z]), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    if (!this.slice) {
      this.slice = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.sliceTex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      this.slice.renderOrder = 4;
      this.group.add(this.slice);
    } else {
      this.slice.geometry.dispose();
      this.slice.geometry = geo;
      (this.slice.material as THREE.MeshBasicMaterial).map = this.sliceTex;
    }
    this.slice.visible = true;
  }

  private clearShaping() {
    for (const c of [...this.shapingGroup.children]) {
      this.shapingGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
  }

  /** Draw the flow-shaping hardware: louvre slats on exhaust vents, duct plates around fans. */
  setShaping(design: Design, cfg: DesignConfig, shaping: Shaping | null, map: WorldMap) {
    this.clearShaping();
    if (!shaping) return;
    const mat = new THREE.MeshStandardMaterial({ color: '#d98a52', metalness: 0.6, roughness: 0.35, transparent: true, opacity: 0.85 });
    const addBox = (b: Box) => {
      const wb = map.box(b);
      const size = wb.getSize(new THREE.Vector3());
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.8), Math.max(size.y, 0.8), Math.max(size.z, 0.8)), mat);
      wb.getCenter(m.position);
      this.shapingGroup.add(m);
    };
    for (const l of shaping.louvres) {
      const v = design.vents[l.vent];
      if (!v) continue;
      const a = axisOf(v.wall);
      const [xa, ya] = wallAxes(a);
      const d = louvreDirection(v.wall, l.toward);
      const along = axisOf(l.toward);
      const across = along === xa ? ya : xa;
      const wallPos = signOf(v.wall) > 0 ? design.interior[a] + design.wall : -design.wall;
      const lo = along === xa ? v.rect.x0 : v.rect.y0;
      const hi = along === xa ? v.rect.x1 : v.rect.y1;
      const lo2 = across === xa ? v.rect.x0 : v.rect.y0;
      const hi2 = across === xa ? v.rect.x1 : v.rect.y1;
      // Slats every 18 mm, each a thin plate tilted toward `toward`, drawn as a stack of short boxes.
      for (let s = lo + 9; s < hi; s += 18) {
        for (let q = 0; q < 6; q++) {
          const depth = (q / 6) * 14;
          const c: Vec3 = [0, 0, 0];
          c[a] = wallPos + signOf(v.wall) * depth * d[a];
          c[along] = s + depth * d[along];
          const b: Box = { min: [...c] as Vec3, max: [...c] as Vec3 };
          b.min[across] = lo2;
          b.max[across] = hi2;
          b.min[a] -= 1.2;
          b.max[a] += 1.2;
          b.min[along] -= 0.6;
          b.max[along] += 0.6;
          addBox(b);
        }
      }
    }
    const bs = boardStack(cfg, design.profile.extraGap);
    for (const id of shaping.ducts) {
      const part = design.parts.find((p) => p.id === id);
      if (!part || part.face === undefined) continue;
      const a = axisOf(part.face);
      const gap: Box = { min: [...part.body.min] as Vec3, max: [...part.body.max] as Vec3 };
      if (part.kind === 'board') {
        const bp = cfg.parts.board;
        const c = cfg.parts.cooler;
        gap.min = [part.body.min[0] + bp.socketU - c.depth / 2, part.body.min[1] + bs.pcbDv + bp.socketV - c.width / 2, part.body.min[2]];
        gap.max = [part.body.min[0] + bp.socketU + c.depth / 2, part.body.min[1] + bs.pcbDv + bp.socketV + c.width / 2, part.body.max[2]];
      }
      if (signOf(part.face) > 0) {
        gap.min[a] = part.body.max[a];
        gap.max[a] = design.interior[a];
      } else {
        gap.min[a] = 0;
        gap.max[a] = part.body.min[a];
      }
      for (const p of ductPlates(gap, a, 1.2)) addBox(p);
    }
  }
}
