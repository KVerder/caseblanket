import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { buildScene, vaneBox, vaneCandidates, VANE_ANGLE } from '../src/cfd/scene';
import { axisOf, signOf } from '../src/solver/geometry';
import { solve } from '../src/solver/solve';

describe('turning vanes under intake case fans (3D trial structure)', () => {
  const cfg = defaultConfig();
  cfg.prefs.orientation = 'console';
  cfg.parts.caseFans = { ...cfg.parts.caseFans, count: 2 };
  const design = solve(cfg, { beamWidth: 8, wrapMetrics: false }).designs[0];

  it('offers vanes only on intake case fans, turning toward the board, in free air', () => {
    const vc = vaneCandidates(design);
    expect(vc.length).toBeGreaterThan(0);
    const board = design.parts.find((p) => p.kind === 'board')!;
    for (const v of vc) {
      const fan = design.parts.find((p) => p.id === v.part)!;
      expect(fan.kind).toBe('case-fan');
      expect(fan.airflow).toBe('in');
      expect(axisOf(v.toward)).not.toBe(axisOf(fan.face!));
      // Pointing from the fan toward the board's centre.
      const a = axisOf(v.toward);
      const toBoard = (board.body.min[a] + board.body.max[a]) / 2 - (fan.body.min[a] + fan.body.max[a]) / 2;
      expect(Math.sign(toBoard)).toBe(signOf(v.toward));
      const vb = vaneBox(fan);
      for (const q of design.parts)
        if (q !== fan) expect([0, 1, 2].every((k) => q.body.min[k] < vb.max[k] - 1 && q.body.max[k] > vb.min[k] + 1)).toBe(false);
    }
  });

  it('builds a vane cascade turning the jet VANE_ANGLE off the fan axis', () => {
    const vc = vaneCandidates(design);
    if (!vc.length) return;
    const plain = buildScene(design, cfg, undefined, { cell: 12 });
    const vaned = buildScene(design, cfg, { louvres: [], ducts: [], flipped: [], vanes: vc }, { cell: 12 });
    expect(vaned.louvres.length).toBe(plain.louvres.length + vc.length);
    for (const l of vaned.louvres.slice(plain.louvres.length)) {
      expect(l.cells.length).toBeGreaterThan(4);
      const cos = l.dir[0] * l.normal[0] + l.dir[1] * l.normal[1] + l.dir[2] * l.normal[2];
      expect(cos).toBeCloseTo(Math.cos(VANE_ANGLE), 5);
    }
  });
});
