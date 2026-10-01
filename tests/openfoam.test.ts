import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../src/model/presets';
import { openfoamCase } from '../src/export/openfoam';
import { solve } from '../src/solver/solve';

/** Strip // and C-style comments and quoted strings, for structural checks. */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"[^"\n]*"/g, '""');

describe('OpenFOAM case export', () => {
  const cfg = defaultConfig();
  const design = solve(cfg, { beamWidth: 12, wrapMetrics: false }).designs[0];
  const files = openfoamCase(design, cfg, undefined, { iterations: Number(process.env.OPENFOAM_ITERATIONS ?? 2000), cellMm: Number(process.env.OPENFOAM_CELL_MM ?? 8) });
  const get = (p: string) => files.find((f) => f.path === p)?.data ?? '';

  it('writes a complete case: mesh, solver, physics and initial fields', () => {
    for (const p of [
      'Allrun',
      'system/blockMeshDict',
      'system/surfaceFeatureExtractDict',
      'system/snappyHexMeshDict',
      'system/topoSetDict',
      'system/createBafflesDict',
      'system/controlDict',
      'system/fvSchemes',
      'system/fvSolution',
      'constant/g',
      'constant/thermophysicalProperties',
      'constant/turbulenceProperties',
      'constant/fvOptions',
      '0/U',
      '0/p_rgh',
      '0/p',
      '0/T',
      '0/k',
      '0/omega',
      '0/nut',
      '0/alphat',
      '0/s',
    ])
      expect(get(p).length, p).toBeGreaterThan(20);
  });

  it('has parseable dictionaries: a FoamFile header and balanced braces and brackets', () => {
    for (const f of files) {
      if (!f.path.startsWith('system/') && !f.path.startsWith('constant/') && !f.path.startsWith('0/')) continue;
      if (f.path.endsWith('.stl')) continue;
      expect(f.data, f.path).toMatch(/FoamFile\s*\{[\s\S]*?object\s+\S+;[\s\S]*?\}/);
      const s = strip(f.data);
      let curly = 0;
      let round = 0;
      for (const ch of s) {
        if (ch === '{') curly++;
        if (ch === '}') curly--;
        if (ch === '(') round++;
        if (ch === ')') round--;
        expect(curly, f.path).toBeGreaterThanOrEqual(0);
        expect(round, f.path).toBeGreaterThanOrEqual(0);
      }
      expect([curly, round], f.path).toEqual([0, 0]);
      // Every entry line inside a dictionary ends in ; { } ( or ).
      for (const line of s.split('\n').map((l) => l.trim())) {
        if (!line || line.startsWith('#')) continue;
        expect(/[;{}()]$|^[A-Za-z_"][^;]*$/.test(line), `${f.path}: "${line}"`).toBe(true);
      }
    }
  });

  it('references only surfaces and zones that exist', () => {
    const snappy = get('system/snappyHexMeshDict');
    for (const m of snappy.matchAll(/(\S+)\.stl \{ type triSurfaceMesh/g)) expect(files.some((f) => f.path === `constant/triSurface/${m[1]}.stl`), m[1]).toBe(true);
    const zones = new Set([...get('system/topoSetDict').matchAll(/name\s+(\S+);/g)].map((m) => m[1]));
    for (const m of get('constant/fvOptions').matchAll(/cellZone\s+(\S+);/g)) expect(zones.has(m[1]), m[1]).toBe(true);
    // Every faceZone the baffles use comes from a snappy surface.
    for (const m of get('system/createBafflesDict').matchAll(/zoneName\s+(\S+);/g)) expect(snappy.includes(`faceZone ${m[1]};`), m[1]).toBe(true);
    // Fans: one fan-curve baffle and one flow function per fan disk.
    const fans = [...snappy.matchAll(/(fan\d+_\S+)\.stl/g)].map((m) => m[1]);
    expect(fans.length).toBeGreaterThan(0);
    for (const f of fans) {
      expect(get('system/createBafflesDict')).toContain(`${f}_a`);
      expect(get('system/controlDict')).toContain(`flow_${f}`);
    }
  });

  it('writes valid ASCII STL surfaces', () => {
    for (const f of files.filter((x) => x.path.endsWith('.stl'))) {
      const facets = (f.data.match(/facet normal/g) ?? []).length;
      const verts = (f.data.match(/vertex /g) ?? []).length;
      expect(verts, f.path).toBe(3 * facets);
      expect(f.data.trim().endsWith(`endsolid ${f.path.split('/').pop()!.replace('.stl', '')}`)).toBe(true);
    }
  });

  it('writes the case to disk when asked (for the CI job that meshes and runs it)', () => {
    const out = process.env.OPENFOAM_OUT;
    if (!out) return;
    for (const f of files) {
      const p = join(out, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data, { mode: f.path === 'Allrun' ? 0o755 : 0o644 });
    }
  });
});

describe('OpenFOAM results import', () => {
  it('reads the last row of each function object and compares it with the app', async () => {
    const { parseFoamResults, compareWithApp } = await import('../src/export/foamResults');
    const cfg = defaultConfig();
    const d = solve(cfg, { beamWidth: 12, wrapMetrics: false }).designs[0];
    const rad = d.flow.groups.find((g) => g.id.startsWith('rad'))!;
    const hdr = '# Surface field value\n# Time sum(phi)\n';
    const files = [
      // Two restart folders: the later one wins.
      { path: `postProcessing/flow_fan3_${rad.id.replace('-', '_')}/0/surfaceFieldValue.dat`, text: hdr + '1 0.001\n2 0.002\n' },
      { path: `postProcessing/flow_fan3_${rad.id.replace('-', '_')}/100/surfaceFieldValue.dat`, text: hdr + `150 ${(rad.flow * 1.2 * 1.1).toFixed(6)}\n` },
      { path: 'postProcessing/tzone_heat_board/0/volFieldValue.dat', text: '# Time volAverage(T) volAverage(s)\n150 305.15 0.4\n' },
      { path: 'postProcessing/tin_fan3_x/0/surfaceFieldValue.dat', text: '# Time weightedAverage(T) weightedAverage(s)\n150 299.15 0.1\n' },
    ];
    const r = parseFoamResults(files);
    expect(r.iteration).toBe(150);
    const c = compareWithApp(d, cfg.prefs.ambientC, r);
    const flowRow = c.rows.find((x) => x.unit === 'CFM')!;
    expect(flowRow.difference).toBeCloseTo(10, 0);
    expect(c.recirculation[0].share).toBeCloseTo(0.25, 6);
  });
});

describe('OpenFOAM reference run (CI, after the case has run)', () => {
  // OPENFOAM_RESULTS=<case folder>: import its postProcessing results and print them next to the app.
  it('imports the run and compares it with the app', async () => {
    const dir = process.env.OPENFOAM_RESULTS;
    if (!dir) return;
    const { parseFoamResults, compareWithApp } = await import('../src/export/foamResults');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = walk(join(dir, 'postProcessing'))
      .filter((p) => p.endsWith('.dat'))
      .map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
    const cfg = defaultConfig();
    const d = solve(cfg, { beamWidth: 12, wrapMetrics: false }).designs[0];
    const r = parseFoamResults(files);
    const c = compareWithApp(d, cfg.prefs.ambientC, r);
    console.log(`OpenFOAM after ${r.iteration} iterations vs the app (1D model):`);
    for (const row of c.rows) console.log(`  ${row.what.padEnd(36)} app ${row.app.toFixed(1).padStart(6)} ${row.unit}  OpenFOAM ${row.reference.toFixed(1).padStart(6)}  diff ${row.difference >= 0 ? '+' : ''}${row.difference.toFixed(1)}${row.unit === 'CFM' ? ' %' : ' K'}`);
    for (const x of c.recirculation) console.log(`  recirculation at ${x.fan}: ${(x.share * 100).toFixed(0)} %`);
    expect(r.iteration).toBeGreaterThan(0);
    expect(c.rows.filter((x) => x.unit === 'CFM').length).toBeGreaterThan(0);
    for (const row of c.rows) expect(Number.isFinite(row.reference)).toBe(true);
  });
});
