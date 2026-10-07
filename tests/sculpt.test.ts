import { describe, expect, it } from 'vitest';
import { defaultConfig, SHOWCASE } from '../src/model/presets';
import type { DesignConfig } from '../src/model/types';
import { solve } from '../src/solver/solve';
import { envelopePoints } from '../src/solver/sculpt';
import { meshShell, shellBounds, shellField, ventAxis, wrapMetrics } from '../src/solver/shrinkwrap';
import { axisOf, type Vec3 } from '../src/solver/geometry';
import { DEFAULT_PRINT, planPieces, printPieces } from '../src/print/printable';
import { mountPlan } from '../src/print/mounts';

const shaped = (shell: 'facet' | 'pebble', orientation: 'tower' | 'console', sculpt = { cut: 0.8, slope: 0, round: 0.7 }) => {
  const cfg = defaultConfig();
  cfg.prefs.shell = shell;
  cfg.prefs.orientation = orientation;
  cfg.prefs.sculpt = sculpt;
  return { cfg, d: solve(cfg, { wrapMetrics: false }).designs[0] };
};

/** Wall thickness along the surface normal, on rays from the middle of the case. */
function wallThickness(F: (p: Vec3) => number, centre: Vec3, wall: number, rays = 200): number[] {
  const out: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < rays; i++) {
    const z = 2 * rnd() - 1;
    const ph = 2 * Math.PI * rnd();
    const r = Math.sqrt(1 - z * z);
    const dir: Vec3 = [r * Math.cos(ph), r * Math.sin(ph), z];
    const at = (t: number): Vec3 => [centre[0] + dir[0] * t, centre[1] + dir[1] * t, centre[2] + dir[2] * t];
    let tOut = NaN;
    let tIn = NaN;
    for (let t = 700; t > 0; t -= 0.05) {
      const f = F(at(t));
      if (Number.isNaN(tOut) && f <= 0) tOut = t;
      if (f <= -wall) {
        tIn = t;
        break;
      }
    }
    const p = at(tOut);
    const g = [0, 1, 2].map((a) => {
      const q1 = [...p] as Vec3;
      const q2 = [...p] as Vec3;
      q1[a] += 0.2;
      q2[a] -= 0.2;
      return (F(q1) - F(q2)) / 0.4;
    });
    const cos = Math.abs(g[0] * dir[0] + g[1] * dir[1] + g[2] * dir[2]) / Math.hypot(...g);
    out.push((tOut - tIn) * cos);
  }
  return out.sort((a, b) => a - b);
}

