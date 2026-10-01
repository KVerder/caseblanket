import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { axisOf, wallAxes, type Vec3 } from '../src/solver/geometry';
import { bossMesh, boardHoles, fanHoleSpacing, mountPlan, type Standoff } from '../src/print/mounts';
import { DEFAULT_PRINT, fitTestPieces, printPieces, wallSolid } from '../src/print/printable';
import { shellField, type ShellMesh } from '../src/solver/shrinkwrap';

/** Every edge used exactly twice, in opposite directions; signed volume (divergence theorem). */
function closedVolume(m: ShellMesh) {
  const edges = new Map<string, number>();
  const P = (i: number) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
  let vol = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(`${u},${v}`, (edges.get(`${u},${v}`) ?? 0) + 1);
    const [p, q, r] = [P(a), P(b), P(c)];
    vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
  }
  let open = 0;
  for (const [k, n] of edges) {
    const [u, v] = k.split(',');
    if (n !== 1 || edges.get(`${v},${u}`) !== 1) open++;
  }
  return { open, vol };
}

describe('mounting points', () => {
  const cfg = defaultConfig();
  const design = solve(cfg, { wrapMetrics: false }).designs[0];
  const plan = mountPlan(design, cfg);

  it('makes closed, outward-facing standoff bosses with an insert hole, pointing either way', () => {
    for (const sign of [1, -1]) {
      const s: Standoff = { label: 't', top: [10, 20, sign * 15], base: [10, 20, 0], axis: 2, length: 15 };
      const m = bossMesh(s);
      const { open, vol } = closedVolume(m);
      expect(open).toBe(0);
      // Cylinder Ø9 × 15 minus the Ø4 × 6.8 hole, within the 40-gon's faceting.
      const exact = Math.PI * 4.5 ** 2 * 15 - Math.PI * 2 ** 2 * 6.8;
      expect(vol).toBeGreaterThan(exact * 0.97);
      expect(vol).toBeLessThan(exact * 1.01);
    }
  });

  it('places four Mini-ITX standoffs at the standard spacing, from the PCB down into the wall', () => {
    expect(boardHoles(cfg.parts.board).holes).toHaveLength(4);
    const boardOnes = plan.standoffs.filter((s) => s.label.startsWith('standoff'));
    expect(boardOnes).toHaveLength(4);
    const us = [...new Set(boardOnes.map((s) => s.top[0].toFixed(2)))].map(Number).sort((a, b) => a - b);
    expect(us[1] - us[0]).toBeCloseTo(154.94, 2);
    const board = design.parts.find((p) => p.kind === 'board')!;
    const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
    for (const s of boardOnes) {
      expect(s.top[2]).toBeCloseTo(board.body.min[2] + cfg.parts.board.underside, 6);
      // The base is embedded in the wall material (between the inner and outer surface).
      const f = F(s.base);
      expect(f).toBeGreaterThanOrEqual(-design.wall);
      expect(f).toBeLessThanOrEqual(0);
    }
  });

  it('puts 105 mm fan patterns on the radiator panel, with holes through and solid land around them', () => {
    expect(fanHoleSpacing(120)!.spacing).toBe(105);
    const fanHoles = plan.holes.filter((h) => h.label.includes('fan'));
    expect(fanHoles.length % 4).toBe(0);
    expect(fanHoles.length).toBeGreaterThan(0);
    const solid = wallSolid(design, cfg, DEFAULT_PRINT, plan);
    for (const h of fanHoles.slice(0, 4)) {
      const a = axisOf(h.wall);
      const [xa, ya] = wallAxes(a);
      // Find the wall along the normal at the land just outside the hole, then test the hole and the land there.
      const at = (dx: number, t: number): Vec3 => {
        const p: Vec3 = [0, 0, 0];
        p[xa] = h.x + dx;
        p[ya] = h.y;
        p[a] = t;
        return p;
      };
      let tWall = NaN;
      for (let t = -10; t < 10; t += 0.1) if (solid(at(h.d / 2 + 2, t)) < 0) tWall = t;
      expect(Number.isFinite(tWall)).toBe(true);
      expect(solid(at(0, tWall))).toBeGreaterThan(0); // open at the hole
      expect(solid(at(h.d / 2 + 2, tWall))).toBeLessThan(0); // land: no vent perforation next to it
    }
  });

  it('holds the PSU: screw holes on its plate or panel, and an opening for the inlet', () => {
    const psuHoles = plan.bulkheads.flatMap((b) => b.holes).length + plan.holes.filter((h) => h.label === 'PSU').length;
    expect(psuHoles).toBe(4);
    expect(plan.bulkheads.some((b) => b.opening) || plan.openings.some((o) => o.label.startsWith('PSU'))).toBe(true);
    const solid = wallSolid(design, cfg, DEFAULT_PRINT, plan);
    for (const b of plan.bulkheads) {
      const [xa, ya] = wallAxes(b.axis);
      const mid = (b.slab.min[b.axis] + b.slab.max[b.axis]) / 2;
      for (const h of b.holes) {
        const p: Vec3 = [0, 0, 0];
        p[b.axis] = mid;
        p[xa] = h.x;
        p[ya] = h.y;
        expect(solid(p)).toBeGreaterThan(0);
        p[xa] = h.x + h.d / 2 + 1.5;
        expect(solid(p)).toBeLessThan(0);
      }
    }
  });

  it('clamps the GPU bracket with two bosses beside its opening, clear of the parts', () => {
    if (!design.vents.some((v) => v.kind === 'bracket')) return;
    expect(plan.clamp).toBeDefined();
    const bosses = plan.standoffs.filter((s) => s.label.includes('bracket'));
    expect(bosses).toHaveLength(2);
    const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
    for (const b of bosses) {
      expect(b.axis).toBe(0);
      expect(F(b.base)).toBeGreaterThanOrEqual(-design.wall);
      expect(b.top[0]).toBeGreaterThan(b.base[0]);
    }
    expect(fitTestPieces(design, cfg, plan).some((p) => p.name === 'gpu-bracket-clamp')).toBe(true);
  });

  it('places a power button on the front panel and lists the hardware', () => {
    expect(plan.holes.some((h) => h.label === 'power button' && h.wall === 0)).toBe(true);
    const qty = (s: string) => plan.hardware.find((h) => h.item.includes(s))?.qty ?? 0;
    expect(qty('heat-set insert')).toBe(4);
    expect(qty('push button')).toBe(1);
  });

  it('prints the standoffs with the pieces, and the fit tests on their own', () => {
    const pieces = printPieces(design, cfg, DEFAULT_PRINT, undefined, plan);
    const withBoss = pieces.filter((p) => p.mesh.positions.length > 0 && plan.standoffs.some((s) => [0, 1, 2].every((a) => s.top[a] >= p.box.min[a] && s.top[a] <= p.box.max[a])));
    expect(withBoss.length + pieces.filter((p) => p.name.startsWith('standoff')).length).toBeGreaterThan(0);
    const fits = fitTestPieces(design, cfg, plan);
    expect(fits.map((f) => f.name)).toEqual(expect.arrayContaining(['fit-board-standoffs', 'fit-fan-120', `fit-psu-${cfg.parts.psu.formFactor}`]));
    for (const f of fits) expect(f.mesh.indices.length).toBeGreaterThan(100);
  }, 120000);
});

