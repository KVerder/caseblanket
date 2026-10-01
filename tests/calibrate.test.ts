import { describe, expect, it } from 'vitest';
import { COOLERS, defaultConfig } from '../src/model/presets';
import { fitCorrection, fitProblem, predict, type Measurement } from '../src/solver/calibrate';
import { solve } from '../src/solver/solve';

describe('measurement import and fit', () => {
  const cfg = defaultConfig();
  cfg.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
  const d = solve(cfg, { wrapMetrics: false }).designs[0];
  const r = d.recipe;
  // A "real" prototype: radiator 60 % more restrictive, 4× the leakage, 2.5 dB louder.
  const truth = { radiator: 1.6, leakage: 4, noiseDb: 2.5 };
  let seed = 7;
  const jitter = (amp: number) => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) * 2 - 1) * amp;
  };
  const measure = (share: number): Measurement => {
    const rpm = Object.fromEntries(r.fans.map((f) => [f.id, Math.max(f.min, share) * f.rpmMax]));
    const base: Measurement = { rpm, temps: {}, roomC: 23 };
    const p = predict(r, truth, base);
    const temps = Object.fromEntries(p.flow.components.map((c) => [c.id, c.tempC + jitter(0.3)]));
    return { ...base, temps, splDb: p.splDb + jitter(0.3) };
  };
  const data = [measure(0.45), measure(0.7), measure(1)];

  it('asks for at least two different fan speeds', () => {
    expect(fitProblem(r, [data[0]])).toMatch(/two/);
    expect(fitProblem(r, [data[0], { ...data[0] }])).toMatch(/different speeds/);
    expect(fitProblem(r, data)).toBeNull();
  });

  it('reduces the residuals on synthetic data and recovers the corrections', () => {
    const fit = fitCorrection(r, data);
    console.log(`rms ${fit.rmsBefore.toFixed(2)} → ${fit.rmsAfter.toFixed(2)}; fitted`, JSON.stringify(fit.correction));
    expect(fit.rmsAfter).toBeLessThan(fit.rmsBefore);
    expect(fit.rmsAfter).toBeLessThan(0.6);
    expect(fit.correction.noiseDb).toBeCloseTo(2.5, 0);
    expect(fit.correction.radiator).toBeCloseTo(1.6, 1);
    // Every fan here breathes outside air, so case leakage barely shows in the temperatures:
    // the fit must say it can't pin it down rather than claim a value.
    if (Math.abs(fit.correction.leakage - 4) > 1) expect(fit.identifiable.leakage).toBe(false);
  });
});
