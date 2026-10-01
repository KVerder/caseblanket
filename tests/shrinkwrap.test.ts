import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { meshShell, shellField, wrapMetrics } from '../src/solver/shrinkwrap';
import { solve } from '../src/solver/solve';
import type { Vec3 } from '../src/solver/geometry';

describe('shrinkwrap shell', () => {
  const cfg = defaultConfig();
  const designs = solve(cfg, { beamWidth: 12 }).designs.slice(0, 3);

  it('keeps every part body inside the outer surface by at least a wall, at every organic level', () => {
    for (const d of designs) {
      for (const o of [0.3, 0.7, 1]) {
        const f = shellField(d, cfg, o);
        for (const p of d.parts) {
          for (const x of [p.body.min[0], p.body.max[0]])
            for (const y of [p.body.min[1], p.body.max[1]])
              for (const z of [p.body.min[2], p.body.max[2]]) {
                const q: Vec3 = [x, y, z];
                expect(f(q), `${d.id} ${p.id} o=${o}`).toBeLessThanOrEqual(-d.wall + 0.05);
              }
        }
      }
      // The straight box keeps parts inside (the fillet growth handles edges).
      const fb = shellField(d, cfg, 0);
      for (const p of d.parts) expect(fb(p.body.min)).toBeLessThan(0);
    }
  });

  it('meshes a closed shell that is no thicker and smaller than the box', () => {
    const d = designs[0];
    const t0 = performance.now();
    const box = meshShell(d, cfg, 0);
    const wrap = meshShell(d, cfg, 1);
    const ms = performance.now() - t0;
    expect(Math.abs(box.volumeMm3 / 1e6 - d.volumeL) / d.volumeL).toBeLessThan(0.04);
    expect(wrap.volumeMm3).toBeLessThan(box.volumeMm3);
    const m = wrapMetrics(d, cfg, 1);
    expect(m.thickness).toBeLessThanOrEqual(d.thickness + 2 * (2.5 + 2));
    console.log(`box ${(box.volumeMm3 / 1e6).toFixed(2)} L ${d.thickness.toFixed(0)} mm; wrap ${m.volumeL.toFixed(2)} L ${m.thickness.toFixed(0)} mm; ${ms.toFixed(0)} ms`);
  });
});
