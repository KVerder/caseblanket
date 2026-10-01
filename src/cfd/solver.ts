/**
 * Coarse 3D incompressible flow + heat solver on a staggered (MAC) grid.
 *
 * Units: millimetres, seconds, kelvin above room temperature, watts.
 * Each step: semi-Lagrangian advection → fans, louvres, buoyancy → porous drag →
 * pressure projection (red-black SOR, open far boundary at p = 0) → heat advection,
 * sources and a turbulent diffusion term.
 *
 * Built for comparing layouts and showing where air goes, with ~10 mm cells. It does not
 * resolve fan blades, fin passages or boundary layers.
 */

export const CELL_FLUID = 0;
export const CELL_SOLID = 1;

/** An actuator disk: cells pushed toward an axial speed plus swirl around the fan axis. */
export interface FanDisk {
  cells: Int32Array;
  /** Axis 0/1/2 and direction ±1 of the blown air. */
  axis: number;
  sign: number;
  /** Operating-point estimate from the fan model (mm/s), used for the time step. */
  speed: number;
  /** Free-air axial speed (mm/s) and the acceleration at stall (mm/s²) = Pmax / (ρ·fan depth). */
  vmax: number;
  a0: number;
  /** Fan centre (grid mm) for the swirl direction. */
  center: [number, number, number];
  swirl: number; // tangential / axial
  group: string;
}

/** Turns air leaving a vent toward a direction (exhaust deflector / louvre). */
export interface Louvre {
  cells: Int32Array;
  dir: [number, number, number];
  normal: [number, number, number];
}

export interface HeatSource {
  id: string;
  label: string;
  cells: Int32Array;
  watts: number;
}

export interface Scene {
  n: [number, number, number];
  h: number;
  /** Solver-space position of grid corner (0,0,0). */
  origin: [number, number, number];
  cellType: Uint8Array;
  /**
   * Porous loss per cell along each axis, as k = ζ / (2·L) in 1/mm, so the drag rate is k·|v|
   * (quadratic loss, Δp = ζ·½ρv² over a thickness L).
   */
  beta: [Float32Array, Float32Array, Float32Array];
  fans: FanDisk[];
  louvres: Louvre[];
  heat: HeatSource[];
  /** Solver axis that points up in the real world, and its sign. */
  up: { axis: number; sign: number };
  /** Cells inside the case (for the "case air" number). */
  interior: Int32Array;
}

export interface SourceStats {
  id: string;
  label: string;
  watts: number;
  /** Flow-weighted temperature rise of the air entering the heat source. */
  inletRise: number;
  /** Mean rise of the air in the heat source. */
  meanRise: number;
}

export interface FlowStats {
  steps: number;
  time: number;
  sources: SourceStats[];
  caseRise: number;
  maxRise: number;
  divergence: number;
}

const RHO_CP = 1.2e-9 * 1005; // J/(mm³·K)
const G = 9810; // mm/s²
const BETA_T = 1 / 300; // 1/K, ideal gas near room temperature

export class FlowSolver {
  readonly s: Scene;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly h: number;
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  T: Float32Array;
  p: Float32Array;
  private u2: Float32Array;
  private v2: Float32Array;
  private w2: Float32Array;
  private T2: Float32Array;
  private div: Float32Array;
  private heatRate: Float32Array;
  steps = 0;
  time = 0;

  constructor(scene: Scene) {
    this.s = scene;
    [this.nx, this.ny, this.nz] = scene.n;
    this.h = scene.h;
    const { nx, ny, nz } = this;
    this.u = new Float32Array((nx + 1) * ny * nz);
    this.v = new Float32Array(nx * (ny + 1) * nz);
    this.w = new Float32Array(nx * ny * (nz + 1));
    this.u2 = new Float32Array(this.u.length);
    this.v2 = new Float32Array(this.v.length);
    this.w2 = new Float32Array(this.w.length);
    this.T = new Float32Array(nx * ny * nz);
    this.T2 = new Float32Array(this.T.length);
    this.p = new Float32Array(this.T.length);
    this.div = new Float32Array(this.T.length);
    // Kelvin per second added to each heated cell.
    this.heatRate = new Float32Array(this.T.length);
    const vol = this.h ** 3;
    for (const src of scene.heat) {
      if (!src.cells.length) continue;
      const k = src.watts / (src.cells.length * vol * RHO_CP);
      for (const c of src.cells) this.heatRate[c] += k;
    }
  }

  // ---------------------------------------------------------------- indexing

