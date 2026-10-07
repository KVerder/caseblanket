import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { buildScene, NO_SHAPING } from '../src/cfd/scene';

describe('3D heat sources', () => {
  it('every heat source gets cells on every grid (no heat silently dropped)', () => {
    for (const orientation of ['tower', 'console'] as const) {
      const cfg = defaultConfig();
      cfg.prefs.orientation = orientation;
      const space = solve(cfg, { wrapMetrics: false }).space.filter((_, i) => i % 8 === 0);
      for (const d of space)
        for (const cells of [9000, 12000, 20000, 45000]) {
          const sc = buildScene(d, cfg, NO_SHAPING, { cells });
          for (const src of sc.heat) if (src.watts > 0) expect(src.cells.length, `${d.id} ${src.id} at ${cells} cells`).toBeGreaterThan(0);
        }
    }
  }, 600000);
});
