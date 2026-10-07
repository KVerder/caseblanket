import { describe, expect, it } from 'vitest';
import { FlowSolver, CELL_SOLID, type Scene } from '../src/cfd/solver';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { buildScene, NO_SHAPING } from '../src/cfd/scene';
import { cfdComponents } from '../src/cfd/components';

const RHO_CP = 1.2e-9 * 1005; // J/(mm³·K)

/**
 * A straight channel of air at a fixed speed (no fans, no pressure solve): heat only advects and
 * mixes, so the radiator core's coolant temperature can be checked against ε-NTU by hand.
 */
function channel(speedOf: (j: number) => number, eff: number, watts: number) {
  const h = 10;
  const n: [number, number, number] = [16, 4, 4];
  const total = n[0] * n[1] * n[2];
  const cells: number[] = [];
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 6; i < 9; i++) cells.push(i + n[0] * (j + n[1] * k));
  const scene: Scene = {
    n,
    h,
    origin: [0, 0, 0],
    cellType: new Uint8Array(total),
    beta: [new Float32Array(total), new Float32Array(total), new Float32Array(total)],
    fans: [],
    louvres: [],
    heat: [{ id: 'rad', label: 'core', cells: Int32Array.from(cells), watts, exchanger: { eff, thickness: 3 * h } }],
    up: { axis: 1, sign: 1 },
    interior: new Int32Array(0),
  };
  const sim = new FlowSolver(scene);
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i <= n[0]; i++) sim.u[i + (n[0] + 1) * (j + n[1] * k)] = speedOf(j);
  const dt = 0.005;
  const heat = (sim as unknown as { advectHeat: (dt: number) => void }).advectHeat.bind(sim);
  for (let s = 0; s < 1500; s++) heat(dt);
  const st = sim.stats();
  const coolant = st.sources[0].coolantRise!;
  let maxCore = 0;
  for (const c of cells) maxCore = Math.max(maxCore, sim.T[c]);
  const flowMm3 = [0, 1, 2, 3].reduce((a, j) => a + speedOf(j) * n[2] * h * h, 0);
  return { coolant, maxCore, flowMm3, h, cellType: scene.cellType };
}

describe('radiator cores exchange heat with their coolant', () => {
  it('match ε-NTU at even flow: coolant − inlet = Q / (ε·ṁ·cp)', () => {
    const eff = 0.7;
    const r = channel(() => 600, eff, 100);
    const expected = 100 / (eff * RHO_CP * r.flowMm3);
    // Turbulent mixing in the grid smears the column a little.
    expect(r.coolant).toBeGreaterThan(expected * 0.85);
    expect(r.coolant).toBeLessThan(expected * 1.15);
    expect(r.maxCore).toBeLessThanOrEqual(r.coolant + 1e-3);
  });

  it('never heat starved air past the coolant, and lose only a little to uneven flow', () => {
    const even = channel(() => 600, 0.7, 100);
    // Same total flow, a quarter of the core nearly starved (a fan hub's shadow, roughly).
    const uneven = channel((j) => (j === 0 ? 60 : (2400 - 60) / 3), 0.7, 100);
    expect(uneven.maxCore).toBeLessThanOrEqual(uneven.coolant + 1e-3);
    // h ∝ v^0.51: slow columns reach a higher effectiveness, so the penalty is modest (a few %).
    expect(uneven.coolant).toBeGreaterThan(even.coolant);
    expect(uneven.coolant).toBeLessThan(even.coolant * 1.15);
    void CELL_SOLID;
  });

  it('feeds the GPU core temperature from the simulated coolant in a full design', () => {
    const cfg = defaultConfig();
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const scene = buildScene(d, cfg, NO_SHAPING, { cells: 6000 });
    const rad = scene.heat.find((s) => s.id.startsWith('rad'));
    expect(rad?.exchanger).toBeDefined();
    expect(buildScene(d, cfg, NO_SHAPING, { cells: 6000, uniformRadHeat: true }).heat.find((s) => s.id === rad!.id)?.exchanger).toBeUndefined();
    const sim = new FlowSolver(scene);
    const dt = sim.suggestDt();
    for (let t = 0; t < 0.6; t += dt) sim.step(dt);
    const st = sim.stats();
    const src = st.sources.find((s) => s.id === rad!.id)!;
    expect(src.coolantRise).toBeGreaterThan(src.inletRise);
    const th = cfdComponents(d, cfg, st);
    const core = th.components.find((c) => c.air === 'coolant' && c.via === rad!.id)!;
    expect(core.tempC).toBeCloseTo(cfg.prefs.ambientC + src.coolantRise! + core.selfRiseK, 6);
  }, 120000);
});