  cell(i: number, j: number, k: number) {
    return i + this.nx * (j + this.ny * k);
  }
  private iu(i: number, j: number, k: number) {
    return i + (this.nx + 1) * (j + this.ny * k);
  }
  private iv(i: number, j: number, k: number) {
    return i + this.nx * (j + (this.ny + 1) * k);
  }
  private iw(i: number, j: number, k: number) {
    return i + this.nx * (j + this.ny * k);
  }
  private solid(i: number, j: number, k: number) {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.s.cellType[this.cell(i, j, k)] === CELL_SOLID;
  }

  // ---------------------------------------------------------------- sampling (grid mm)

  private tri(arr: Float32Array, sx: number, sy: number, sz: number, fx: number, fy: number, fz: number, outside: number) {
    // sx..: array dims; fx..: continuous index
    if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > sx - 0.5 || fy > sy - 0.5 || fz > sz - 0.5) {
      if (outside === outside) return outside;
    }
    fx = Math.min(sx - 1.0001, Math.max(0, fx));
    fy = Math.min(sy - 1.0001, Math.max(0, fy));
    fz = Math.min(sz - 1.0001, Math.max(0, fz));
    const i = fx | 0;
    const j = fy | 0;
    const k = fz | 0;
    const x = fx - i;
    const y = fy - j;
    const z = fz - k;
    const sxy = sx * sy;
    const b = i + sx * j + sxy * k;
    const c00 = arr[b] * (1 - x) + arr[b + 1] * x;
    const c10 = arr[b + sx] * (1 - x) + arr[b + sx + 1] * x;
    const c01 = arr[b + sxy] * (1 - x) + arr[b + sxy + 1] * x;
    const c11 = arr[b + sxy + sx] * (1 - x) + arr[b + sxy + sx + 1] * x;
    return (c00 * (1 - y) + c10 * y) * (1 - z) + (c01 * (1 - y) + c11 * y) * z;
  }

  /** Velocity at a point in grid millimetres. */
  sampleU(x: number, y: number, z: number) {
    const h = this.h;
    return this.tri(this.u, this.nx + 1, this.ny, this.nz, x / h, y / h - 0.5, z / h - 0.5, NaN);
  }
  sampleV(x: number, y: number, z: number) {
    const h = this.h;
    return this.tri(this.v, this.nx, this.ny + 1, this.nz, x / h - 0.5, y / h, z / h - 0.5, NaN);
  }
  sampleW(x: number, y: number, z: number) {
    const h = this.h;
    return this.tri(this.w, this.nx, this.ny, this.nz + 1, x / h - 0.5, y / h - 0.5, z / h, NaN);
  }
  sampleT(x: number, y: number, z: number) {
    const h = this.h;
    return this.tri(this.T, this.nx, this.ny, this.nz, x / h - 0.5, y / h - 0.5, z / h - 0.5, 0);
  }

  // ---------------------------------------------------------------- step

  step(dt: number, pressureIters = 24) {
    this.advectVelocity(dt);
    this.applyFans(dt);
    this.applyLouvres();
    this.applyBuoyancy(dt);
    this.applyDrag(dt);
    this.enforceSolids();
    this.project(pressureIters);
    this.advectHeat(dt);
    this.steps++;
    this.time += dt;
  }

  /** A stable time step for the current flow (semi-Lagrangian, so CFL up to ~3 is fine). */
  suggestDt() {
    let vmax = 200;
    for (const f of this.s.fans) vmax = Math.max(vmax, Math.min(f.vmax, 2 * f.speed + 300) * (1 + f.swirl));
    return Math.min(0.03, (2.5 * this.h) / vmax);
  }

  private advectVelocity(dt: number) {
    const { nx, ny, nz, h } = this;
    const back = (x: number, y: number, z: number, out: Float32Array, idx: number, which: 0 | 1 | 2) => {
      let vx = this.sampleU(x, y, z);
      let vy = this.sampleV(x, y, z);
      let vz = this.sampleW(x, y, z);
      if (vx !== vx) vx = 0;
      if (vy !== vy) vy = 0;
      if (vz !== vz) vz = 0;
      const px = x - dt * vx;
      const py = y - dt * vy;
      const pz = z - dt * vz;
      const s = which === 0 ? this.sampleU(px, py, pz) : which === 1 ? this.sampleV(px, py, pz) : this.sampleW(px, py, pz);
      out[idx] = s === s ? s : 0; // room air beyond the domain is still
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) back(i * h, (j + 0.5) * h, (k + 0.5) * h, this.u2, this.iu(i, j, k), 0);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) back((i + 0.5) * h, j * h, (k + 0.5) * h, this.v2, this.iv(i, j, k), 1);
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) back((i + 0.5) * h, (j + 0.5) * h, k * h, this.w2, this.iw(i, j, k), 2);
    [this.u, this.u2] = [this.u2, this.u];
    [this.v, this.v2] = [this.v2, this.v];
    [this.w, this.w2] = [this.w2, this.w];
  }

  /** Cell-centre velocity. */
  centre(c: number): [number, number, number] {
    const i = c % this.nx;
    const j = Math.floor(c / this.nx) % this.ny;
    const k = Math.floor(c / (this.nx * this.ny));
    return [
      0.5 * (this.u[this.iu(i, j, k)] + this.u[this.iu(i + 1, j, k)]),
      0.5 * (this.v[this.iv(i, j, k)] + this.v[this.iv(i, j + 1, k)]),
      0.5 * (this.w[this.iw(i, j, k)] + this.w[this.iw(i, j, k + 1)]),
    ];
  }

  /** Add a velocity change at a cell centre by shifting both faces on each axis. */
  private nudge(c: number, d: [number, number, number]) {
    const i = c % this.nx;
    const j = Math.floor(c / this.nx) % this.ny;
    const k = Math.floor(c / (this.nx * this.ny));
    this.u[this.iu(i, j, k)] += d[0];
    this.u[this.iu(i + 1, j, k)] += d[0];
    this.v[this.iv(i, j, k)] += d[1];
    this.v[this.iv(i, j + 1, k)] += d[1];
    this.w[this.iw(i, j, k)] += d[2];
    this.w[this.iw(i, j, k + 1)] += d[2];
  }

  /**
   * Fans as pressure jumps following a straight fan curve, Δp = Pmax·(1 − v/vmax), applied
   * semi-implicitly: v' = (v + dt·a0) / (1 + dt·a0/vmax). Swirl relaxes toward a share of the axial speed.
   */
  private applyFans(dt: number) {
    const relax = Math.min(1, 20 * dt);
    const { nx, ny, h } = this;
    for (const f of this.s.fans) {
      for (const c of f.cells) {
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / (nx * ny));
        const cur = this.centre(c);
        const axial = cur[f.axis] * f.sign;
        const next = (axial + dt * f.a0) / (1 + (dt * f.a0) / f.vmax);
        const d: [number, number, number] = [0, 0, 0];
        d[f.axis] = (next - axial) * f.sign;
        // Swirl: tangential velocity around the fan axis (right-handed about the blow direction).
        const pos = [(i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h];
        const r = [pos[0] - f.center[0], pos[1] - f.center[1], pos[2] - f.center[2]];
        r[f.axis] = 0;
        const a = [0, 0, 0];
        a[f.axis] = f.sign;
        const t = [a[1] * r[2] - a[2] * r[1], a[2] * r[0] - a[0] * r[2], a[0] * r[1] - a[1] * r[0]];
        const tl = Math.hypot(t[0], t[1], t[2]);
        if (tl > 1e-6) {
          const want = Math.max(0, next) * f.swirl;
          for (let q = 0; q < 3; q++) if (q !== f.axis) d[q] = ((t[q] / tl) * want - cur[q]) * relax;
        }
        this.nudge(c, d);
      }
    }
  }

  private applyLouvres() {
    for (const l of this.s.louvres) {
      for (const c of l.cells) {
        const cur = this.centre(c);
        const out = cur[0] * l.normal[0] + cur[1] * l.normal[1] + cur[2] * l.normal[2];
        if (out <= 0) continue; // only bends air that is leaving
        const mag = Math.hypot(cur[0], cur[1], cur[2]);
        const k = 0.5;
        this.nudge(c, [(l.dir[0] * mag - cur[0]) * k, (l.dir[1] * mag - cur[1]) * k, (l.dir[2] * mag - cur[2]) * k]);
      }
    }
  }

  private applyBuoyancy(dt: number) {
    const { nx, ny, nz } = this;
    const { axis, sign } = this.s.up;
    const k0 = G * BETA_T * dt * sign;
    if (axis === 0)
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) this.u[this.iu(i, j, k)] += k0 * 0.5 * (this.T[this.cell(i - 1, j, k)] + this.T[this.cell(i, j, k)]);
    else if (axis === 1)
      for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) this.v[this.iv(i, j, k)] += k0 * 0.5 * (this.T[this.cell(i, j - 1, k)] + this.T[this.cell(i, j, k)]);
    else for (let k = 1; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) this.w[this.iw(i, j, k)] += k0 * 0.5 * (this.T[this.cell(i, j, k - 1)] + this.T[this.cell(i, j, k)]);
  }

  /** Quadratic porous drag, implicit in the face velocity: v' = v / (1 + k·|v|·dt). */
  private applyDrag(dt: number) {
    const { nx, ny, nz } = this;
    const [bx, by, bz] = this.s.beta;
    const face = (a: number, b: number, arr: Float32Array) => Math.max(a >= 0 ? arr[a] : 0, b >= 0 ? arr[b] : 0);
    const damp = (arr: Float32Array, id: number, k: number) => {
      if (k <= 0) return;
      const v = arr[id];
      // Floor |v| so a still cell still feels a (linear) resistance.
      arr[id] = v / (1 + k * Math.max(Math.abs(v), 150) * dt);
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) damp(this.u, this.iu(i, j, k), face(i > 0 ? this.cell(i - 1, j, k) : -1, i < nx ? this.cell(i, j, k) : -1, bx));
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) damp(this.v, this.iv(i, j, k), face(j > 0 ? this.cell(i, j - 1, k) : -1, j < ny ? this.cell(i, j, k) : -1, by));
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) damp(this.w, this.iw(i, j, k), face(k > 0 ? this.cell(i, j, k - 1) : -1, k < nz ? this.cell(i, j, k) : -1, bz));
  }

  private enforceSolids() {
    const { nx, ny, nz } = this;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) if (this.solid(i - 1, j, k) || this.solid(i, j, k)) this.u[this.iu(i, j, k)] = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) if (this.solid(i, j - 1, k) || this.solid(i, j, k)) this.v[this.iv(i, j, k)] = 0;
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) if (this.solid(i, j, k - 1) || this.solid(i, j, k)) this.w[this.iw(i, j, k)] = 0;
  }

  private computeDivergence() {
    const { nx, ny, nz, h } = this;
    let max = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = this.cell(i, j, k);
          if (this.s.cellType[c] === CELL_SOLID) {
            this.div[c] = 0;
            continue;
          }
          const d =
            (this.u[this.iu(i + 1, j, k)] - this.u[this.iu(i, j, k)] + this.v[this.iv(i, j + 1, k)] - this.v[this.iv(i, j, k)] + this.w[this.iw(i, j, k + 1)] - this.w[this.iw(i, j, k)]) /
            h;
          this.div[c] = d;
          max = Math.max(max, Math.abs(d));
        }
    return max;
  }

  /** Max |∇·u| (1/s) over fluid cells. */
  divergence() {
    return this.computeDivergence();
  }

  private project(iters: number) {
    const { nx, ny, nz, h } = this;
    this.computeDivergence();
    const p = this.p;
    const type = this.s.cellType;
    const h2 = h * h;
    const omega = 1.75;
    for (let it = 0; it < iters; it++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let k = 0; k < nz; k++)
          for (let j = 0; j < ny; j++)
            for (let i = (j + k + colour) & 1; i < nx; i += 2) {
              const c = i + nx * (j + ny * k);
              if (type[c] === CELL_SOLID) continue;
              let sum = 0;
              let cnt = 0;
              // Outside the domain: open air at p = 0. Solid neighbours: no flux (skipped).
              if (i === 0) cnt++;
              else if (type[c - 1] !== CELL_SOLID) (sum += p[c - 1]), cnt++;
              if (i === nx - 1) cnt++;
              else if (type[c + 1] !== CELL_SOLID) (sum += p[c + 1]), cnt++;
              if (j === 0) cnt++;
              else if (type[c - nx] !== CELL_SOLID) (sum += p[c - nx]), cnt++;
              if (j === ny - 1) cnt++;
              else if (type[c + nx] !== CELL_SOLID) (sum += p[c + nx]), cnt++;
              if (k === 0) cnt++;
              else if (type[c - nx * ny] !== CELL_SOLID) (sum += p[c - nx * ny]), cnt++;
              if (k === nz - 1) cnt++;
              else if (type[c + nx * ny] !== CELL_SOLID) (sum += p[c + nx * ny]), cnt++;
              if (cnt === 0) continue;
              const target = (sum - this.div[c] * h2) / cnt;
              p[c] += omega * (target - p[c]);
            }
      }
    }
    const P = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : p[this.cell(i, j, k)]);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) if (!this.solid(i - 1, j, k) && !this.solid(i, j, k)) this.u[this.iu(i, j, k)] -= (P(i, j, k) - P(i - 1, j, k)) / h;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) if (!this.solid(i, j - 1, k) && !this.solid(i, j, k)) this.v[this.iv(i, j, k)] -= (P(i, j, k) - P(i, j - 1, k)) / h;
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) if (!this.solid(i, j, k - 1) && !this.solid(i, j, k)) this.w[this.iw(i, j, k)] -= (P(i, j, k) - P(i, j, k - 1)) / h;
  }

  private advectHeat(dt: number) {
    const { nx, ny, nz, h } = this;
    const type = this.s.cellType;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = this.cell(i, j, k);
          if (type[c] === CELL_SOLID) {
            this.T2[c] = 0;
            continue;
          }
          const [vx, vy, vz] = this.centre(c);
          const x = (i + 0.5) * h - dt * vx;
          const y = (j + 0.5) * h - dt * vy;
          const z = (k + 0.5) * h - dt * vz;
          this.T2[c] = this.sampleT(x, y, z) + this.heatRate[c] * dt;
        }
    // Turbulent mixing (explicit, stable for alpha < 1/6), no flux into solids.
    const alpha = Math.min(0.14, (1500 * dt) / (h * h));
    const T = this.T;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = this.cell(i, j, k);
          if (type[c] === CELL_SOLID) {
            T[c] = 0;
            continue;
          }
          const tc = this.T2[c];
          let acc = 0;
          const add = (ii: number, jj: number, kk: number) => {
            if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) {
              acc += 0 - tc; // room air at the far boundary
              return;
            }
            const n = this.cell(ii, jj, kk);
            if (type[n] !== CELL_SOLID) acc += this.T2[n] - tc;
          };
          add(i - 1, j, k);
          add(i + 1, j, k);
          add(i, j - 1, k);
          add(i, j + 1, k);
          add(i, j, k - 1);
          add(i, j, k + 1);
          T[c] = Math.max(0, tc + alpha * acc);
        }
  }

  // ---------------------------------------------------------------- results

  stats(): FlowStats {
    const { nx, ny, nz } = this;
    const sources: SourceStats[] = [];
    for (const src of this.s.heat) {
      if (!src.cells.length) continue;
      const inSet = new Set<number>(src.cells as unknown as number[]);
      let flux = 0;
      let tflux = 0;
      let mean = 0;
      for (const c of src.cells) {
        mean += this.T[c];
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / (nx * ny));
        // inflow through each face from a neighbour outside the set
        const faces: [number, number, number, number][] = [
          [i - 1, j, k, this.u[this.iu(i, j, k)]],
          [i + 1, j, k, -this.u[this.iu(i + 1, j, k)]],
          [i, j - 1, k, this.v[this.iv(i, j, k)]],
          [i, j + 1, k, -this.v[this.iv(i, j + 1, k)]],
          [i, j, k - 1, this.w[this.iw(i, j, k)]],
          [i, j, k + 1, -this.w[this.iw(i, j, k + 1)]],
        ];
        for (const [a, b, d, inflow] of faces) {
          if (inflow <= 0) continue;
          if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) {
            flux += inflow;
            continue;
          }
          const nb = this.cell(a, b, d);
          if (inSet.has(nb) || this.s.cellType[nb] === CELL_SOLID) continue;
          flux += inflow;
          tflux += inflow * this.T[nb];
        }
      }
      sources.push({ id: src.id, label: src.label, watts: src.watts, inletRise: flux > 0 ? tflux / flux : 0, meanRise: mean / src.cells.length });
    }
    let caseRise = 0;
    for (const c of this.s.interior) caseRise += this.T[c];
    caseRise /= Math.max(1, this.s.interior.length);
    let maxRise = 0;
    for (let c = 0; c < this.T.length; c++) maxRise = Math.max(maxRise, this.T[c]);
    return { steps: this.steps, time: this.time, sources, caseRise, maxRise, divergence: this.computeDivergence() };
  }

  /** Cell-centre velocity (mm/s) and temperature rise, for drawing. */
  snapshot() {
    const n = this.T.length;
    const vel = new Float32Array(n * 3);
    for (let c = 0; c < n; c++) {
      if (this.s.cellType[c] === CELL_SOLID) continue;
      const v = this.centre(c);
      vel[3 * c] = v[0];
      vel[3 * c + 1] = v[1];
      vel[3 * c + 2] = v[2];
    }
    return { vel, T: this.T.slice() };
  }
}

/** Heat-weighted inlet air rise plus half the case air rise: lower is better. */
export function thermalScore(st: FlowStats): number {
  let w = 0;
  let acc = 0;
  for (const s of st.sources) {
    w += s.watts;
    acc += s.watts * s.inletRise;
  }
  return (w > 0 ? acc / w : 0) + 0.5 * st.caseRise;
}
