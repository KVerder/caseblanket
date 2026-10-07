import { describe, expect, it } from 'vitest';
import { FANS, defaultConfig } from '../src/model/presets';
import { CP, POCKET_EXCHANGE, RHO, flowNetwork, pocketRise, solveNetwork, type FanGroupInput } from '../src/solver/airflow';
import { jetDecay } from '../src/solver/jets';
import { solve } from '../src/solver/solve';

const fanGroup = (id: string, source: FanGroupInput['source'], sink: FanGroupInput['sink'], heatW: number): FanGroupInput => ({
  id,
  label: id,
  heatW,
  fan: FANS.generic120,
  fanCount: 1,
  source,
  sink,
  losses: [{ label: 'vent', zeta: 3, area: 0.0144 }],
  isRadiator: false,
});

describe('jets and pockets', () => {
  it('a jet keeps its excess for about a diameter, then fades, and is mixed in past 6 diameters', () => {
    expect(jetDecay(0.5)).toBe(1);
    expect(jetDecay(2)).toBeCloseTo(0.5, 9);
    expect(jetDecay(7)).toBe(0);
  });

  it('a pocket nothing blows on keeps its heat; a cool jet sweeping it brings it down', () => {
    const still = pocketRise(5, 25, []);
    expect(still).toBeCloseTo(5 + 25 / (RHO * CP * POCKET_EXCHANGE), 6);
    expect(pocketRise(5, 25, [{ q: 0.02, rise: 1 }])).toBeLessThan(still);
  });

  it('an intake jet caught by an exhaust fan short-circuits: the case air runs warmer', () => {
    const base = {
      groups: [fanGroup('in', 'outside', 'case', 0), fanGroup('out', 'case', 'outside', 0)],
      internalHeatW: 60,
      passiveArea: 0.002,
      passiveZeta: 3,
      ambientC: 25,
      targetRiseC: 15,
      radEffectiveness: 0.7,
    };
    const mixed = solveNetwork(flowNetwork(base));
    const short = solveNetwork(flowNetwork({ ...base, jets: [{ from: 'in', toGroup: 'out', share: 0.6 }] }));
    expect(short.caseRiseC).toBeGreaterThan(mixed.caseRiseC + 0.5);
    // The exhaust fan breathes the cool jet, not the case air.
    expect(short.groups.find((g) => g.id === 'out')!.inletRiseC).toBeLessThan(short.caseRiseC);
  });

  it('the solver traces where the default downdraft cooler blows: onto the board, which it sweeps', () => {
    const d = solve(defaultConfig(), { wrapMetrics: false }).designs[0];
    expect(d.recipe.net.jets?.some((j) => j.from === 'cpu' && j.toComp === 'case-air')).toBe(true);
    const board = d.flow.components.find((c) => c.id === 'case-air')!;
    // Rated on the pocket over the board, above the mixed case air.
    expect(board.tempC - 25).toBeGreaterThan(d.flow.caseRiseC);
  }, 120000);
});
