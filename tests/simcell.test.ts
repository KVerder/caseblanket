import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { buildScene, NO_SHAPING } from '../src/cfd/scene';
import { simulate } from '../src/cfd/run';

describe('simulation cell size', () => {
  it('follows the size the user picks, overriding the cell-count target', () => {
    const cfg = defaultConfig();
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const auto = buildScene(d, cfg, NO_SHAPING, { cells: 20000 });
    const fine = buildScene(d, cfg, NO_SHAPING, { cells: 20000, cell: 8 });
    const coarse = buildScene(d, cfg, NO_SHAPING, { cells: 20000, cell: 20 });
    expect(fine.h).toBe(8);
    expect(coarse.h).toBe(20);
    const count = (s: typeof auto) => s.n[0] * s.n[1] * s.n[2];
    expect(count(fine)).toBeGreaterThan(count(auto));
    expect(count(coarse)).toBeLessThan(count(auto));
    // A run at the chosen size works and reports on that grid.
    let h = 0;
    const st = simulate(d, cfg, NO_SHAPING, { cell: 15, seconds: 0.3, frame: (f) => (h = f.h) });
    expect(h).toBe(15);
    expect(Number.isFinite(st.caseRise)).toBe(true);
  }, 120000);
});
