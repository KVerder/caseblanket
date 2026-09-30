import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';

describe('solver smoke', () => {
  it('produces designs for the default build', () => {
    const cfg = defaultConfig();
    const r = solve(cfg);
    console.log('ms', r.stats.ms.toFixed(0), 'runs', r.stats.runs, 'evaluated', r.stats.evaluated);
    for (const d of r.designs) {
      console.log(
        d.effectiveTopology.padEnd(13), d.profile.id.padEnd(14), d.tags.join(",").padEnd(30),
        `${d.world.width.toFixed(0)}x${d.world.height.toFixed(0)}x${d.world.depth.toFixed(0)}`,
        `t=${d.thickness.toFixed(0)} V=${d.volumeL.toFixed(2)}L air=${d.flow.score.toFixed(2)} worst=${d.flow.worstAdequacy.toFixed(2)} cost=${d.cost.toFixed(3)} inv=${d.invalid}`,
        d.checks.filter(c=>c.level!=='ok').map(c=>c.text).join(' / '),
      );
    }
    expect(r.designs.length).toBeGreaterThan(0);
  });
});
