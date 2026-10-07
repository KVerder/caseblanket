/**
 * Coarse 3D incompressible flow + heat solver on a staggered (MAC) grid.
 *
 * Units: millimetres, seconds, kelvin above room temperature, watts.
 * Each step: semi-Lagrangian advection → fan swirl, louvres, buoyancy → pressure projection
 * (red-black SOR, open far boundary at p = 0) with porous drag and fan-curve pressure jumps
 * folded in implicitly as per-face coefficients → heat advection, sources and a turbulent
 * diffusion term.
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
  /** Cells along the axis (the jump is shared between them). */
  layers?: number;
  /** Stall pressure, Pa. */
  pmaxPa?: number;
  /**
   * Tilted disk: unit blow direction and the disk's thickness (mm). The jump is then spread as a
   * body force over the thickness and applied on the faces of every axis the direction has a share
   * of; `axis`/`sign` are the dominant axis (used for the swirl).
   */
  dir?: [number, number, number];
  thickness?: number;
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
  /**
   * A liquid-to-air heat exchanger (radiator core): instead of releasing its heat evenly in every
   * cell, each cell exchanges heat with coolant at one temperature, at a rate set by its local air
   * speed (ε-NTU per column, h ∝ v^HX_VEL_EXP), and the coolant temperature is whatever delivers the
   * source's watts. At even flow the core's effectiveness is `eff`; air in a starved column can heat
   * no further than the coolant, as in a real core. `thickness` is the core depth along the flow, mm.
   */
  exchanger?: { eff: number; thickness: number };
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
  /** What the grid was built from, in solver millimetres (scenes from buildScene). */
  geometry?: import('./scene').SceneGeometry;
}

export interface SourceStats {
  id: string;
  label: string;
  watts: number;
  /** Flow-weighted temperature rise of the air entering the heat source. */
  inletRise: number;
  /** Mean rise of the air in the heat source. */
  meanRise: number;
  /** Heat exchangers: coolant temperature rise above room, K (see HeatSource.exchanger). */
  coolantRise?: number;
}

export interface FlowStats {
  steps: number;
  time: number;
  sources: SourceStats[];
  caseRise: number;
  maxRise: number;
  divergence: number;
  /** Recirculation and uniformity, on the final state of a run. */
  quality?: FlowQuality;
}

/** Flow-quality metrics of a simulated design. */
export interface FlowQuality {
  /**
   * Per fan group: air temperature rise at the fan as a share of the heat sources' mean rise (heat-
   * weighted). For an intake fan that is the share of its air that is recirculated exhaust.
   */
  recirculation: { group: string; share: number }[];
  /** Per radiator core or fin stack: uniformity index 1 − Σ|v − v̄| / (2·n·|v̄|) (1 = perfectly even). */
  uniformity: { label: string; index: number }[];
}

const RHO_CP = 1.2e-9 * 1005; // J/(mm³·K)
/**
 * Air-side heat transfer coefficient ∝ v^n in louvred-fin cores: Chang & Wang (1997) give the
 * Colburn factor j ∝ Re^-0.49, so h ∝ Re^0.51 (cited from memory, not verified against the paper).
 */
