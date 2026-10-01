import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import type { DesignConfig } from '../src/model/types';
import { connectorBox, gpuWrapClearance, hoseDistance, routedPaths } from '../src/solver/hoses';
import { meshShell, shellField, wrapMetrics } from '../src/solver/shrinkwrap';
import { solve } from '../src/solver/solve';
import type { Box, Vec3 } from '../src/solver/geometry';
import type { Design } from '../src/solver/evaluate';

const withShell = (cfg: DesignConfig, shell: 'box' | 'wrap'): DesignConfig => ({ ...cfg, prefs: { ...cfg.prefs, shell } });
const inBox = (p: Vec3, b: Box) => p.every((x, a) => x >= b.min[a] && x <= b.max[a]);
const corners = (b: Box): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
};

/** Boxes and paths the wrap is meant to enclose. */
function explained(d: Design, cfg: DesignConfig) {
  const boxes: Box[] = [];
  for (const p of d.parts) {
    boxes.push(p.body);
    boxes.push(p.kind === 'gpu' ? (gpuWrapClearance(d, cfg) ?? p.clearance) : p.clearance);
  }
  const conn = connectorBox(d, cfg);
  if (conn) boxes.push(conn);
  return { boxes, paths: routedPaths(d, cfg) };
}

/** Share of the shell's inside (inner wall surface) that is neither part, clearance, hose nor cable. */
function unexplainedShare(d: Design, cfg: DesignConfig) {
  const f = shellField(d, cfg, cfg.prefs.organic);
  const { boxes, paths } = explained(d, cfg);
  const h = 5;
  let inside = 0;
  let extra = 0;
  for (let u = -10; u < d.interior[0] + 10; u += h)
    for (let v = -10; v < d.interior[1] + 10; v += h)
      for (let t = -10; t < d.interior[2] + 10; t += h) {
        const p: Vec3 = [u + h / 2, v + h / 2, t + h / 2];
        if (f(p) > -d.wall) continue;
        inside++;
        if (boxes.some((b) => inBox(p, b)) || paths.some((x) => hoseDistance(x, p) <= 0)) continue;
        // The I/O plate behind the board is part of the rear wall.
        if (p[0] < 20) continue;
        extra++;
      }
  return extra / inside;
}

describe('shrinkwrap shell', () => {
  const base = defaultConfig();
  const slot: DesignConfig = { ...base, prefs: { ...base.prefs, gpuMount: 'slot' } };
  const designs: [Design, DesignConfig][] = [
    ...solve(base, { beamWidth: 12, wrapMetrics: false }).designs.slice(0, 2).map((d) => [d, base] as [Design, DesignConfig]),
    ...solve(slot, { beamWidth: 12, wrapMetrics: false }).designs.slice(0, 2).map((d) => [d, slot] as [Design, DesignConfig]),
  ];

  it('keeps every part body, clearance, hose and cable at least a wall inside, at every smoothness', () => {
    for (const [d, c] of designs) {
      for (const s of [0, 0.5, 1]) {
        const cfg = { ...c, prefs: { ...c.prefs, organic: s } };
        const f = shellField(d, cfg, s);
        const { boxes, paths } = explained(d, cfg);
        for (const b of boxes) for (const q of corners(b)) expect(f(q), `${d.id} box corner s=${s}`).toBeLessThanOrEqual(-d.wall + 0.05);
        for (const h of paths)
          for (const p of h.points) {
            for (const off of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
              const q: Vec3 = [p[0] + off[0] * h.radius, p[1] + off[1] * h.radius, p[2] + off[2] * h.radius];
              expect(f(q), `${d.id} ${h.kind} s=${s}`).toBeLessThanOrEqual(-d.wall + 0.6);
            }
          }
      }
      const fb = shellField(d, withShell(c, 'box'), 0);
      for (const p of d.parts) expect(fb(p.body.min)).toBeLessThan(0);
    }
  });

  it('leaves under 15 % unexplained volume when tight and under 25 % when smooth', () => {
    for (const [d, c] of designs) {
      const tight = unexplainedShare(d, { ...c, prefs: { ...c.prefs, organic: 0 } });
      const smooth = unexplainedShare(d, { ...c, prefs: { ...c.prefs, organic: 1 } });
      console.log(`${d.id}: unexplained ${(tight * 100).toFixed(1)} % tight, ${(smooth * 100).toFixed(1)} % smooth`);
      expect(tight).toBeLessThan(0.15);
      expect(smooth).toBeLessThan(0.25);
    }
  });

  it('meshes a closed shell smaller than the box; smoothness only adds volume', () => {
    const [d, cfg] = designs[0];
    const t0 = performance.now();
    const box = meshShell(d, withShell(cfg, 'box'), 0);
    const tight = meshShell(d, cfg, 0);
    const smooth = meshShell(d, cfg, 1);
    const ms = performance.now() - t0;
    expect(Math.abs(box.volumeMm3 / 1e6 - d.volumeL) / d.volumeL).toBeLessThan(0.04);
    expect(tight.volumeMm3).toBeLessThan(box.volumeMm3);
    expect(smooth.volumeMm3).toBeGreaterThanOrEqual(tight.volumeMm3 * 0.99);
    const m = wrapMetrics(d, cfg, 1);
    expect(m.thickness).toBeLessThanOrEqual(d.thickness + 2 * 6);
    console.log(
      `box ${(box.volumeMm3 / 1e6).toFixed(2)} L; tight ${(tight.volumeMm3 / 1e6).toFixed(2)} L; smooth ${(smooth.volumeMm3 / 1e6).toFixed(2)} L ${m.thickness.toFixed(0)} mm; ${ms.toFixed(0)} ms`,
    );
  });

  it('opens old share links with the Shape slider at 0 as the straight box', async () => {
    const { normalizeConfig } = await import('../src/state/config');
    const old = JSON.parse(JSON.stringify(base));
    delete old.prefs.shell;
    old.prefs.organic = 0;
    expect(normalizeConfig(old).prefs.shell).toBe('box');
    old.prefs.organic = 0.6;
    expect(normalizeConfig(old).prefs.shell).toBe('wrap');
  });
});
