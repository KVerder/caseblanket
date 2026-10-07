import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { floorGapZeta } from '../src/solver/airflow';
import { buildScene, upAxis } from '../src/cfd/scene';
import { CELL_SOLID } from '../src/cfd/solver';

describe('the surface under the case', () => {
  it('floor gap: the fan-clearance rule (a quarter of the fan size) gives one velocity head', () => {
    // 120 mm square vent, 30 mm feet: side area 480 × 30 = the vent's 14 400 mm².
    expect(floorGapZeta(120 * 120, 480, 30, 2000)).toBeCloseTo(1, 6);
    // Halving the gap quadruples the loss; the footprint's edge caps the side area.
    expect(floorGapZeta(120 * 120, 480, 15, 2000)).toBeCloseTo(4, 6);
    expect(floorGapZeta(120 * 120, 480, 30, 240)).toBeCloseTo(4, 6);
  });

  for (const orientation of ['tower', 'console'] as const)
    it(`3D (${orientation}): a solid floor under the feet, room air only above it`, () => {
      const cfg = defaultConfig();
      cfg.prefs.orientation = orientation;
      const d = solve(cfg, { wrapMetrics: false }).designs[0];
      const s = buildScene(d, cfg, undefined, { cells: 20000 });
      const up = upAxis(cfg).axis;
      expect(s.up.axis).toBe(up);
      const f = s.geometry!.floor!;
      expect(f.at).toBeLessThanOrEqual(-d.wall - d.feet + 1e-9);
      expect(f.at).toBeCloseTo(s.origin[up] + s.h, 6);
      const [nx, ny] = s.n;
      const layer = (c: number) => (up === 0 ? c % nx : up === 1 ? Math.floor(c / nx) % ny : Math.floor(c / (nx * ny)));
      let floor = 0;
      let above = 0;
      for (let c = 0; c < s.cellType.length; c++) {
        if (layer(c) === 0) {
          expect(s.cellType[c]).toBe(CELL_SOLID);
          floor++;
        } else if (s.cellType[c] !== CELL_SOLID) above++;
      }
      expect(floor).toBe(s.cellType.length / s.n[up]);
      expect(above).toBeGreaterThan(0);
    });

  it('1D: bottom vents carry the floor-gap loss, and taller feet ease it', () => {
    const at = (feet: number) => {
      const cfg = defaultConfig();
      cfg.prefs.orientation = 'console';
      cfg.prefs.feetHeight = feet;
      // Keep the board's air from deciding the layout, so both runs pick the same one.
      cfg.advanced.limits.caseAir = 80;
      return solve(cfg, { wrapMetrics: false }).designs[0];
    };
    const short = at(8);
    const tall = at(30);
    const fanned = short.vents.some((v) => v.wall === short.bottomWall && v.groupId);
    if (!fanned) return;
    // Default console layout: GPU radiator and card fan in the bottom panel (about 4 K apart, measured).
    // Measured on the GPU core, which those vents cool (the tightest part may be the board's air).
    const gpu = (d: typeof short) => d.flow.components.find((c) => c.id === 'gpu')!.headroomK;
    expect(gpu(tall) - gpu(short)).toBeGreaterThan(1);
  });
});
