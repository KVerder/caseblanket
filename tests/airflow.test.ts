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

describe('zone network', () => {
  it('conserves mass and energy across chambers', async () => {
    const { solveNetwork, RHO: rho, CP: cp } = await import('../src/solver/airflow');
    const fan = (id: string, source: 'outside' | number, sink: 'outside' | number, heat: number): FanGroupInput => ({
      id,
      label: id,
      heatW: heat,
      fan: FANS.a12x25,
      fanCount: 1,
      source,
      sink,
      losses: [{ label: 'vent', zeta: 3, area: 0.0144 }],
      isRadiator: false,
    });
    const groups = [fan('in0', 'outside', 0, 0), fan('hot', 0, 1, 150), fan('out1', 1, 'outside', 40), fan('psu', 2, 'outside', 60)];
    const zone = (id: string, heatW: number, passive: number) => ({ id, label: id, heatW, passiveArea: passive, passiveZeta: 3, leakArea: 0.0004, components: [] });
    const r = solveNetwork({
      zones: [zone('a', 20, 0.004), zone('b', 30, 0.002), zone('c', 10, 0.003)],
      links: [
        { a: 0, b: 1, area: 3e-4, zeta: 2.5, label: 'a-b' },
        { a: 1, b: 2, area: 2e-4, zeta: 2.5, label: 'b-c' },
      ],
      groups,
      ambientC: 25,
      radEffectiveness: 0.7,
    });
    // Mass: every zone balances; what enters from outside leaves to outside.
    let fromOutside = 0;
    let toOutside = 0;
    let heatOut = 0;
    r.zones.forEach((z) => {
      if (z.passiveFlow > 0) fromOutside += z.passiveFlow;
      else {
        toOutside -= z.passiveFlow;
        heatOut += -z.passiveFlow * rho * cp * z.riseC;
      }
    });
    r.groups.forEach((g) => {
      if (g.source === 'outside' && g.sink !== 'outside') fromOutside += g.flow;
      if (g.sink === 'outside' && g.source !== 'outside') {
        toOutside += g.flow;
        heatOut += g.flow * rho * cp * g.exitRiseC;
      }
    });
    expect(toOutside).toBeCloseTo(fromOutside, 6);
    // Energy: everything released leaves with the air.
    const heatIn = 20 + 30 + 10 + 150 + 40 + 60;
    expect(heatOut).toBeCloseTo(heatIn, 2);
    // Zone c is fed by its own vents and the link from b, so it runs warmer than room but cooler than b.
    expect(r.zones[2].riseC).toBeGreaterThan(0);
  });
});

describe('mixing corrections', () => {
  const base = { internalHeatW: 40, passiveArea: 0.01, passiveZeta: perforatedPlateZeta(0.5), ambientC: 25, targetRiseC: 15, radEffectiveness: 0.7 };
  it('bounds a fanless zone by its stack exchange, better the taller it is', () => {
    const still = solveFlow({ ...base, groups: [] });
    const short = solveFlow({ ...base, groups: [], heightM: 0.1 });
    const tall = solveFlow({ ...base, groups: [], heightM: 0.4 });
    // Without buoyancy only the seam trickle carries the heat away.
    expect(still.zones[0].riseC).toBeGreaterThan(30);
    expect(short.zones[0].riseC).toBeLessThan(still.zones[0].riseC);
    expect(tall.zones[0].riseC).toBeLessThan(short.zones[0].riseC);
    // Stack balance: the exchange carries the heat at the rise it sets (Q·ρ·cp·ΔT = P).
    const dT = tall.zones[0].riseC;
    const q = (0.01 / 2) * Math.sqrt((RHO * 9.81 * 0.2 * (dT / 298.15)) / (RHO * perforatedPlateZeta(0.5)));
    expect(q * RHO * CP * dT).toBeGreaterThan(40 * 0.5);
  });
  it('lets an internal fan re-ingest its own exhaust', () => {
    const g: FanGroupInput = { id: 'cpu', label: 'CPU', heatW: 100, fan: FANS.a12x25, fanCount: 1, source: 'case', sink: 'case', losses: [{ label: 'fins', zeta: 2, area: 0.0144 }], isRadiator: false };
    const mixed = solveFlow({ ...base, groups: [g] });
    const recirc = solveFlow({ ...base, groups: [g], internalRecirculation: 0.5 });
    const a = mixed.groups[0];
    const b = recirc.groups[0];
    expect(b.inletRiseC - a.inletRiseC).toBeCloseTo(b.deltaC, 6); // r/(1−r) = 1 at r = 0.5
    expect(recirc.zones[0].riseC).toBeCloseTo(mixed.zones[0].riseC, 9); // the zone's heat balance is unchanged
  });
});
