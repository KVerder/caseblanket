import { describe, expect, it } from 'vitest';
import { COOLERS, FANS, GPUS, defaultConfig } from '../src/model/presets';
import { fanLw, obstructionPenalty, splAt1m, sumDb } from '../src/solver/acoustics';
import { operatingFlow } from '../src/solver/airflow';
import { solve } from '../src/solver/solve';

describe('acoustic model', () => {
  it('adds ~15 dB for twice the speed (fan law, 50·log10 2)', () => {
    const slow = fanLw(FANS.a12x25, 1, 0.5);
    const fast = fanLw(FANS.a12x25, 1, 1);
    expect(fast - slow).toBeCloseTo(15.05, 2);
  });

  it('adds 3 dB for two identical fans (incoherent sum)', () => {
    const one = fanLw(FANS.a12x25, 1, 0.7);
    expect(fanLw(FANS.a12x25, 2, 0.7) - one).toBeCloseTo(3.01, 2);
    expect(sumDb([one, one]) - one).toBeCloseTo(3.01, 2);
  });

  it('reads a datasheet rating as SPL at 1 m (sound power − 8 dB on a desk)', () => {
    expect(splAt1m(fanLw(FANS.a12x25, 1, 1))).toBeCloseTo(22.6, 6);
  });

  it('scales airflow with speed and pressure with speed squared', () => {
    expect(operatingFlow(FANS.a12x25, 1, [], 0, 0.5)).toBeCloseTo(operatingFlow(FANS.a12x25, 1, [], 0, 1) / 2, 9);
    // Stall pressure at half speed is a quarter: a quarter of full stall stops it.
    const stall = FANS.a12x25.maxPressureMmH2O * 9.80665;
    expect(operatingFlow(FANS.a12x25, 1, [], stall / 4 + 1e-6, 0.5)).toBe(0);
  });

  it('penalises a grille close to the blades, not one a quarter-diameter away', () => {
    expect(obstructionPenalty(FANS.a12x25, 0, 0.5).db).toBeGreaterThan(2);
    expect(obstructionPenalty(FANS.a12x25, 0, 0.5).tonal).toBe(true);
    expect(obstructionPenalty(FANS.a12x25, 30, 0.5).db).toBe(0);
  });
});

describe('fan-speed solver', () => {
  const air = defaultConfig();
  air.parts.gpu = structuredClone(GPUS.find((g) => g.cooling === 'air')!);
  air.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
  const configs = [defaultConfig(), air];

  it('never exceeds the noise budget, and says so when the budget cannot be met', () => {
    for (const base of configs)
      for (const budget of [18, 25, 30, 38]) {
        const cfg = { ...base, prefs: { ...base.prefs, noiseBudgetDb: budget, noiseMode: 'budget' as const } };
        const r = solve(cfg, { wrapMetrics: false });
        for (const d of r.space)
          for (const load of ['gaming', 'full'] as const) {
            const n = d.noise[load];
            if (n.feasible) expect(n.noise.spl, `${d.id} ${load} at ${budget} dB`).toBeLessThanOrEqual(budget + 1e-6);
            else expect(Object.values(n.speeds).every((s) => s < 0.5)).toBe(true); // reported at the slowest speeds
          }
      }
  });

  it('cools at least as well with a bigger budget', () => {
    const at = (budget: number) => solve({ ...defaultConfig(), prefs: { ...defaultConfig().prefs, noiseBudgetDb: budget } }, { wrapMetrics: false });
    const a = at(25).space;
    const b = at(35).space;
    for (const d of a) {
      const e = b.find((x) => x.id === d.id);
      if (e && d.noise.gaming.feasible) expect(e.flow.worstMargin).toBeGreaterThanOrEqual(d.flow.worstMargin - 1e-6);
    }
  });

  it('quiet mode keeps every part under its limit', () => {
    for (const base of configs) {
      const cfg = { ...base, prefs: { ...base.prefs, noiseMode: 'quiet' as const } };
      for (const d of solve(cfg, { wrapMetrics: false }).space) if (d.noise.gaming.feasible) expect(d.flow.worstMargin).toBeGreaterThanOrEqual(0);
    }
  });
});
