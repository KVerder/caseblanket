import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { buildScene } from '../src/cfd/scene';
import { CELL_SOLID, FlowSolver, type Scene } from '../src/cfd/solver';
import { simulate } from '../src/cfd/run';
import { solve } from '../src/solver/solve';

/** A bare test scene: n cells of size h, all fluid. */
function emptyScene(n: [number, number, number], h = 10): Scene {
  const total = n[0] * n[1] * n[2];
  return {
    n,
    h,
    origin: [0, 0, 0],
    cellType: new Uint8Array(total),
    beta: [new Float32Array(total), new Float32Array(total), new Float32Array(total)],
    fans: [],
    louvres: [],
    heat: [],
    up: { axis: 2, sign: 1 },
    interior: new Int32Array(0),
  };
}

const idx = (s: Scene, i: number, j: number, k: number) => i + s.n[0] * (j + s.n[1] * k);

describe('flow solver', () => {
  it('keeps a ducted fan flow divergence-free and close to the imposed flow', () => {
    // A square duct along x, walls around it, a fan in the middle.
    const s = emptyScene([30, 8, 8]);
    for (let k = 0; k < 8; k++)
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 30; i++) if (j === 0 || j === 7 || k === 0 || k === 7) s.cellType[idx(s, i, j, k)] = CELL_SOLID;
    const cells: number[] = [];
    for (let k = 1; k < 7; k++) for (let j = 1; j < 7; j++) cells.push(idx(s, 15, j, k));
    // Free-air 1000 mm/s, open duct: the fan should run close to free air.
    s.fans.push({ cells: Int32Array.from(cells), axis: 0, sign: 1, speed: 1000, vmax: 1000, a0: 2e5, center: [155, 40, 40], swirl: 0, group: 'f' });
    const sim = new FlowSolver(s);
    for (let t = 0; t < 300; t++) sim.step(0.01, 40);
    // Mean axial speed across the duct, a few cells downstream.
    let sum = 0;
    for (let k = 1; k < 7; k++) for (let j = 1; j < 7; j++) sum += sim.centre(idx(s, 22, j, k))[0];
    const mean = sum / 36;
    expect(mean).toBeGreaterThan(850);
    expect(mean).toBeLessThan(1150);
    expect(sim.divergence()).toBeLessThan(15); // 1/s, against ~100 /s of shear
  });

  it('lets warm air rise when nothing blows', () => {
    const s = emptyScene([10, 10, 14]);
    const heat: number[] = [];
    for (let j = 4; j < 6; j++) for (let i = 4; i < 6; i++) heat.push(idx(s, i, j, 2));
    s.heat.push({ id: 'h', label: 'h', cells: Int32Array.from(heat), watts: 20 });
    const sim = new FlowSolver(s);
    for (let t = 0; t < 200; t++) sim.step(0.02, 30);
    const above = sim.T[idx(s, 5, 5, 9)];
    const below = sim.T[idx(s, 5, 5, 0)];
    expect(sim.centre(idx(s, 5, 5, 6))[2]).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(below);
  });
});

describe('case simulation', () => {
  const cfg = defaultConfig();
  cfg.prefs.organic = 0;
  const design = solve(cfg, { beamWidth: 12, wrapMetrics: false }).designs[0];

  it('builds a scene with the design’s fans, heat sources and a closed shell', () => {
    const sc = buildScene(design, cfg, undefined, { cells: 20000 });
    expect(sc.fans.length).toBeGreaterThanOrEqual(3);
    expect(sc.heat.map((x) => x.id)).toEqual(expect.arrayContaining(['cpu', 'rad-gpu', 'psu']));
    expect(sc.interior.length).toBeGreaterThan(100);
    for (const f of sc.fans) expect(f.speed).toBeGreaterThan(50);
  });

  it('heats the air passing through the radiator by about what the fan model says', () => {
    const t0 = performance.now();
    const st = simulate(design, cfg, { louvres: [], ducts: [], flipped: [] }, { cells: 20000, seconds: 2 });
    const ms = performance.now() - t0;
    const rad = st.sources.find((s) => s.id === 'rad-gpu')!;
    const model = design.flow.groups.find((g) => g.id === 'rad-gpu')!;
    console.log(`sim ${ms.toFixed(0)} ms; rad inlet +${rad.inletRise.toFixed(2)} K mean +${rad.meanRise.toFixed(2)} K; model ΔT ${model.deltaC.toFixed(2)} K; case +${st.caseRise.toFixed(2)} K`);
    // Mean core temperature sits near half the through-flow rise (inlet ~0, outlet ~ΔT).
    expect(rad.meanRise).toBeGreaterThan(model.deltaC * 0.2);
    expect(rad.meanRise).toBeLessThan(model.deltaC * 2.5);
    expect(rad.inletRise).toBeLessThan(model.deltaC);
    // Flow-quality metrics come with the final state.
    const q = st.quality!;
    console.log('quality', JSON.stringify(q));
    expect(q.uniformity.length).toBeGreaterThan(0);
    for (const u of q.uniformity) expect(u.index).toBeGreaterThanOrEqual(0), expect(u.index).toBeLessThanOrEqual(1);
    expect(q.recirculation.map((r) => r.group)).toEqual(expect.arrayContaining(['rad-gpu']));
    for (const r of q.recirculation) expect(r.share).toBeGreaterThanOrEqual(0);
  });
});

