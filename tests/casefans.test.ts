import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { buildScene } from '../src/cfd/scene';
import { mountPlan } from '../src/print/mounts';
import { normalizeConfig } from '../src/state/config';
import type { DesignConfig } from '../src/model/types';

const withFans = (count: number, direction: DesignConfig['parts']['caseFans']['direction'] = 'auto') => {
  const cfg = defaultConfig();
  cfg.parts.caseFans.count = count;
  cfg.parts.caseFans.direction = direction;
  return { cfg, d: solve(cfg, { wrapMetrics: false }).designs[0] };
};

describe('case fans', () => {
  it('none by default, and older saves without the setting get none', () => {
    expect(defaultConfig().parts.caseFans.count).toBe(0);
    const old = JSON.parse(JSON.stringify(defaultConfig()));
    delete old.parts.caseFans;
    expect(normalizeConfig(old).parts.caseFans.count).toBe(0);
    expect(solve(defaultConfig(), { wrapMetrics: false }).designs[0].parts.some((p) => p.kind === 'case-fan')).toBe(false);
  });

  it('two fans: each on a vented panel, with its own vent, airflow group, direction and screw holes', () => {
    const { cfg, d } = withFans(2);
    const fans = d.parts.filter((p) => p.kind === 'case-fan');
    expect(fans.map((p) => p.id)).toEqual(['fan-1', 'fan-2']);
    for (const f of fans) {
      expect(f.faceAtWall).toBe(true);
      expect(f.size[0]).toBe(120);
      expect(d.vents.some((v) => v.groupId === f.id && v.kind === 'fan' && v.wall === f.face)).toBe(true);
      const g = d.flow.groups.find((x) => x.id === f.id)!;
      expect(g.flow).toBeGreaterThan(0);
      expect(['in', 'out']).toContain(f.airflow);
      expect(g.source === 'outside').toBe(f.airflow === 'in');
    }
    expect(d.checks.filter((c) => c.level === 'error')).toEqual([]);
    const plan = mountPlan(d, cfg);
    expect(plan.holes.filter((h) => h.label.startsWith('Case fan'))).toHaveLength(8);
    expect(plan.hardware.filter((h) => h.item.startsWith('Case-fan screw')).reduce((s, h) => s + h.qty, 0)).toBe(8);
  });

  it('a fixed direction is kept, and the 3D simulation blows the same way', () => {
    const { cfg, d } = withFans(1, 'exhaust');
    const f = d.parts.find((p) => p.kind === 'case-fan')!;
    expect(f.airflow).toBe('out');
    const disk = buildScene(d, cfg, undefined, { cells: 20000 }).fans.find((x) => x.group === f.id)!;
    expect(disk).toBeDefined();
    // Exhaust: toward the fan's own panel.
    expect(disk.sign).toBe(f.face! % 2 === 0 ? 1 : -1);
  });
});
