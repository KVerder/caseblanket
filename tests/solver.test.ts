import { describe, expect, it } from 'vitest';
import { COOLERS, defaultConfig, GPUS, psuFromFormFactor } from '../src/model/presets';
import type { DesignConfig } from '../src/model/types';
import type { Design } from '../src/solver/evaluate';
import { boxesOverlap, localToWorld, type Box } from '../src/solver/geometry';
import { solve } from '../src/solver/solve';

const inside = (b: Box, interior: [number, number, number]) => b.min.every((v) => v >= -0.01) && b.max.every((v, i) => v <= interior[i] + 0.01);

function assertSound(d: Design) {
  for (const p of d.parts) expect(inside(p.body, d.interior), `${p.id} inside ${d.id}`).toBe(true);
  for (let i = 0; i < d.parts.length; i++) {
    for (let j = i + 1; j < d.parts.length; j++) {
      const a = d.parts[i];
      const b = d.parts[j];
      // The direct-slot card sits in the board's own footprint by design.
      if (a.kind === 'board' && b.kind === 'gpu' && d.topology.startsWith('direct')) continue;
      expect(boxesOverlap(a.body, b.body, 0.05), `${a.id} vs ${b.id} in ${d.id}`).toBe(false);
    }
  }
  const board = d.parts.find((p) => p.kind === 'board')!;
  const gpu = d.parts.find((p) => p.kind === 'gpu')!;
  // Rear I/O and the GPU bracket both reach the back wall (fillet margins aside).
  expect(board.body.min[0]).toBeLessThan(d.interior[0] * 0.05 + 1);
  expect(gpu.body.min[0]).toBeLessThan(d.interior[0] * 0.05 + 1);
  // Radiators always face a panel.
  for (const p of d.parts) if (p.kind.startsWith('rad')) expect(p.faceAtWall).toBe(true);
}

function variantCfg(mut: (c: DesignConfig) => void) {
  const c = defaultConfig();
  mut(c);
  return c;
}

describe('solver', () => {
  const cases: [string, DesignConfig][] = [
    ['default', defaultConfig()],
    ['240 GPU + AIO CPU', variantCfg((c) => ((c.parts.gpu = structuredClone(GPUS.find((g) => g.name.includes('4090'))!)), (c.parts.cooler = structuredClone(COOLERS.find((x) => x.kind === 'aio')!))))],
    ['air GPU + tower', variantCfg((c) => ((c.parts.gpu = structuredClone(GPUS.find((g) => g.cooling === 'air')!)), (c.parts.cooler = structuredClone(COOLERS.find((x) => x.kind === 'air-tower')!))))],
    ['flex ATX + console + chamfer', variantCfg((c) => ((c.parts.psu = psuFromFormFactor('flex-atx', 600)), (c.prefs.orientation = 'console'), (c.prefs.edgeStyle = 'chamfer'), (c.prefs.edgeRadius = 12)))],
    ['no riser', variantCfg((c) => ((c.prefs.topologies.flat = false), (c.prefs.topologies.sandwich = false)))],
  ];

  for (const [name, cfg] of cases) {
    it(`builds sound designs: ${name}`, () => {
      const r = solve(cfg, { beamWidth: 24 });
      expect(r.designs.length).toBeGreaterThan(0);
      expect(r.designs[0].invalid).toBe(false);
      for (const d of r.designs) assertSound(d);
    });
  }

  it('keeps the GPU chirality physical: fingers are opposite the cooler-side rule', () => {
    const r = solve(defaultConfig(), { beamWidth: 16 });
    for (const d of r.designs) {
      const gpu = d.parts.find((p) => p.kind === 'gpu')!;
      // e1 (bracket → end) points away from the rear wall in every design.
      expect(gpu.frame.d[0]).toBe(0);
      // Finger edge and top edge are on opposite sides along the e2 axis.
      const fingers = localToWorld(gpu.frame, gpu.body, [90, 0, 0]);
      const top = localToWorld(gpu.frame, gpu.body, [90, gpu.size[1], 0]);
      expect(fingers).not.toEqual(top);
    }
  });

  it('trades size for thinness when asked', () => {
    // Airflow priority 0 isolates the thickness/volume trade-off.
    const thin = solve(variantCfg((c) => ((c.prefs.thinnessPriority = 1), (c.prefs.airflowPriority = 0))), { beamWidth: 24 }).designs[0];
    const small = solve(variantCfg((c) => ((c.prefs.thinnessPriority = 0), (c.prefs.airflowPriority = 0))), { beamWidth: 24 }).designs[0];
    expect(thin.thickness).toBeLessThanOrEqual(small.thickness);
    expect(small.volumeL).toBeLessThanOrEqual(thin.volumeL + 1e-6);
  });

  it('honours external size limits', () => {
    const cfg = variantCfg((c) => ((c.prefs.maxDepth = 400), (c.prefs.orientation = 'tower')));
    const r = solve(cfg, { beamWidth: 24 });
    const ok = r.designs.filter((d) => !d.invalid);
    expect(ok.length).toBeGreaterThan(0);
    for (const d of ok) expect(d.world.depth).toBeLessThanOrEqual(400.5);
  });

  it('grows the case when a large fillet would cut into a corner part', () => {
    const sharp = solve(variantCfg((c) => (c.prefs.edgeRadius = 0)), { beamWidth: 16 }).designs[0];
    const round = solve(variantCfg((c) => (c.prefs.edgeRadius = 40)), { beamWidth: 16 }).designs[0];
    expect(round.volumeL).toBeGreaterThan(sharp.volumeL * 0.98);
    expect(Math.max(...round.exterior)).toBeGreaterThan(Math.max(...sharp.exterior));
  });

  it('puts the PSU inlet on the back panel when asked', () => {
    const r = solve(variantCfg((c) => (c.prefs.psuInletAtBack = true)), { beamWidth: 24 });
    const d = r.designs[0];
    const psu = d.parts.find((p) => p.kind === 'psu')!;
    expect(psu.body.min[0]).toBeLessThan(5);
    expect(d.checks.some((c) => c.text.startsWith('PSU AC inlet'))).toBe(false);
  });
});
