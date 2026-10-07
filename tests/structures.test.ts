import { describe, expect, it } from 'vitest';
import { COOLERS, GPUS, defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { applyMod, diffuserRecovery, evaluateStructures, expansionChamberTl, recipeNoise, solveWith } from '../src/solver/structures';

const airCooled = (budget = 30) => {
  const cfg = defaultConfig();
  cfg.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
  cfg.parts.gpu = structuredClone(GPUS.find((g) => g.cooling === 'air')!);
  cfg.prefs.noiseBudgetDb = budget;
  return cfg;
};

describe('structures, round 2 (estimates)', () => {
  it('re-solving the recipe reproduces the design: same margin and noise', () => {
    for (const cfg of [defaultConfig(), airCooled()]) {
      const d = solve(cfg, { wrapMetrics: false }).designs[0];
      const s = solveWith(d.recipe);
      const load = cfg.prefs.loadProfile ?? 'gaming';
      expect(s.flow.worstMargin).toBeCloseTo(d.flow.worstMargin, 6);
      expect(s.noise.spl).toBeCloseTo(d.noise[load].noise.spl, 6);
    }
  });

  it('uses the textbook forms: expansion chamber and diffuser', () => {
    expect(expansionChamberTl(1)).toBeCloseTo(0, 9);
    expect(expansionChamberTl(4)).toBeCloseTo(4.4, 1);
    expect(expansionChamberTl(9)).toBeGreaterThan(expansionChamberTl(4));
    expect(diffuserRecovery(1)).toBe(0);
    expect(diffuserRecovery(2, 1)).toBeCloseTo(0.75, 9);
  });

  it('recovered pressure never cuts a path below half its resistance', () => {
    const d = solve(airCooled(), { wrapMetrics: false }).designs[0];
    const g = d.recipe.net.groups[0];
    const R = (ls: typeof g.losses) => ls.reduce((s, l) => s + l.zeta / (l.area * l.area), 0);
    const net = applyMod(d.recipe.net, { losses: { [g.id]: [{ label: 'huge', zeta: -50, area: 0.005 }] } });
    expect(R(net.groups[0].losses)).toBeGreaterThanOrEqual(0.5 * R(g.losses) * (1 - 1e-9));
  });

  it('a silencer lowers the case noise at the same fan speeds', () => {
    const d = solve(airCooled(), { wrapMetrics: false }).designs[0];
    const s = solveWith(d.recipe);
    const id = d.recipe.fans[0].id;
    expect(recipeNoise(d.recipe, s.speeds, s.flow, { [id]: -3 }).spl).toBeLessThan(s.noise.spl);
  });

  it('a bell-mouth helps a design whose fans are held back by the noise budget', () => {
    const cfg = airCooled(24);
    // With the board's air the tightest part, no fan structure can help; test the fan-limited case.
    cfg.advanced.limits.caseAir = 80;
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const { results } = evaluateStructures(d, cfg);
    const bell = results.find((r) => r.kind === 'bell-mouth');
    expect(bell).toBeDefined();
    expect(bell!.marginGain).toBeGreaterThan(0);
    expect(bell!.noiseDeltaDb).toBeLessThanOrEqual(0.05);
  });

  it('lists every structure with its costs, flagged as needing a reference', () => {
    const cfg = defaultConfig();
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const { results } = evaluateStructures(d, cfg);
    expect(results.length).toBeGreaterThan(3);
    for (const r of results) {
      expect(r.needsReference).toBe(true);
      expect(r.volumeL).toBeGreaterThanOrEqual(0);
      expect(r.massG).toBeGreaterThan(0);
      expect(r.printMin).toBeGreaterThan(0);
      expect(Number.isFinite(r.noiseDeltaDb)).toBe(true);
    }
  });
});
