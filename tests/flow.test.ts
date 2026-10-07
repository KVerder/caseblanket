import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { perforatedPlateZeta } from '../src/solver/airflow';
import { ALL_FLOW, applyFlow, bellMouthZeta, coneRecovery, entryZeta, NO_FLOW, plateTau, plateZeta, roundedPlateZeta, ventZeta } from '../src/solver/flow';
import { hydraulicDiameter, PERFORATIONS } from '../src/model/perforation';
import { buildScene, ductCandidates, flipCandidates, louvreCandidates } from '../src/cfd/scene';
import { DEFAULT_PRINT, printPieces } from '../src/print/printable';
import type { DesignConfig } from '../src/model/types';
import { buildItems, PROFILES } from '../src/solver/items';

const withFlow = (flow: DesignConfig['prefs']['flow'], f?: (c: DesignConfig) => void) => {
  const cfg = defaultConfig();
  cfg.prefs.flow = flow;
  f?.(cfg);
  return { cfg, d: solve(cfg, { wrapMetrics: false }).designs[0] };
};

describe('flow structures', () => {
  it('coefficients: rounded holes lose less than sharp ones, bell-mouths less than a sharp entry, cones recover pressure', () => {
    for (const phi of [0.4, 0.51, 0.69]) {
      expect(roundedPlateZeta(phi, 0.15)).toBeLessThan(perforatedPlateZeta(phi) * 0.5);
      expect(Math.abs(roundedPlateZeta(phi, 0) / perforatedPlateZeta(phi) - 1)).toBeLessThan(0.03);
    }
    expect(bellMouthZeta(0)).toBe(0.5);
    for (let x = 0; x < 0.15; x += 0.01) expect(bellMouthZeta(x + 0.01)).toBeLessThanOrEqual(bellMouthZeta(x));
    expect(coneRecovery(1)).toBe(0);
    expect(coneRecovery(1.5)).toBeGreaterThan(0.3);
  });

  it('vent panels: Idelchik thick-plate and rounded-hole limits, chamfers help, thicker plates lose less', () => {
    // Thin, sharp: the thick-plate form gives back the thin-plate formula within 3 %.
    for (const phi of [0.3, 0.4, 0.51, 0.69, 0.8]) expect(Math.abs(plateZeta(phi, 0) / perforatedPlateZeta(phi) - 1)).toBeLessThan(0.03);
    // Fully rounded: Idelchik's rounded-hole formula, (0.03·(1−φ)^0.75 + (1−φ)²)/φ² (λ·l/d aside).
    const phi = 0.5;
    expect(plateZeta(phi, 0, 0.2)).toBeCloseTo((0.03 * 0.5 ** 0.75 + 0.25) / 0.25, 6);
    expect(entryZeta(0)).toBe(0.5);
    expect(entryZeta(0.05)).toBeCloseTo(0.22, 9);
    expect(plateTau(0)).toBe(1.35);
    for (let x = 0; x < 2; x += 0.1) expect(plateTau(x + 0.1)).toBeLessThanOrEqual(plateTau(x));
    for (const p of Object.values(PERFORATIONS)) {
      const d = hydraulicDiameter(p);
      expect(d).toBeGreaterThan(2);
      expect(d).toBeLessThanOrEqual(p.size + 1e-9 + (p.kind === 'slots' ? p.size : 0));
      expect(ventZeta(0.5, p, 2.4, false)).toBeLessThan(perforatedPlateZeta(0.5));
      expect(ventZeta(0.5, p, 2.4, true)).toBeLessThan(ventZeta(0.5, p, 2.4, false));
      expect(ventZeta(0.5, p, 4, false)).toBeLessThan(ventZeta(0.5, p, 2.4, false));
    }
  });

  it('bell-mouths win back at most the proximity loss the network charged', () => {
    const { d } = withFlow(NO_FLOW);
    const r = d.recipe;
    const on = applyFlow(r.net, { ...NO_FLOW, bellMouths: true }, r.flowFans, r.openRatio, r.holeD);
    for (const g of on.groups) {
      const bell = g.losses.find((l) => l.label === 'bell-mouth');
      if (!bell) continue;
      const prox = g.losses.find((l) => l.label === 'fan proximity')!;
      expect(-bell.zeta * (prox.area / bell.area) ** 2).toBeLessThanOrEqual(prox.zeta + 1e-9);
    }
  });

  it('applied to the network: vent losses fall with rounded holes, proximity goes with a duct, never below half the resistance', () => {
    const { d } = withFlow(NO_FLOW);
    const r = d.recipe;
    const on = applyFlow(r.net, ALL_FLOW, r.flowFans, r.openRatio, r.holeD);
    const res = (ls: { zeta: number; area: number }[]) => ls.reduce((s, l) => s + (l.area > 0 ? l.zeta / (l.area * l.area) : 0), 0);
    for (const g of r.net.groups) {
      const g2 = on.groups.find((x) => x.id === g.id)!;
      expect(res(g2.losses)).toBeGreaterThanOrEqual(0.5 * res(g.losses) - 1e-9);
      for (const l of g.losses.filter((l) => l.label === 'vent')) expect(g2.losses.find((m) => m.label === 'vent')!.zeta).toBeLessThan(l.zeta);
      const f = r.flowFans.find((x) => x.id === g.id);
      if (f?.ductable) expect(g2.losses.find((m) => m.label === 'fan proximity')?.zeta ?? 0).toBe(0);
    }
    for (const [i, z] of r.net.zones.entries()) expect(on.zones[i].passiveZeta).toBeLessThan(z.passiveZeta);
  });

  it('every structure on keeps or improves the tightest part, and deeper plenums take real space', () => {
    const off = withFlow(NO_FLOW, (c) => (c.parts.caseFans.count = 1));
    const on = withFlow(ALL_FLOW, (c) => (c.parts.caseFans.count = 1));
    expect(on.d.flow.worstMargin).toBeGreaterThanOrEqual(off.d.flow.worstMargin - 0.01);
    // The same packing item with and without: 20 mm more behind the fan, in the layout itself.
    const behind = (cfg: DesignConfig) => {
      const it = buildItems({ cfg, topology: 'flat', profile: PROFILES[0] }).find((x) => x.kind === 'case-fan')!;
      const v = it.variants.find((x) => !x.parts[0].tilt)!.parts[0];
      return Math.max(...v.o.ext.map((e, a) => e - v.o.body[a]));
    };
    expect(behind(on.cfg) - behind(off.cfg)).toBeCloseTo(20, 6);
  }, 120000);

  it('the 3D simulation gets the ducts and deflectors', () => {
    const { cfg, d } = withFlow({ ...NO_FLOW, ducts: true, deflectors: true });
    const plain = buildScene(d, { ...cfg, prefs: { ...cfg.prefs, flow: NO_FLOW } }, undefined, { cells: 15000 });
    const shaped = buildScene(d, cfg, undefined, { cells: 15000 });
    if (louvreCandidates(d).length) expect(shaped.louvres.length).toBeGreaterThan(plain.louvres.length);
    if (ductCandidates(d).length) {
      const solid = (s: typeof plain) => s.cellType.reduce((n, t) => n + t, 0);
      expect(solid(shaped)).toBeGreaterThan(solid(plain));
    }
  }, 60000);

  it('prints with every structure on and no loose fragments', () => {
    const { cfg, d } = withFlow(ALL_FLOW);
    const pieces = printPieces(d, cfg, DEFAULT_PRINT);
    expect(pieces.reduce((s, p) => s + (p.dropped ?? 0), 0)).toBe(0);
  }, 300000);
});

describe('reversing a through-flow radiator', () => {
  it('is offered to the optimiser and turns its fans round in the 3D scene', () => {
    const cfg = defaultConfig();
    cfg.prefs.orientation = 'console';
    const d = solve(cfg, { wrapMetrics: false }).designs.find((x) => x.parts.some((p) => p.kind.startsWith('rad') && p.mode === 'through'));
    if (!d) return;
    const rad = d.parts.find((p) => p.kind.startsWith('rad') && p.mode === 'through')!;
    expect(flipCandidates(d)).toContain(rad.id);
    const signs = (flipped: string[]) => buildScene(d, cfg, { louvres: [], ducts: [], flipped }, { cells: 12000 }).fans.filter((f) => f.group === rad.id).map((f) => f.sign);
    const a = signs([]);
    const b = signs([rad.id]);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a.map((s) => -s));
  }, 60000);
});
