import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { rerank3D, solve } from '../src/solver/solve';
import { score3D } from '../src/cfd/components';

describe('ranking the shortlist in 3D', () => {
  it('3D cooling decides the order: the design 3D finds coolest becomes the best match', () => {
    const cfg = defaultConfig();
    cfg.prefs.airflowPriority = 1; // cooling only, so the 3D numbers alone decide
    const r = solve(cfg, { wrapMetrics: false });
    expect(r.designs.length).toBeGreaterThan(2);
    const last = r.designs[r.designs.length - 1];
    const checks = Object.fromEntries(
      r.designs.map((d) => [d.id, { worstMargin: d === last ? 0.6 : 0.1, worstHeadroomK: 0, worstComponent: 'x', score: d === last ? 0.7 : 0.4 }]),
    );
    const rr = rerank3D(r, cfg, checks);
    expect(rr.designs[0].id).toBe(last.id);
    expect(rr.designs[0].tags).toContain('Best match');
    expect(rr.designs.filter((d) => d.tags.includes('Best match')).length).toBe(1);
    expect(rr.designs.every((d) => d.check3D)).toBe(true);
  }, 120000);

  it("scores a 3D run like the airflow model: 0.5 when every part is exactly at its limit", () => {
    const c = (limitC: number, tempC: number) => ({ id: 'a', label: 'a', tempC, limitC, headroomK: limitC - tempC, margin: 0, adequacy: 1, heatW: 50, via: 'x', air: 'zone' as const, selfRiseK: 0 });
    expect(score3D({ components: [c(50, 50), c(80, 80)], worstMargin: 0, worstHeadroomK: 0, worstComponent: '' }, 25)).toBeCloseTo(0.5, 9);
    expect(score3D({ components: [c(50, 35)], worstMargin: 0, worstHeadroomK: 0, worstComponent: '' }, 25)).toBeGreaterThan(0.5);
  });
});
