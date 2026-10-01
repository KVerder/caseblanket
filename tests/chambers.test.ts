import { describe, expect, it } from 'vitest';
import { COOLERS, GPUS, defaultConfig } from '../src/model/presets';
import type { DesignConfig } from '../src/model/types';
import { DEFAULT_PRINT, printPieces } from '../src/print/printable';
import { chamberLayouts, PARTITION_THICKNESS } from '../src/solver/chambers';
import { CHAMBER_MIN_GAIN } from '../src/solver/evaluate';
import { solve } from '../src/solver/solve';
import type { ShellMesh } from '../src/solver/shrinkwrap';

/** Air-cooled card + tower cooler: the card's heat reaches the CPU cooler and PSU in one chamber. */
function airConfig(): DesignConfig {
  const cfg = defaultConfig();
  cfg.parts.gpu = structuredClone(GPUS.find((g) => g.cooling === 'air')!);
  cfg.parts.cooler = structuredClone(COOLERS.find((c) => c.kind === 'air-tower')!);
  return cfg;
}

/** Edges keyed by vertex coordinates (plate meshes do not share vertices between quads). */
function openEdgesByPosition(m: ShellMesh) {
  const key = (i: number) => `${m.positions[3 * i].toFixed(3)},${m.positions[3 * i + 1].toFixed(3)},${m.positions[3 * i + 2].toFixed(3)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = key(m.indices[t + e]);
      const b = key(m.indices[t + ((e + 1) % 3)]);
      if (a === b) continue;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  let odd = 0;
  for (const c of count.values()) if (c % 2) odd++;
  return odd;
}

describe('internal chambers', () => {
  it('never puts a partition through a part body', () => {
    for (const cfg of [defaultConfig(), airConfig()]) {
      for (const d of solve(cfg, { beamWidth: 12, wrapMetrics: false }).designs.slice(0, 4)) {
        for (const l of chamberLayouts(d, cfg))
          for (const cut of l.cuts)
            for (const p of d.parts) {
              const insideRegion = [0, 1, 2].every((a) => p.body.max[a] > cut.region.min[a] && p.body.min[a] < cut.region.max[a]);
              const straddles = p.body.min[cut.axis] < cut.at - PARTITION_THICKNESS / 2 && p.body.max[cut.axis] > cut.at + PARTITION_THICKNESS / 2;
              expect(insideRegion && straddles, `${d.id}: ${p.id} cut by a wall at ${cut.axis}=${cut.at.toFixed(1)}`).toBe(false);
            }
      }
    }
  });

  it('adopts a partition when the card heats the CPU cooler, and only past the threshold', () => {
    const cfg = airConfig();
    const designs = solve(cfg, { wrapMetrics: false }).designs;
    const withWalls = designs.filter((d) => d.chamber);
    expect(withWalls.length).toBeGreaterThan(0);
    for (const d of withWalls) {
      expect(d.singleChamberFlow).toBeDefined();
      expect(d.flow.worstMargin - d.singleChamberFlow!.worstMargin).toBeGreaterThan(CHAMBER_MIN_GAIN);
      expect(d.chamberWeightKg).toBeGreaterThan(0);
    }
    for (const d of designs.filter((x) => !x.chamber)) for (const o of d.chamberOptions) expect(o.gain).toBeLessThanOrEqual(CHAMBER_MIN_GAIN);
    const single = solve({ ...cfg, prefs: { ...cfg.prefs, chambers: 'single' } }, { wrapMetrics: false }).designs;
    expect(single.every((d) => !d.chamber)).toBe(true);
  });

  it('exports partition plates as closed pieces that fit the bed', () => {
    const cfg = airConfig();
    cfg.prefs.organic = 0.4;
    const d = solve(cfg, { wrapMetrics: false }).designs.find((x) => x.chamber)!;
    const bed: [number, number, number] = [200, 200, 200];
    const plates = printPieces(d, cfg, { ...DEFAULT_PRINT, bed }).filter((p) => p.name.startsWith('partition'));
    expect(plates.length).toBeGreaterThan(0);
    for (const p of plates) {
      expect(openEdgesByPosition(p.mesh)).toBe(0);
      const size = [0, 1, 2].map((a) => p.mesh.bbox.max[a] - p.mesh.bbox.min[a]).sort((a, b) => a - b);
      expect(size[2]).toBeLessThanOrEqual(200);
    }
  });
});
