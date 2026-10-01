import { describe, expect, it } from 'vitest';
import { FANS } from '../src/model/presets';
import { CP, operatingFlow, perforatedPlateZeta, RHO, solveFlow, type FanGroupInput } from '../src/solver/airflow';

describe('airflow model', () => {
  it('gives free-air flow with no losses and stalls at max pressure', () => {
    const q = operatingFlow(FANS.a12x25, 1, [], 0);
    expect(q).toBeCloseTo(102.1 / 3600, 6);
    expect(operatingFlow(FANS.a12x25, 1, [], 2.34 * 9.80665 + 1)).toBe(0);
  });

  it('loses airflow to restriction, and more fans move more air', () => {
    const losses = [{ label: 'rad', zeta: 13, area: 0.12 * 0.27 }];
    const one = operatingFlow(FANS.a12x25, 1, losses, 0);
    const two = operatingFlow(FANS.a12x25, 2, losses, 0);
    expect(one).toBeLessThan(102.1 / 3600);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(2 * one);
  });

  it('matches the perforated plate coefficient at typical open ratios', () => {
    expect(perforatedPlateZeta(0.5)).toBeCloseTo(4.37, 1);
    expect(perforatedPlateZeta(0.7)).toBeLessThan(perforatedPlateZeta(0.5));
  });

  it('balances intake and exhaust through the case with passive vents', () => {
    const g = (id: string, source: 'outside' | 'case', sink: 'outside' | 'case', heat: number): FanGroupInput => ({
      id,
      label: id,
      heatW: heat,
      fan: FANS.a12x25,
      fanCount: 1,
      source,
      sink,
      losses: [{ label: 'vent', zeta: 2, area: 0.0144 }],
      isRadiator: false,
    });
    const r = solveFlow({
      groups: [g('in', 'outside', 'case', 100), g('out', 'case', 'outside', 0)],
      internalHeatW: 20,
      passiveArea: 0.01,
      passiveZeta: 2,
      ambientC: 25,
      targetRiseC: 10,
      radEffectiveness: 0.7,
    });
    const qIn = r.groups[0].flow;
    const qOut = r.groups[1].flow;
    // mass balance: intake = exhaust + passive outflow
    expect(qIn - qOut - r.passiveFlow).toBeCloseTo(0, 5);
    // case rise follows ΔT = P / (ρ cp Q)
    expect(r.caseRiseC).toBeCloseTo(120 / (RHO * CP * r.caseThroughFlow), 3);
    // the exhaust fan sees case air, so its outlet is at least the case rise
    expect(r.groups[1].exitRiseC).toBeCloseTo(r.caseRiseC, 6);
  });
});

describe('component temperatures', () => {
  it('rates each component against its own limit, with its own internal rise', async () => {
    const { solveNetwork } = await import('../src/solver/airflow');
    const r = solveNetwork({
      zones: [{ id: 'case', label: 'Case', heatW: 0, passiveArea: 0.01, passiveZeta: 2, leakArea: 0.001, components: [] }],
      links: [],
      groups: [
        {
          id: 'rad',
          label: 'Radiator',
          heatW: 300,
          fan: FANS.a12x25,
          fanCount: 3,
          source: 'outside',
          sink: 'outside',
          losses: [{ label: 'core', zeta: 13, area: 0.12 * 0.36 }],
          isRadiator: true,
          component: { id: 'gpu', label: 'GPU core', limitC: 83, selfRiseK: 300 * 0.06, air: 'coolant', heatW: 300 },
        },
      ],
      ambientC: 25,
      radEffectiveness: 0.7,
    });
    const g = r.groups[0];
    const c = r.components[0];
    // coolant = air rise / effectiveness; part = room + coolant + P·R
    expect(c.tempC).toBeCloseTo(25 + g.deltaC / 0.7 + 18, 6);
    expect(c.headroomK).toBeCloseTo(83 - c.tempC, 6);
    expect(c.margin).toBeCloseTo((83 - c.tempC) / (83 - 25), 6);
    expect(r.worstComponent).toBe('GPU core');
  });
});