export const HX_VEL_EXP = 0.51;
const RHO_AIR = 1.2; // kg/m³
/** A fan's stall pressure, Pa: given, or recovered from its stall acceleration over the disk depth. */
const pmaxPa = (f: FanDisk, h: number) => f.pmaxPa ?? (f.a0 / 1000) * RHO_AIR * ((Math.max(1, f.layers ?? 1) * h) / 1000);
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
  /** Per-face projection coefficients: v = W·(v* − Δp/h) + S (porous drag, fan jumps). */
  private Wu: Float32Array;
  private Wv: Float32Array;
  private Ww: Float32Array;
  private Su: Float32Array;
  private Sv: Float32Array;
  private Sw: Float32Array;
  private heatRate: Float32Array;
  /** Coolant temperature rise per exchanger source id. */
  private coolant = new Map<string, number>();
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
    this.Wu = new Float32Array(this.u.length).fill(1);
    this.Wv = new Float32Array(this.v.length).fill(1);
    this.Ww = new Float32Array(this.w.length).fill(1);
    this.Su = new Float32Array(this.u.length);
    this.Sv = new Float32Array(this.v.length);
    this.Sw = new Float32Array(this.w.length);
    this.T = new Float32Array(nx * ny * nz);
    this.T2 = new Float32Array(this.T.length);
    this.p = new Float32Array(this.T.length);
    this.div = new Float32Array(this.T.length);
    // Kelvin per second added to each heated cell.
    this.heatRate = new Float32Array(this.T.length);
    const vol = this.h ** 3;
    for (const src of scene.heat) {
      if (!src.cells.length || src.exchanger) continue;
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
    this.enforceSolids();
    this.buildFaceCoefficients(dt);
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
   * Fan disks as pressure jumps (an interior baffle, like OpenFOAM's fan condition): across each
   * disk face in the blow direction the pressure rises by Δp = Pmax·(1 − v/vmax) from the fan
   * curve, shared between the disk's layers. The jump's dependence on the face velocity is solved
   * implicitly inside the pressure projection (each fan face gets a reduced conductance
   * w = 1/(1 + R/h) and a source), so it holds at any time step.
   */
  private fanFaces: { arr: 0 | 1 | 2; face: number; sign: number; fan: number; share: number; nq: number }[] | null = null;

  private buildFanFaces() {
    const { nx, ny } = this;
    const out: NonNullable<typeof this.fanFaces> = [];
    this.s.fans.forEach((f, fi) => {
      // Axis-aligned disk: the jump on its own axis, shared between its layers. Tilted disk: a body
      // force along `dir` over its thickness, on the faces of each axis by that axis's share.
      const parts: { axis: number; sign: number; share: number; nq: number }[] = f.dir
        ? [0, 1, 2]
            .filter((q) => Math.abs(f.dir![q]) > 0.15)
            .map((q) => ({ axis: q, sign: Math.sign(f.dir![q]), nq: Math.abs(f.dir![q]), share: (Math.abs(f.dir![q]) * this.h) / Math.max(this.h, f.thickness ?? this.h) }))
        : [{ axis: f.axis, sign: f.sign, share: 1 / Math.max(1, f.layers ?? 1), nq: 1 }];
      for (const c of f.cells) {
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / (nx * ny));
        for (const pa of parts) {
          // Face on the downstream side of the cell.
          const fIdx = [i, j, k];
          if (pa.sign > 0) fIdx[pa.axis] += 1;
          const n = [this.nx, this.ny, this.nz][pa.axis];
          if (fIdx[pa.axis] <= 0 || fIdx[pa.axis] >= n) continue;
          const m = [...fIdx];
          m[pa.axis] -= 1;
          if (this.s.cellType[this.cell(m[0], m[1], m[2])] === CELL_SOLID || this.s.cellType[this.cell(fIdx[0], fIdx[1], fIdx[2])] === CELL_SOLID) continue;
          const face = pa.axis === 0 ? this.iu(fIdx[0], fIdx[1], fIdx[2]) : pa.axis === 1 ? this.iv(fIdx[0], fIdx[1], fIdx[2]) : this.iw(fIdx[0], fIdx[1], fIdx[2]);
          out.push({ arr: pa.axis as 0 | 1 | 2, face, sign: pa.sign, fan: fi, share: pa.share, nq: pa.nq });
        }
      }
    });
    this.fanFaces = out;
  }

  /**
   * Face coefficients for the projection: every face's final velocity is v = W·(v* − Δp/h) + S.
   * Porous drag (Δp = ζ·½ρv², spread as k·|v|·v per mm) gives W = 1/(1 + k·|v*|·dt). A fan face
   * adds the fan-curve jump J = J0 − R·v (Δp = Pmax·(1 − v/vmax), shared between the disk's
   * layers): W = D/(1 + D·R/h), S = W·J0/h. Both are implicit, so they act in full at any dt.
   */
  private buildFaceCoefficients(dt: number) {
    if (!this.fanFaces) this.buildFanFaces();
    const { nx, ny, nz } = this;
    const [bx, by, bz] = this.s.beta;
    const W = [this.Wu, this.Wv, this.Ww];
    const S = [this.Su, this.Sv, this.Sw];
    const V = [this.u, this.v, this.w];
    for (let a = 0; a < 3; a++) {
      W[a].fill(1);
      S[a].fill(0);
    }
    const face = (a: number, b: number, arr: Float32Array) => Math.max(a >= 0 ? arr[a] : 0, b >= 0 ? arr[b] : 0);
    const drag = (Wa: Float32Array, Va: Float32Array, id: number, k: number) => {
      if (k <= 0) return;
      // Floor |v| so a still cell still feels a (linear) resistance.
      Wa[id] = 1 / (1 + k * Math.max(Math.abs(Va[id]), 150) * dt);
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) drag(this.Wu, this.u, this.iu(i, j, k), face(i > 0 ? this.cell(i - 1, j, k) : -1, i < nx ? this.cell(i, j, k) : -1, bx));
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) drag(this.Wv, this.v, this.iv(i, j, k), face(j > 0 ? this.cell(i, j - 1, k) : -1, j < ny ? this.cell(i, j, k) : -1, by));
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) drag(this.Ww, this.w, this.iw(i, j, k), face(k > 0 ? this.cell(i, j, k - 1) : -1, k < nz ? this.cell(i, j, k) : -1, bz));
    const kin = (1e6 * dt) / RHO_AIR; // Pa → kinematic pressure × dt (projection units, mm²/s)
    for (const ff of this.fanFaces!) {
      const f = this.s.fans[ff.fan];
      const pm = pmaxPa(f, this.h) * kin * ff.share;
      // Δp falls with the speed along the disk normal, v_n ≈ v_q / n_q on this face.
      const R = pm / (f.vmax * ff.nq); // mm
      const D = W[ff.arr][ff.face];
      const w = D / (1 + (D * R) / this.h);
      W[ff.arr][ff.face] = w;
      S[ff.arr][ff.face] = (w * ff.sign * pm) / this.h;
    }
    void V;
  }

  /** Swirl behind each fan: tangential velocity around the axis, a share of the axial speed. */
  private applyFans(dt: number) {
    const relax = Math.min(1, 20 * dt);
    const { nx, ny, h } = this;
    for (const f of this.s.fans) {
      if (f.swirl <= 0) continue;
      for (const c of f.cells) {
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / (nx * ny));
        const cur = this.centre(c);
        const axial = Math.max(0, cur[f.axis] * f.sign);
        const d: [number, number, number] = [0, 0, 0];
        const pos = [(i + 0.5) * h, (j + 0.5) * h, (k + 0.5) * h];
        const r = [pos[0] - f.center[0], pos[1] - f.center[1], pos[2] - f.center[2]];
        r[f.axis] = 0;
        const a = [0, 0, 0];
        a[f.axis] = f.sign;
        const t = [a[1] * r[2] - a[2] * r[1], a[2] * r[0] - a[0] * r[2], a[0] * r[1] - a[1] * r[0]];
        const tl = Math.hypot(t[0], t[1], t[2]);
        if (tl < 1e-6) continue;
        for (let q = 0; q < 3; q++) if (q !== f.axis) d[q] = ((t[q] / tl) * axial * f.swirl - cur[q]) * relax;
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
    const p = this.p;
    const type = this.s.cellType;
    const h2 = h * h;
    const omega = 1.75;
    const { Wu, Wv, Ww, Su, Sv, Sw, u, v, w } = this;
    // Predicted face velocities q = W·v* + S, and their divergence.
    for (let id = 0; id < u.length; id++) u[id] = Wu[id] * u[id] + Su[id];
    for (let id = 0; id < v.length; id++) v[id] = Wv[id] * v[id] + Sv[id];
    for (let id = 0; id < w.length; id++) w[id] = Ww[id] * w[id] + Sw[id];
    this.enforceSolids();
    this.computeDivergence();
    const sx = 1;
    const sy = nx + 1;
    const sz = (nx + 1) * ny;
    for (let it = 0; it < iters; it++) {
      for (let colour = 0; colour < 2; colour++) {
        for (let k = 0; k < nz; k++)
          for (let j = 0; j < ny; j++)
            for (let i = (j + k + colour) & 1; i < nx; i += 2) {
              const c = i + nx * (j + ny * k);
              if (type[c] === CELL_SOLID) continue;
              // Σ W·(p_n − p_c) = h²·div(q); outside the domain is open air at p = 0; solids carry no flux.
              let sum = 0;
              let den = 0;
              const fu = i + sy * j + sz * k; // u face at i
              const fv = i + nx * (j + (ny + 1) * k); // v face at j
              const fw = i + nx * (j + ny * k); // w face at k
              let wt = Wu[fu];
              if (i === 0) den += wt;
              else if (type[c - 1] !== CELL_SOLID) (sum += wt * p[c - 1]), (den += wt);
              wt = Wu[fu + sx];
              if (i === nx - 1) den += wt;
              else if (type[c + 1] !== CELL_SOLID) (sum += wt * p[c + 1]), (den += wt);
              wt = Wv[fv];
              if (j === 0) den += wt;
              else if (type[c - nx] !== CELL_SOLID) (sum += wt * p[c - nx]), (den += wt);
              wt = Wv[fv + nx];
              if (j === ny - 1) den += wt;
              else if (type[c + nx] !== CELL_SOLID) (sum += wt * p[c + nx]), (den += wt);
              wt = Ww[fw];
              if (k === 0) den += wt;
              else if (type[c - nx * ny] !== CELL_SOLID) (sum += wt * p[c - nx * ny]), (den += wt);
              wt = Ww[fw + nx * ny];
              if (k === nz - 1) den += wt;
              else if (type[c + nx * ny] !== CELL_SOLID) (sum += wt * p[c + nx * ny]), (den += wt);
              if (den <= 0) continue;
              p[c] += omega * ((sum - this.div[c] * h2) / den - p[c]);
            }
      }
    }
    const P = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : p[this.cell(i, j, k)]);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) {
          const id = this.iu(i, j, k);
          if (!this.solid(i - 1, j, k) && !this.solid(i, j, k)) u[id] -= (Wu[id] * (P(i, j, k) - P(i - 1, j, k))) / h;
        }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) {
          const id = this.iv(i, j, k);
          if (!this.solid(i, j - 1, k) && !this.solid(i, j, k)) v[id] -= (Wv[id] * (P(i, j, k) - P(i, j - 1, k))) / h;
        }
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const id = this.iw(i, j, k);
          if (!this.solid(i, j, k - 1) && !this.solid(i, j, k)) w[id] -= (Ww[id] * (P(i, j, k) - P(i, j, k - 1))) / h;
        }
  }

  /**
   * Radiator cores: each cell moves toward the coolant temperature Tc by a = 1 − exp(−r·dt), with
   * r = NTU₀·v̄^(1−n)·v^n / L (so a column of even flow v̄ through depth L reaches effectiveness
   * 1 − e^−NTU₀ = eff), and Tc is set so the cells take exactly the source's watts this step.
   */
  private applyExchangers(dt: number) {
    const vol = this.h ** 3;
    for (const src of this.s.heat) {
      const hx = src.exchanger;
      if (!hx || !src.cells.length) continue;
      const speeds = new Float32Array(src.cells.length);
      let mean = 0;
      src.cells.forEach((c, idx) => {
        const v = this.centre(c);
        speeds[idx] = Math.hypot(v[0], v[1], v[2]);
        mean += speeds[idx];
      });
      mean = Math.max(20, mean / src.cells.length); // mm/s; still air at start-up
      const ntu0 = -Math.log(1 - Math.min(0.98, Math.max(0.05, hx.eff)));
      const base = (ntu0 * Math.pow(mean, 1 - HX_VEL_EXP)) / Math.max(this.h, hx.thickness);
      let sumA = 0;
      let sumAT = 0;
      const a = new Float32Array(src.cells.length);
      src.cells.forEach((c, idx) => {
        const v = Math.max(0.02 * mean, speeds[idx]);
        a[idx] = 1 - Math.exp(-base * Math.pow(v, HX_VEL_EXP) * dt);
        sumA += a[idx];
        sumAT += a[idx] * this.T2[c];
      });
      if (sumA <= 0) continue;
      const tc = (src.watts * dt) / (RHO_CP * vol) / sumA + sumAT / sumA;
      this.coolant.set(src.id, tc);
      src.cells.forEach((c, idx) => {
        this.T2[c] += a[idx] * (tc - this.T2[c]);
      });
    }
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
    this.applyExchangers(dt);
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
      sources.push({ id: src.id, label: src.label, watts: src.watts, inletRise: flux > 0 ? tflux / flux : 0, meanRise: mean / src.cells.length, coolantRise: this.coolant.get(src.id) });
    }
    let caseRise = 0;
    for (const c of this.s.interior) caseRise += this.T[c];
    caseRise /= Math.max(1, this.s.interior.length);
    let maxRise = 0;
    for (let c = 0; c < this.T.length; c++) maxRise = Math.max(maxRise, this.T[c]);
    return { steps: this.steps, time: this.time, sources, caseRise, maxRise, divergence: this.computeDivergence() };
  }

  quality(): FlowQuality {
    const st = this.stats();
    const watts = st.sources.reduce((a, x) => a + x.watts, 0);
    const ref = watts > 0 ? st.sources.reduce((a, x) => a + x.watts * x.meanRise, 0) / watts : 0;
    const byGroup = new Map<string, { sum: number; n: number }>();
    for (const f of this.s.fans) {
      const g = byGroup.get(f.group) ?? { sum: 0, n: 0 };
      for (const c of f.cells) {
        g.sum += this.T[c];
        g.n++;
      }
      byGroup.set(f.group, g);
    }
    const recirculation = [...byGroup].map(([group, g]) => ({ group, share: ref > 0 && g.n ? g.sum / g.n / ref : 0 }));
    const uniformity: FlowQuality['uniformity'] = [];
    const geo = this.s.geometry;
    if (geo) {
      const h = this.h;
      const o = this.s.origin;
      for (const p of geo.porous) {
        if (!/core|fins/i.test(p.label) || p.along.length !== 1) continue;
        const a = p.along[0];
        const vals: number[] = [];
        const lo = [0, 1, 2].map((k) => Math.max(0, Math.ceil((p.box.min[k] - o[k]) / h - 0.5)));
        const hi = [0, 1, 2].map((k, idx) => Math.min([this.nx, this.ny, this.nz][idx] - 1, Math.floor((p.box.max[k] - o[k]) / h - 0.5)));
        for (let k = lo[2]; k <= hi[2]; k++)
          for (let j = lo[1]; j <= hi[1]; j++)
            for (let i = lo[0]; i <= hi[0]; i++) {
              if (this.s.cellType[this.cell(i, j, k)] === CELL_SOLID) continue;
              const x = (i + 0.5) * h;
              const y = (j + 0.5) * h;
              const z = (k + 0.5) * h;
              const v = a === 0 ? this.sampleU(x, y, z) : a === 1 ? this.sampleV(x, y, z) : this.sampleW(x, y, z);
              if (Number.isFinite(v)) vals.push(v);
            }
        if (vals.length < 4) continue;
        const mean = vals.reduce((s2, v) => s2 + v, 0) / vals.length;
        if (Math.abs(mean) < 1e-6) continue;
        const dev = vals.reduce((s2, v) => s2 + Math.abs(v - mean), 0);
        uniformity.push({ label: p.label, index: Math.max(0, 1 - dev / (2 * vals.length * Math.abs(mean))) });
      }
    }
    return { recirculation, uniformity };
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
