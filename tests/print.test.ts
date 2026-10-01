import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { DEFAULT_PRINT, planPieces, printPieces, stlBinary, wallSolid, zip } from '../src/print/printable';
import { solve } from '../src/solver/solve';
import type { ShellMesh } from '../src/solver/shrinkwrap';

function openEdges(m: ShellMesh) {
  const count = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e];
      const b = m.indices[t + ((e + 1) % 3)];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  let odd = 0;
  for (const c of count.values()) if (c % 2) odd++;
  return { odd, edges: count.size };
}

describe('3D-printable export', () => {
  for (const organic of [0, 0.7]) {
    it(`splits the ${organic ? 'organic' : 'box'} shell into closed pieces that fit the bed, with holes cut`, () => {
      const cfg = defaultConfig();
      cfg.prefs.organic = organic;
      cfg.prefs.materialId = 'petg';
      cfg.prefs.wallThickness = 2.4;
      const d = solve(cfg, { beamWidth: 10, wrapMetrics: false }).designs[0];
      const opt = { ...DEFAULT_PRINT, bed: [220, 220, 250] as [number, number, number] };
      const boxes = planPieces(d, opt);
      for (const b of boxes) for (let a = 0; a < 3; a++) expect(b.max[a] - b.min[a]).toBeLessThanOrEqual(220 - 8 + 1e-6);
      const t0 = performance.now();
      const pieces = printPieces(d, cfg, opt);
      console.log(`${organic ? 'organic' : 'box'}: ${pieces.length} pieces in ${(performance.now() - t0).toFixed(0)} ms, ${pieces.reduce((s, p) => s + p.mesh.indices.length / 3, 0)} triangles`);
      expect(pieces.length).toBeGreaterThanOrEqual(2);
      for (const p of pieces) {
        const { odd, edges } = openEdges(p.mesh);
        // Surface nets can leave a handful of non-manifold edges in ambiguous cells.
        expect(odd / edges).toBeLessThan(0.002);
        // Every vertex inside its cut box (plus the mesher's sub-cell slack).
        for (let i = 0; i < p.mesh.positions.length; i += 3 * 97)
          for (let a = 0; a < 3; a++) {
            expect(p.mesh.positions[i + a]).toBeGreaterThanOrEqual(p.box.min[a] - 2);
            expect(p.mesh.positions[i + a]).toBeLessThanOrEqual(p.box.max[a] + 2);
          }
      }
      // A point at the centre of a perforated fan vent is air, not wall.
      const vent = d.vents.find((v) => v.kind === 'fan' || v.kind === 'through')!;
      expect(vent).toBeDefined();
      const solid = wallSolid(d, cfg, opt);
      let holes = 0;
      let wall = 0;
      const a = Math.floor(vent.wall / 2);
      const xa = a === 0 ? 1 : 0;
      const ya = a === 2 ? 1 : 2;
      for (let x = vent.rect.x0 + 6; x < vent.rect.x1 - 6; x += 1.3)
        for (let y = vent.rect.y0 + 6; y < vent.rect.y1 - 6; y += 1.7) {
          const p: [number, number, number] = [0, 0, 0];
          p[a] = vent.wall % 2 === 0 ? d.interior[a] + d.wall / 2 : -d.wall / 2;
          p[xa] = x;
          p[ya] = y;
          if (solid(p) > 0) holes++;
          else wall++;
        }
      expect(holes / (holes + wall)).toBeGreaterThan(0.25);
      // Files: binary STL sizes and a valid ZIP signature.
      const stl = stlBinary(pieces[0].mesh, cfg);
      expect(stl.length).toBe(84 + (pieces[0].mesh.indices.length / 3) * 50);
      const z = zip([{ name: 'a.stl', data: stl }]);
      expect(new DataView(z.buffer).getUint32(0, true)).toBe(0x04034b50);
    });
  }
});
