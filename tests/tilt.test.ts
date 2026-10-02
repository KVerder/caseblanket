import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { buildItems, PROFILES } from '../src/solver/items';
import { boxToTilt, partAxis, partPoint, tiltDims, tiltToBox, type Tilt } from '../src/solver/tilt';
import { buildScene } from '../src/cfd/scene';
import { mountPlan } from '../src/print/mounts';
import { DEFAULT_PRINT, wallSolid } from '../src/print/printable';
import type { Design } from '../src/solver/evaluate';
import type { DesignConfig } from '../src/model/types';

describe('tilt geometry', () => {
  it('is a rigid rotation that fits its bounding box, with the panel end on the panel', () => {
    const tilt: Tilt = { deg: 30, size: [400, 120, 55] };
    const D = tiltDims(tilt.size, 30);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [0, 400]) for (const y of [0, 120]) for (const z of [0, 55]) {
      const q = tiltToBox(tilt, [x, y, z]);
      const b = boxToTilt(tilt, q);
      expect(Math.hypot(b[0] - x, b[1] - y, b[2] - z)).toBeLessThan(1e-9);
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], q[a]);
        hi[a] = Math.max(hi[a], q[a]);
      }
    }
    for (let a = 0; a < 3; a++) {
      expect(lo[a]).toBeCloseTo(0, 9);
      expect(hi[a]).toBeCloseTo(D[a], 9);
    }
    // Edge lengths are kept (rigid).
    const p = tiltToBox(tilt, [400, 0, 55]);
    const o = tiltToBox(tilt, [0, 0, 55]);
    expect(Math.hypot(p[0] - o[0], p[2] - o[2])).toBeCloseTo(400, 9);
    expect(o[2]).toBeCloseTo(D[2], 9); // the panel-side start touches the panel
  });
});

describe('tilted radiators and case fans', () => {
  const tiltedOf = (cfg: DesignConfig) => solve(cfg, { wrapMetrics: false }).space.filter((d) => d.parts.some((p) => p.tilt));

  it('are only tried when allowed, at 15, 30 and 45 degrees', () => {
    const off = defaultConfig();
    off.prefs.allowTilt = false;
    expect(buildItems({ cfg: off, topology: 'flat', profile: PROFILES[0] }).some((it) => it.variants.some((v) => v.parts.some((p) => p.tilt)))).toBe(false);
    const cfg = defaultConfig();
    const tilted = tiltedOf(cfg);
    expect(tilted.length).toBeGreaterThan(5);
    const degs = new Set(tilted.flatMap((d) => d.parts.filter((p) => p.tilt).map((p) => p.tilt!.deg)));
    expect([...degs].sort((a, b) => a - b)).toEqual([15, 30, 45]);
  }, 60000);

  let d: Design;
  let cfg: DesignConfig;
  it('carry a turn loss in the airflow model, fan disks along their tilted axis in 3D, and a printed wedge frame', () => {
    cfg = defaultConfig();
    d = tiltedOf(cfg).filter((x) => !x.invalid).sort((a, b) => b.flow.worstMargin - a.flow.worstMargin)[0];
    const part = d.parts.find((p) => p.tilt)!;
    const group = d.recipe.net.groups.find((g) => g.id === part.id)!;
    expect(group.losses.some((l) => l.label === 'tilt turn' && l.zeta > 0)).toBe(true);

    const scene = buildScene(d, cfg, undefined, { cells: 20000 });
    const disks = scene.fans.filter((f) => f.group === part.id);
    expect(disks.length).toBe(part.fanCount ?? 1);
    const e3 = partAxis(part, 2);
    for (const f of disks) {
      expect(f.dir).toBeDefined();
      expect(Math.abs(f.dir![0] * e3[0] + f.dir![1] * e3[1] + f.dir![2] * e3[2])).toBeCloseTo(1, 6);
    }

    const plan = mountPlan(d, cfg);
    const frame = plan.tiltFrames.find((f) => f.label.startsWith(part.label))!;
    expect(frame.holes).toHaveLength(4 * frame.fans.length);
    expect(plan.holes.some((h) => h.label.startsWith(`${part.label} fan`))).toBe(false);
    const solid = wallSolid(d, cfg, DEFAULT_PRINT, plan);
    const [L, W, T] = part.tilt!.size;
    const fan0 = frame.fans[0];
    // Solid plate in the corner outside the fan opening; open at the fan's centre.
    expect(solid(partPoint(part, [fan0.x - 57, 3, T - 1.5]))).toBeLessThan(0);
    expect(solid(partPoint(part, [fan0.x, W / 2, T - 1.5]))).toBeGreaterThan(0);
    // The side wall reaches from the plate toward the panel near the lifted end.
    expect(solid(partPoint(part, [L - 20, 1.5, T + 5]))).toBeLessThan(0);
  }, 60000);
});
