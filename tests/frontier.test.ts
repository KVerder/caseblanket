import { describe, expect, it } from 'vitest';
import { COOLERS, GPUS, defaultConfig } from '../src/model/presets';
import { frontier, rescoreCandidates, spacePoints, thermalScheme } from '../src/solver/frontier';
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

describe('3D re-scoring candidates', () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, size: 10 + (i % 30), margin: ((i * 37) % 17) / 17 }));
  const pick = rescoreCandidates(pts, 20);
  it('takes at most n distinct designs, the model frontier first', () => {
    expect(pick.length).toBe(20);
    expect(new Set(pick.map((p) => p.id)).size).toBe(20);
    const f = frontier(pts);
    expect(pick.slice(0, f.length).map((p) => p.id)).toEqual(f.map((p) => p.id));
  });
  it('spreads over the whole size range', () => {
    const sizes = pick.map((p) => p.size);
    expect(Math.min(...sizes)).toBe(10);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(36);
  });
});

describe('3D re-scoring samples every flow scheme', () => {
  it('adds the best design of a scheme the size bands would miss', () => {
    // 40 designs of scheme A that beat every scheme-B design in the model, all the same size.
    const pts = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, size: 20, margin: 0.5 + i / 1000, s: 'A' })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, size: 20, margin: 0.3 + i / 100, s: 'B' })),
    ];
    expect(rescoreCandidates(pts, 6).some((p) => p.s === 'B')).toBe(false);
    const pick = rescoreCandidates(pts, 6, 8, (p) => p.s);
    expect(pick.map((p) => p.id)).toContain('b4');
    expect(pick.length).toBe(6);
  });
  it('tells radiator direction, tilt and case-fan directions apart', () => {
    const cfg = defaultConfig();
    cfg.prefs.airflowPriority = 1;
    cfg.parts.caseFans.count = 2;
    const r = solve(cfg, { wrapMetrics: false });
    const schemes = new Set(r.space.map(thermalScheme));
    expect(schemes.size).toBeGreaterThan(5);
    for (const s of schemes) expect(s).toMatch(/^(flat|sandwich|direct) .*fans \din \dout$/);
  }, 120000);
});