describe('recirculation and deflectors', () => {
  /**
   * A wall at x = 20 cells with two openings side by side: an exhaust blowing hot air out (+x)
   * and an intake pulling air back in (−x) a few cells away. Some exhaust gets re-ingested; a
   * deflector that throws the exhaust away from the intake should lower the intake temperature.
   */
  /** f = grid refinement factor: cells are 10/f mm, every index scales by f. */
  const build = (deflect: boolean, f = 1) => {
    const s = emptyScene([34 * f, 22 * f, 10 * f], 10 / f);
    const [nx, ny, nz] = s.n;
    const wallI = 20 * f;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let q = 0; q < f; q++) s.cellType[idx(s, wallI + q, j, k)] = CELL_SOLID;
    const exhaust: number[] = [];
    const intake: number[] = [];
    const heatCells: number[] = [];
    for (let k = 3 * f; k < 7 * f; k++) {
      for (let j = 6 * f; j < 10 * f; j++) {
        for (let q = 0; q < f; q++) s.cellType[idx(s, wallI + q, j, k)] = 0;
        exhaust.push(idx(s, wallI + f - 1, j, k));
        heatCells.push(idx(s, 18 * f, j, k));
      }
      for (let j = 12 * f; j < 16 * f; j++) {
        for (let q = 0; q < f; q++) s.cellType[idx(s, wallI + q, j, k)] = 0;
        intake.push(idx(s, wallI, j, k));
      }
    }
    // Inside the box the two streams are separated by a baffle.
    for (let k = 0; k < nz; k++) for (let i = 0; i < wallI; i++) for (let q = 0; q < f; q++) s.cellType[idx(s, i, 11 * f + q, k)] = CELL_SOLID;
    s.fans.push({ cells: Int32Array.from(exhaust), axis: 0, sign: 1, speed: 1500, vmax: 2500, a0: 3e5, center: [205, 80, 50], swirl: 0, group: 'out', pmaxPa: 3.6 });
    s.fans.push({ cells: Int32Array.from(intake), axis: 0, sign: -1, speed: 1500, vmax: 2500, a0: 3e5, center: [205, 140, 50], swirl: 0, group: 'in', pmaxPa: 3.6 });
    s.heat.push({ id: 'h', label: 'h', cells: Int32Array.from(heatCells), watts: 150 });
    s.heat.push({ id: 'in', label: 'intake', cells: Int32Array.from(intake), watts: 0.0001 });
    if (deflect) {
      // Louvres one cell outside the exhaust, throwing air toward −y (away from the intake).
      const cells = exhaust.map((c) => c + 1);
      const a = (40 * Math.PI) / 180;
      s.louvres.push({ cells: Int32Array.from(cells), dir: [Math.cos(a), -Math.sin(a), 0], normal: [1, 0, 0] });
    }
    void nx;
    void ny;
    return s;
  };
  const intakeRise = (deflect: boolean, f = 1) => {
    const sim = new FlowSolver(build(deflect, f));
    const dt = 0.01 / f;
    for (let t = 0; t < 2.6; t += dt) sim.step(dt, 30 * f);
    return sim.stats().sources.find((x) => x.id === 'in')!.meanRise;
  };

  it('keeps the deflector gain when the grid is twice as fine', () => {
    const coarse = intakeRise(false) - intakeRise(true);
    const fine = intakeRise(false, 2) - intakeRise(true, 2);
    console.log(`deflector gain: ${coarse.toFixed(2)} K at 10 mm, ${fine.toFixed(2)} K at 5 mm`);
    expect(coarse).toBeGreaterThan(0);
    expect(fine).toBeGreaterThan(0);
  }, 600000);

  it('sees hot exhaust re-ingested, and less of it with the deflector', () => {
    const plain = intakeRise(false);
    const deflected = intakeRise(true);
    console.log(`intake rise: plain +${plain.toFixed(2)} K, deflected +${deflected.toFixed(2)} K`);
    expect(plain).toBeGreaterThan(0.1);
    expect(deflected).toBeLessThan(plain);
  });
});

describe('flow-shaping optimiser', () => {
  it('keeps a structure only when it beats the uncertainty, and drops walls that do nothing in 3D', async () => {
    const { COOLERS } = await import('../src/model/presets');
    const { optimiseShaping, STRUCTURE_MIN_GAIN } = await import('../src/cfd/run');
    const cfg = defaultConfig();
    cfg.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
    cfg.prefs.loadProfile = 'full';
    cfg.prefs.psuInletAtBack = false;
    const d = solve(cfg, { wrapMetrics: false }).space.find((x) => x.chamber)!;
    const r = optimiseShaping(d, cfg);
    let margin = r.baselineThermal.worstMargin;
    for (const s of r.steps) {
      if (!s.kept) continue;
      if (s.kind === 'no-partition') expect(s.margin).toBeGreaterThanOrEqual(margin - STRUCTURE_MIN_GAIN);
      else expect(s.margin).toBeGreaterThan(margin + STRUCTURE_MIN_GAIN);
      margin = s.margin;
    }
    expect(r.bestThermal.worstMargin).toBeCloseTo(margin, 6);
  });
});