describe('PSU mounting, both ways', () => {
  it('back-panel inlet (default): screw holes and the inlet opening in the panel, no extension', () => {
    const cfg = defaultConfig();
    expect(cfg.prefs.psuInletAtBack).toBe(true);
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const plan = mountPlan(d, cfg);
    expect(plan.bulkheads).toHaveLength(0);
    expect(plan.holes.filter((h) => h.label === 'PSU')).toHaveLength(4);
    expect(plan.openings.some((o) => o.label.startsWith('PSU'))).toBe(true);
    expect(plan.hardware.some((h) => h.item.includes('IEC'))).toBe(false);
  });
  it('inlet inside the case: a printed plate, an IEC socket cut-out, and room for the plug', () => {
    const cfg = defaultConfig();
    cfg.prefs.psuInletAtBack = false;
    const d = solve(cfg, { wrapMetrics: false }).designs[0];
    const plan = mountPlan(d, cfg);
    const inside = !d.vents.some((v) => v.kind === 'psu-exhaust');
    if (inside) {
      expect(plan.bulkheads).toHaveLength(1);
      expect(plan.openings.some((o) => o.label === 'IEC socket')).toBe(true);
      expect(plan.warnings.some((w) => w.includes('won’t fit') || w.includes("won't fit"))).toBe(false);
    }
  });
});