describe('sculpted shells: angled and curved panels', () => {
  for (const shell of ['facet', 'pebble'] as const)
    for (const orientation of ['tower', 'console'] as const)
      it(`${shell} (${orientation}): every part inside the inner wall, walls one wall thick, a flat back`, () => {
        const { cfg, d } = shaped(shell, orientation, { cut: 0.8, slope: 20, round: 0.7 });
        const F = shellField(d, cfg, 0);
        for (const e of envelopePoints(d, cfg)) expect(F(e.p) + e.r).toBeLessThanOrEqual(-d.wall + 1e-6);
        const th = wallThickness(F, d.interior.map((x) => x / 2) as Vec3, d.wall);
        expect(th[Math.floor(th.length * 0.05)]).toBeGreaterThan(d.wall - 0.15);
        expect(th[Math.floor(th.length * 0.95)]).toBeLessThan(d.wall + 0.15);
        // The back is the plane u = −wall over the rear I/O plate.
        const board = d.parts.find((p) => p.kind === 'board')!;
        const c: Vec3 = [-d.wall, (board.clearance.min[1] + board.clearance.max[1]) / 2, (board.clearance.min[2] + board.clearance.max[2]) / 2];
        expect(Math.abs(F(c))).toBeLessThan(0.05);
      }, 60000);

  it('bevels save volume over the box, curves cost some, and a lean brings the base forward', () => {
    const flat = shaped('facet', 'tower', { cut: 0.8, slope: 0, round: 0.6 });
    const lean = shaped('facet', 'tower', { cut: 0.8, slope: 25, round: 0.6 });
    const peb = shaped('pebble', 'tower', { cut: 0.8, slope: 0, round: 0.6 });
    const mFlat = wrapMetrics(flat.d, flat.cfg, 0);
    const mLean = wrapMetrics(lean.d, lean.cfg, 0);
    const vPeb = wrapMetrics(peb.d, peb.cfg, 0).volumeL;
    expect(mFlat.volumeL).toBeLessThan(flat.d.volumeL);
    expect(mLean.world.depth).toBeGreaterThan(mFlat.world.depth + 10);
    expect(vPeb).toBeGreaterThan(peb.d.volumeL);
    expect(vPeb).toBeLessThan(peb.d.volumeL * 1.35);
  }, 60000);

  it('the mesh, the print pieces and the 3D view cover the whole shell, with holes laid out in each vent wall', () => {
    const { cfg, d } = shaped('pebble', 'tower', { cut: 0.8, slope: 0, round: 1 });
    const b = shellBounds(d, cfg);
    const m = meshShell(d, cfg, 0);
    for (let a = 0; a < 3; a++) {
      expect(m.bbox.min[a]).toBeGreaterThanOrEqual(b.min[a] - 1);
      expect(m.bbox.max[a]).toBeLessThanOrEqual(b.max[a] + 1);
      // Past the interior box: a grid at the old fixed padding would have clipped it open.
      expect(Math.max(-m.bbox.min[a], m.bbox.max[a] - d.interior[a])).toBeGreaterThan(d.wall);
    }
    const pieces = planPieces(d, DEFAULT_PRINT, b);
    for (let a = 0; a < 3; a++) {
      expect(Math.min(...pieces.map((p) => p.min[a]))).toBeLessThanOrEqual(m.bbox.min[a]);
      expect(Math.max(...pieces.map((p) => p.max[a]))).toBeGreaterThanOrEqual(m.bbox.max[a]);
    }
    const ax = ventAxis(d, m);
    const used = new Set([...ax].filter((x) => x >= 0));
    expect(used.size).toBeGreaterThan(0);
    for (const a of used) expect(d.vents.some((v) => axisOf(v.wall) === a)).toBe(true);
  }, 60000);
});

describe('showcase designs', () => {
  const build = (id: string) => {
    const cfg: DesignConfig = defaultConfig();
    SHOWCASE.find((x) => x.id === id)!.apply(cfg);
    return { cfg, d: solve(cfg, { wrapMetrics: false }).designs[0] };
  };
  it('four of them, each shrinkwrapped or sculpted, each with a power button somewhere flat', () => {
    expect(SHOWCASE).toHaveLength(4);
    for (const x of SHOWCASE) {
      const { cfg, d } = build(x.id);
      expect(['facet', 'pebble', 'wrap']).toContain(cfg.prefs.shell);
      expect(d.invalid).toBe(false);
      expect(mountPlan(d, cfg).holes.some((h) => h.label === 'power button')).toBe(true);
    }
  }, 120000);
  it('the cooling flagship finds its layout with the default parts, valid and printable', () => {
    const x = SHOWCASE.find((s) => s.id === 'flagship')!;
    const cfg: DesignConfig = defaultConfig();
    x.apply(cfg);
    const d = solve(cfg, { wrapMetrics: false }).space.find((s) => s.id === x.designId)!;
    expect(d).toBeDefined();
    expect(d.invalid).toBe(false);
    expect(d.parts.some((p) => p.tilt)).toBe(false);
    const pieces = printPieces(d, cfg, DEFAULT_PRINT);
    expect(pieces.reduce((s, p) => s + (p.dropped ?? 0), 0)).toBe(0);
  }, 300000);
  it('the Seed prints without loose fragments', () => {
    const { cfg, d } = build('seed');
    const pieces = printPieces(d, cfg, DEFAULT_PRINT);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((s, p) => s + (p.dropped ?? 0), 0)).toBe(0);
  }, 180000);
});
