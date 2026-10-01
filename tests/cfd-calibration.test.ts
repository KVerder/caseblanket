import { describe, expect, it } from 'vitest';
import { FANS } from '../src/model/presets';
import { fanForcing, porousBeta } from '../src/cfd/scene';
import { CELL_SOLID, FlowSolver, type Scene } from '../src/cfd/solver';
import { operatingFlow, perforatedPlateZeta, type LossTerm } from '../src/solver/airflow';

/**
 * Calibration: a 120 mm fan in a square duct open to still room air at both ends, blowing
 * through a porous block (radiator core or perforated panel). The 3D sim's volume flow is
 * compared with the fan-curve model for the same fan and losses, plus the duct's own entry
 * and exit losses (ζ ≈ 0.5 + 1.0 on the duct area, which the 3D sim resolves by itself).
 */
function duct(h: number, block: { zeta: number; thickness: number } | null) {
  const side = 120;
  const m = Math.round(side / h); // duct cells across
  const pad = 3;
  const ny = m + 2 * pad;
  const nz = ny;
  const len = Math.round(360 / h);
  const nx = len + 2 * Math.round(80 / h);
  const x0 = Math.round(80 / h);
  const total = nx * ny * nz;
  const cellType = new Uint8Array(total);
  const beta: Scene['beta'] = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const lo = pad;
  const hi = pad + m; // duct interior j,k in [lo, hi)
  for (let i = x0; i < x0 + len; i++)
    for (let j = lo - 1; j <= hi; j++)
      for (let k = lo - 1; k <= hi; k++) if (j === lo - 1 || j === hi || k === lo - 1 || k === hi) cellType[id(i, j, k)] = CELL_SOLID;
  const fanI = x0 + Math.round(len / 4);
  const fanCells: number[] = [];
  for (let j = lo; j < hi; j++) for (let k = lo; k < hi; k++) fanCells.push(id(fanI, j, k));
  const area = m * m * h * h;
  const { vmax, a0 } = fanForcing(FANS.a12x25, area, 1, h);
  if (block) {
    const n = Math.max(1, Math.round(block.thickness / h));
    const b = porousBeta(block.zeta, n, h);
    const bi = x0 + Math.round(len / 2);
    for (let i = bi; i < bi + n; i++) for (let j = lo; j < hi; j++) for (let k = lo; k < hi; k++) beta[0][id(i, j, k)] = b;
  }
  const scene: Scene = {
    n: [nx, ny, nz],
    h,
    origin: [0, 0, 0],
    cellType,
    beta,
    fans: [{ cells: Int32Array.from(fanCells), axis: 0, sign: 1, speed: 500, vmax, a0, center: [(fanI + 0.5) * h, ((lo + hi) / 2) * h, ((lo + hi) / 2) * h], swirl: 0, group: 'fan', layers: 1, pmaxPa: FANS.a12x25.maxPressureMmH2O * 9.80665 }],
    louvres: [],
    heat: [],
    up: { axis: 1, sign: 1 },
    interior: new Int32Array(0),
  };
  const sim = new FlowSolver(scene);
  const measureI = x0 + Math.round((3 * len) / 4);
  const flow = () => {
    let q = 0;
    for (let j = lo; j < hi; j++) for (let k = lo; k < hi; k++) q += sim.u[measureI + (nx + 1) * (j + ny * k)];
    return (q * h * h) / 1e9; // m³/s
  };
  return { sim, flow, areaM2: area / 1e6 };
}


function run(h: number, block: { zeta: number; thickness: number } | null) {
  const { sim, flow, areaM2 } = duct(h, block);
  let t = 0;
  while (t < 2.5) {
    const dt = sim.suggestDt();
    sim.step(dt, 40);
    t += dt;
  }
  const losses: LossTerm[] = [{ label: 'duct entry + exit', zeta: 1.5, area: areaM2 }];
  if (block) losses.push({ label: 'block', zeta: block.zeta, area: areaM2 });
  return { sim3d: flow(), model: operatingFlow(FANS.a12x25, 1, losses, 0) };
}

describe('3D simulation calibration against the fan-curve model', () => {
  const cases: [string, { zeta: number; thickness: number } | null][] = [
    ['open duct', null],
    ['perforated panel (50 % open)', { zeta: perforatedPlateZeta(0.5), thickness: 1 }],
    ['radiator core (27 mm)', { zeta: 13, thickness: 27 }],
  ];
  for (const [name, block] of cases) {
    it(`matches airflow within 20 % for a fan through a ${name}`, () => {
      const r = run(10, block);
      const err = r.sim3d / r.model - 1;
      console.log(`${name}: 3D ${(r.sim3d * 2118.88).toFixed(1)} CFM, model ${(r.model * 2118.88).toFixed(1)} CFM, ${(err * 100).toFixed(0)} %`);
      expect(Math.abs(err)).toBeLessThan(0.2);
    });
  }

  it('gives the same radiator airflow on a grid twice as fine (within 10 %)', () => {
    const block = { zeta: 13, thickness: 27 };
    const coarse = run(12, block).sim3d;
    const fine = run(6, block).sim3d;
    console.log(`grid refinement: ${(coarse * 2118.88).toFixed(1)} CFM at 12 mm, ${(fine * 2118.88).toFixed(1)} CFM at 6 mm`);
    expect(Math.abs(fine / coarse - 1)).toBeLessThan(0.1);
  });
});

/** Roache's grid convergence index from three solutions (fine f1, medium f2, coarse f3). */
export function gci(f1: number, f2: number, f3: number, h1: number, h2: number, h3: number) {
  const r21 = h2 / h1;
  const r32 = h3 / h2;
  const e21 = f2 - f1;
  const e32 = f3 - f2;
  const s = Math.sign(e32 / e21);
  let p = 1;
  for (let i = 0; i < 50; i++) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s));
    p = Math.abs(Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21);
  }
  const gciFine = (1.25 * Math.abs(e21 / f1)) / (r21 ** p - 1);
  return { p, gciFine, monotone: e21 * e32 > 0 };
}

describe('grid convergence (GCI, three levels)', () => {
  it('has a radiator-duct airflow converged to within 5 % on the app grid', () => {
    const hs = [6, 8.5, 12];
    const f = hs.map((h) => run(h, { zeta: 13, thickness: 27 }).sim3d);
    const g = gci(f[0], f[1], f[2], hs[0], hs[1], hs[2]);
    console.log(`radiator duct: ${f.map((x) => (x * 2118.88).toFixed(2)).join(' / ')} CFM at ${hs.join(' / ')} mm; p = ${g.p.toFixed(2)}, GCI = ${(g.gciFine * 100).toFixed(2)} %, ${g.monotone ? 'monotone' : 'oscillating'}`);
    // Oscillating convergence: the spread itself bounds the error.
    const bound = g.monotone ? g.gciFine : (Math.max(...f) - Math.min(...f)) / f[0];
    expect(bound).toBeLessThan(0.05);
  }, 300000);
});
