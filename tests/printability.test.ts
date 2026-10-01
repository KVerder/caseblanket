import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { buildManifest, chooseFilament, DEFAULT_SLICER, orientPiece, pieceCost } from '../src/print/analysis';
import { DEFAULT_PRINT, planPieces, printPieces } from '../src/print/printable';
import { MATERIALS } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import type { ShellMesh } from '../src/solver/shrinkwrap';

/** Closed mesh of a voxel set (exposed faces only), 1 mm voxels. */
function voxelMesh(filled: (x: number, y: number, z: number) => boolean, n: number): ShellMesh {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  let vol = 0;
  const quad = (c: number[][], nn: number[]) => {
    const b = pos.length / 3;
    for (const q of c) pos.push(...q), nrm.push(...nn);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        if (!filled(x, y, z)) continue;
        vol++;
        const f = (dx: number, dy: number, dz: number) => !filled(x + dx, y + dy, z + dz);
        // Counter-clockwise seen from outside.
        if (f(0, 0, 1)) quad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], [0, 0, 1]);
        if (f(0, 0, -1)) quad([[x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]], [0, 0, -1]);
        if (f(1, 0, 0)) quad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], [1, 0, 0]);
        if (f(-1, 0, 0)) quad([[x, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z]], [-1, 0, 0]);
        if (f(0, 1, 0)) quad([[x, y + 1, z], [x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]], [0, 1, 0]);
        if (f(0, -1, 0)) quad([[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], [0, -1, 0]);
      }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), bbox: { min: [0, 0, 0], max: [n, n, n] }, volumeMm3: vol, areaMm2: idx.length / 6 };
}

describe('printability', () => {
  it('finds the orientation of a T that needs no support (bar on the bed)', () => {
    // A T standing on its stem along +t: bar at the top (t 16..20), stem x 8..12.
    const T = (x: number, y: number, z: number) => x >= 0 && x < 20 && y >= 0 && y < 6 && z >= 0 && z < 20 && (z >= 16 || (x >= 8 && x < 12));
    const o = orientPiece(voxelMesh(T, 20));
    expect(o.supportMm3).toBeLessThan(1);
    expect(o.up === 5 || o.up === 2 || o.up === 3).toBe(true); // bar down, or lying flat on a side
  });

  it('counts support under an overhang when it has to', () => {
    // A closed hollow cube: whichever way up, the cavity has a ceiling (12 × 12 mm, 4 mm above its floor).
    const hollow = (x: number, y: number, z: number) =>
      x >= 0 && y >= 0 && z >= 0 && x < 20 && y < 20 && z < 20 && !(x >= 4 && x < 16 && y >= 4 && y < 16 && z >= 4 && z < 16);
    const o = orientPiece(voxelMesh(hollow, 20));
    expect(o.overhangMm2).toBeCloseTo(144, 6);
    // Columns are measured down to the bed (conservative: real support would stand on the cavity floor).
    expect(o.supportMm3).toBeCloseTo(144 * 16, 6);
  });

  it('moves hot pieces to a higher-temperature filament, with a 20 K margin', () => {
    expect(chooseFilament('petg', 40).mat.id).toBe('petg');
    expect(chooseFilament('petg', 60).mat.id).toBe('asa');
    expect(chooseFilament('pla', 30).mat.id).toBe('pla');
    expect(chooseFilament('pla', 45).mat.id).toBe('petg');
    expect(chooseFilament('pla', 45).upgraded).toBe(true);
  });

  it('prices a solid cube as all perimeter and a big one partly as infill', () => {
    const petg = MATERIALS.find((m) => m.id === 'petg')!;
    const small = voxelMesh((x, y, z) => x < 2 && y < 2 && z < 2 && x >= 0 && y >= 0 && z >= 0, 2);
    expect(pieceCost(small, 0, petg, DEFAULT_SLICER).printedMm3).toBeCloseTo(8, 6);
    const big = voxelMesh((x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < 40 && y < 40 && z < 40, 40);
    const c = pieceCost(big, 0, petg, DEFAULT_SLICER);
    expect(c.printedMm3).toBeLessThan(big.volumeMm3 * 0.5);
    expect(c.massG).toBeGreaterThan(0);
    expect(c.timeMin).toBeGreaterThan(0);
  });

  it('cuts the shell into pieces that fit a 250 mm build volume and plans every one', () => {
    const cfg = defaultConfig();
    const d = solve(cfg, { beamWidth: 10, wrapMetrics: false }).designs[0];
    const opt = { ...DEFAULT_PRINT };
    for (const b of planPieces(d, opt)) for (let a = 0; a < 3; a++) expect(b.max[a] - b.min[a]).toBeLessThanOrEqual(250 - 8 + 1e-6);
    const pieces = printPieces(d, cfg, opt);
    const m = buildManifest(d, cfg, pieces, 'petg', DEFAULT_SLICER, false);
    expect(m.rows.length).toBe(pieces.length);
    expect(m.totalMassG).toBeGreaterThan(50);
    for (const r of m.rows) expect(r.sizeMm.every((s) => s <= 250)).toBe(true);
    // PETG isn't V-0, so the pieces next to the PSU are flagged.
    expect(m.rows.some((r) => r.needsV0)).toBe(true);
    expect(m.flags.some((f) => /V-0/.test(f))).toBe(true);
    expect(m.flags.some((f) => /EMI/.test(f))).toBe(true);
    console.log(`${pieces.length} pieces, ${Math.round(m.totalMassG)} g, ${(m.totalTimeMin / 60).toFixed(1)} h, ${m.totalSupportCm3.toFixed(0)} cm³ support`);
  }, 300000);
});
