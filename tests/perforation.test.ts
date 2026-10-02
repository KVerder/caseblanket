import { describe, expect, it } from 'vitest';
import { defaultConfig, VENT_STYLES } from '../src/model/presets';
import { holeAt, holeHalfExtents, openShare, PERFORATIONS } from '../src/model/perforation';
import { solve } from '../src/solver/solve';
import { DEFAULT_PRINT, dropFragments, printPieces } from '../src/print/printable';

describe('perforation patterns', () => {
  it('give each vent style its own open ratio (the airflow model uses the printed pattern)', () => {
    for (const v of VENT_STYLES) expect(v.openRatio).toBeCloseTo(openShare(PERFORATIONS[v.id]), 9);
    // The sampled open share agrees with the formula.
    for (const p of Object.values(PERFORATIONS)) {
      let open = 0;
      let n = 0;
      for (let x = 0.13; x < 120; x += 0.37) for (let y = 0.11; y < 120; y += 0.41, n++) if (holeAt(p, x, y).d < 0) open++;
      expect(open / n).toBeCloseTo(openShare(p), 1);
    }
  });

  it('keeps every web at least 2 mm wide (printable), sampling the solid between holes', () => {
    for (const [id, p] of Object.entries(PERFORATIONS)) {
      // The narrowest web: the smallest distance between two different holes.
      let web = Infinity;
      for (let x = 0; x < 3 * p.pitch; x += 0.1)
        for (let y = 0; y < 3 * p.rowPitch; y += 0.1) {
          const a = holeAt(p, x, y);
          if (a.d < 0) continue;
          // Distance to the nearest hole other than the closest one: probe a little ring.
          for (let k = 0; k < 16; k++) {
            const t = (2 * Math.PI * k) / 16;
            const b = holeAt(p, x + (a.d + 0.01) * Math.cos(t), y + (a.d + 0.01) * Math.sin(t));
            if (b.d <= 0.02 && (b.cx !== a.cx || b.cy !== a.cy)) web = Math.min(web, 2 * a.d);
          }
        }
      expect(web, id).toBeGreaterThanOrEqual(p.web - 0.25);
      expect(p.web, id).toBeGreaterThanOrEqual(2);
    }
  });

  it('lays the honeycomb with flats along the row, so in-row neighbours are pitch − size apart', () => {
    const p = PERFORATIONS.hex;
    const [hx] = holeHalfExtents(p);
    expect(hx).toBeCloseTo(p.size / 2, 9);
    // Midway between two holes of a row: (pitch − size)/2 from each.
    expect(holeAt(p, p.pitch / 2, 0).d).toBeCloseTo((p.pitch - p.size) / 2, 6);
  });
});

describe('printed perforation', () => {
  it('prints the chosen style, with no loose fragments, on a tight shell with the finest pattern', () => {
    const cfg = defaultConfig();
    cfg.prefs.organic = 0;
    cfg.prefs.ventStyleId = 'fine';
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const pieces = printPieces(d, cfg, DEFAULT_PRINT);
    for (const p of pieces) {
      expect(p.dropped ?? 0, p.name).toBe(0);
      // Nothing left to drop either.
      expect(dropFragments(p.mesh).dropped, p.name).toBe(0);
    }
    // A different style gives different walls.
    const slots = { ...cfg, prefs: { ...cfg.prefs, ventStyleId: 'slots' } };
    const vol = (ps: typeof pieces) => ps.reduce((s, p) => s + p.mesh.volumeMm3, 0);
    expect(Math.abs(vol(printPieces(d, slots, DEFAULT_PRINT)) - vol(pieces))).toBeGreaterThan(100);
  }, 300000);
});
