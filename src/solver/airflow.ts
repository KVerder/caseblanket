import type { FanSpec } from '../model/types';

/**
 * One-zone case airflow network.
 *
 * Each fan group has a linear fan curve P = Pmax·(1 − Q/Qmax) working against
 * quadratic losses Σ ζ·½ρ(Q/A)². Groups that push into the case feel the case
 * pressure as back-pressure; groups that pull from it are helped by it.
 * Passive vents close the mass balance; the case pressure is solved by
 * bisection. Air temperature rise across any heat source is ΔT = P / (ρ·cp·Q).
 *
 * This is a first-order engineering estimate for ranking layouts, not CFD.
 */

export const RHO = 1.2; // kg/m³, air near 20 °C at sea level
export const CP = 1005; // J/(kg·K)
export const MMH2O_TO_PA = 9.80665;
export const M3S_TO_CFM = 2118.88;

export type Endpoint = 'outside' | 'case';

export interface LossTerm {
  label: string;
  zeta: number;
  /** Reference area in m² for the velocity head. */
  area: number;
}

export interface FanGroupInput {
  id: string;
  label: string;
  heatW: number;
  fan: FanSpec;
  fanCount: number;
  source: Endpoint;
  sink: Endpoint;
  losses: LossTerm[];
  /** Radiators get a coolant estimate. */
  isRadiator: boolean;
}

export interface FlowInput {
  groups: FanGroupInput[];
  /** Heat released straight into case air (board, extras, …). */
  internalHeatW: number;
  /** Gross passive vent area, m², with its loss coefficient. */
  passiveArea: number;
  passiveZeta: number;
  ambientC: number;
  targetRiseC: number;
  radEffectiveness: number;
}

export interface GroupResult {
  id: string;
  label: string;
  heatW: number;
  flow: number; // m³/s
  cfm: number;
  source: Endpoint;
  sink: Endpoint;
  inletRiseC: number;
  deltaC: number;
  exitRiseC: number;
  adequacy: number;
  coolantRiseC?: number;
  pressurePa: number;
}

export interface FlowResult {
  groups: GroupResult[];
  casePressurePa: number;
  caseThroughFlow: number;
  caseRiseC: number;
  caseAdequacy: number;
  passiveFlow: number;
  /** 0…1, heat-weighted; 0.5 means every path gets exactly the airflow it needs. */
  score: number;
  worstAdequacy: number;
}

/** Idelchik's thin perforated plate: ζ = (0.707·(1−φ)^0.375 + 1 − φ)² / φ², on the approach velocity. */
export function perforatedPlateZeta(openRatio: number): number {
  const f = Math.min(0.95, Math.max(0.05, openRatio));
  return (0.707 * Math.pow(1 - f, 0.375) + 1 - f) ** 2 / (f * f);
}

export function fanCurve(fan: FanSpec, count: number) {
  return {
    qmax: (fan.maxAirflowM3h / 3600) * count,
    pmax: fan.maxPressureMmH2O * MMH2O_TO_PA,
  };
}

/** Operating airflow for a fan (group) against Σζ losses plus a constant pressure offset p0. */
export function operatingFlow(fan: FanSpec, count: number, losses: LossTerm[], p0: number): number {
  const { qmax, pmax } = fanCurve(fan, count);
  let a = 0;
  for (const l of losses) if (l.area > 0) a += (l.zeta * 0.5 * RHO) / (l.area * l.area);
  const b = pmax / qmax;
  const c = p0 - pmax;
  if (c >= 0) return 0;
  if (a < 1e-12) return Math.max(0, -c / b);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function groupOffset(g: FanGroupInput, pc: number): number {
  return (g.sink === 'case' ? pc : 0) - (g.source === 'case' ? pc : 0);
}

export function solveFlow(input: FlowInput): FlowResult {
  const { groups } = input;
  const leakArea = 0.001; // ~10 cm² of panel seams, always present
  const pArea = input.passiveArea + leakArea;
  const pZeta = (input.passiveArea * input.passiveZeta + leakArea * 2.5) / pArea;

  const balance = (pc: number) => {
    let net = 0;
    for (const g of groups) {
      if (g.source === g.sink) continue;
      const q = operatingFlow(g.fan, g.fanCount, g.losses, groupOffset(g, pc));
      net += g.source === 'outside' ? q : -q;
    }
    const passiveOut = Math.sign(pc) * pArea * Math.sqrt((2 * Math.abs(pc)) / (RHO * pZeta));
    return net - passiveOut;
  };

  let lo = -200;
  let hi = 200;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (balance(mid) > 0) lo = mid;
    else hi = mid;
  }
  const pc = (lo + hi) / 2;
  const passiveFlow = Math.sign(pc) * pArea * Math.sqrt((2 * Math.abs(pc)) / (RHO * pZeta));

  const flows = groups.map((g) => operatingFlow(g.fan, g.fanCount, g.losses, groupOffset(g, pc)));
  let intake = 0;
  let caseHeat = input.internalHeatW;
  groups.forEach((g, i) => {
    if (g.source === 'outside' && g.sink === 'case') intake += flows[i];
    if (g.sink === 'case') caseHeat += g.heatW;
  });
  const through = intake + Math.max(0, -passiveFlow);
  // Without forced through-flow, allow a trickle of natural convection (~1 CFM).
  const effThrough = Math.max(through, 0.0005);
  const caseRise = caseHeat / (RHO * CP * effThrough);

  const target = input.targetRiseC;
  const results: GroupResult[] = groups.map((g, i) => {
    const q = flows[i];
    const inletRise = g.source === 'case' ? caseRise : 0;
    const delta = q > 1e-6 ? g.heatW / (RHO * CP * q) : g.heatW > 0 ? 999 : 0;
    const exitRise = inletRise + delta;
    const adequacy = g.heatW <= 0 ? 2 : target / Math.max(exitRise, 1e-6);
    return {
      id: g.id,
      label: g.label,
      heatW: g.heatW,
      flow: q,
      cfm: q * M3S_TO_CFM,
      source: g.source,
      sink: g.sink,
      inletRiseC: inletRise,
      deltaC: delta,
      exitRiseC: exitRise,
      adequacy,
      coolantRiseC: g.isRadiator ? inletRise + delta / Math.max(0.05, input.radEffectiveness) : undefined,
      pressurePa: fanCurve(g.fan, g.fanCount).pmax * (1 - q / fanCurve(g.fan, g.fanCount).qmax),
    };
  });

  const caseAdequacy = caseHeat <= 0 ? 2 : target / Math.max(caseRise, 1e-6);
  // Diminishing returns: a = 1 (exactly enough) scores 0.5, a = 3 scores 0.75.
  const s = (a: number) => a / (a + 1);
  let wsum = 0;
  let acc = 0;
  let worst = caseAdequacy;
  for (const r of results) {
    if (r.heatW <= 0) continue;
    wsum += r.heatW;
    acc += r.heatW * s(r.adequacy);
    worst = Math.min(worst, r.adequacy);
  }
  const caseWeight = Math.max(30, input.internalHeatW);
  wsum += caseWeight;
  acc += caseWeight * s(caseAdequacy);

  return {
    groups: results,
    casePressurePa: pc,
    caseThroughFlow: through,
    caseRiseC: caseRise,
    caseAdequacy,
    passiveFlow,
    score: wsum > 0 ? acc / wsum : 1,
    worstAdequacy: worst,
  };
}
