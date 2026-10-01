import { describe, expect, it } from 'vitest';
import { COOLERS, GPUS, defaultConfig } from '../src/model/presets';
import { frontier, spacePoints } from '../src/solver/frontier';
import { solve } from '../src/solver/solve';

describe('design-space frontier', () => {
  const air = defaultConfig();
  air.parts.gpu = structuredClone(GPUS.find((g) => g.cooling === 'air')!);
  air.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
  for (const [name, cfg] of [
    ['default build', defaultConfig()],
    ['air-cooled build', air],
  ] as const) {
    it(`has no frontier design beaten on both size and margin (${name})`, () => {
      const r = solve(cfg, { wrapMetrics: false });
      expect(r.space.length).toBeGreaterThan(r.designs.length);
      expect(r.space.every((d) => !d.invalid)).toBe(true);
      for (const axis of ['volume', 'thickness'] as const) {
        const pts = spacePoints(r.space, axis);
        const front = frontier(pts);
        expect(front.length).toBeGreaterThan(0);
        for (const f of front)
          for (const p of pts) {
            const beats = (p.size < f.size - 1e-9 && p.margin >= f.margin) || (p.size <= f.size && p.margin > f.margin + 1e-9);
            expect(beats, `${p.id} beats frontier ${f.id} on ${axis}`).toBe(false);
          }
        // Sorted smallest → coolest, margin strictly rising.
        for (let i = 1; i < front.length; i++) {
          expect(front[i].size).toBeGreaterThanOrEqual(front[i - 1].size);
          expect(front[i].margin).toBeGreaterThan(front[i - 1].margin);
        }
        console.log(`${name}, ${axis}: ${pts.length} designs, ${front.length} on the frontier, ${front[0].size.toFixed(1)} → ${front[front.length - 1].size.toFixed(1)}, margin ${(front[0].margin * 100).toFixed(0)} → ${(front[front.length - 1].margin * 100).toFixed(0)} %`);
      }
    });
  }
});

describe('design-space frontier with a noise budget', () => {
  for (const budget of [24, 30]) {
    it(`has no frontier design beaten on size and margin at ${budget} dB(A), among designs that meet it`, () => {
      const cfg = defaultConfig();
      cfg.prefs.noiseBudgetDb = budget;
      const r = solve(cfg, { wrapMetrics: false });
      const ok = r.space.filter((d) => d.noise[cfg.prefs.loadProfile].feasible);
      for (const d of ok) expect(d.noise[cfg.prefs.loadProfile].noise.spl).toBeLessThanOrEqual(budget + 1e-6);
      const pts = spacePoints(ok, 'volume');
      for (const f of frontier(pts))
        for (const p of pts) {
          const beats = (p.size < f.size - 1e-9 && p.margin >= f.margin) || (p.size <= f.size && p.margin > f.margin + 1e-9);
          expect(beats).toBe(false);
        }
    });
  }
});
