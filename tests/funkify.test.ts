import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { funkBase, funkify, FUNK_THERMAL_TOL, lookOf } from '../src/solver/funkify';
import { solve } from '../src/solver/solve';
import { meshShell } from '../src/solver/shrinkwrap';

describe('funkify', () => {
  it('searches with shrinkwrap mode off, since it would override the sculpted shells', () => {
    const cfg = defaultConfig();
    cfg.prefs.mold = true;
    cfg.prefs.rank3D = true;
    const b = funkBase(cfg);
    expect(b.prefs.mold).toBe(false);
    expect(b.prefs.rank3D).toBe(false);
  });

  it('scores a pebble as more organic than the same layout in a box', () => {
    const cfg = funkBase(defaultConfig());
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const box = meshShell(d, { ...cfg, prefs: { ...cfg.prefs, shell: 'box' } }, 0, 0, 0.4);
    const peb = meshShell(d, { ...cfg, prefs: { ...cfg.prefs, shell: 'pebble', sculpt: { cut: 0.7, slope: 0, round: 0.8 } } }, 0, 0, 0.4);
    const sph = (m: typeof box) => (Math.cbrt(Math.PI) * Math.pow(6 * m.volumeMm3, 2 / 3)) / m.areaMm2;
    const lb = lookOf(box, sph(box));
    const lp = lookOf(peb, sph(box));
    expect(lp.curved).toBeGreaterThan(lb.curved + 0.3);
    expect(lp.round).toBeGreaterThan(lb.round);
    expect(lp.score).toBeGreaterThan(lb.score);
  }, 60000);

  it('offers sculpted designs that give up nothing beyond the uncertainty on cooling, size ignored', () => {
    const r = funkify(defaultConfig(), { picks: 4, check3d: false });
    expect(r.picks.length).toBeGreaterThanOrEqual(3);
    for (const p of r.picks) {
      expect(p.margin).toBeGreaterThanOrEqual(r.stats.floorMargin - FUNK_THERMAL_TOL - 1e-9);
      expect(['pebble', 'wrap', 'facet']).toContain(p.prefs.shell);
      expect(p.prefs.airflowPriority).toBe(1);
      expect(p.prefs.maxWidth).toBe(0);
    }
    for (let i = 1; i < r.picks.length; i++) expect(r.picks[i].look.score).toBeLessThanOrEqual(r.picks[i - 1].look.score + 1e-9);
    // Applying a pick reproduces its layout: the same settings solve to the same design id.
    const p = r.picks[0];
    const cfg = defaultConfig();
    Object.assign(cfg.prefs, p.prefs);
    const again = solve(cfg, { wrapMetrics: false });
    expect(again.space.some((d) => d.id === p.designId)).toBe(true);
  }, 300000);
});
