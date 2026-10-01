import type { FanSpec } from '../model/types';

/**
 * Zone-network case airflow model.
 *
 * The case is one or more air zones (chambers), each with its own pressure and air temperature.
 * Fan groups move air between the outside and a zone, or between zones, along a linear fan curve
 * P = Pmax·(1 − Q/Qmax) against quadratic losses Σ ζ·½ρ(Q/A)². Each zone breathes through its
 * own passive vents and seam leaks; zones exchange air through openings in the partitions
 * between them (cable and hose pass-throughs, joint gaps). Zone pressures come from mass balance
 * (Newton on the zone pressures), zone temperatures from energy balance (a linear system):
 * every inflow carries its temperature, every outflow leaves at the zone temperature.
 *
 * Each heat source is rated as a component against its own temperature limit:
 *   T = room + (air rise where the component sits) + its own internal rise (power × resistance)
 * where "air rise" is the mean air temperature across its fins, its coolant temperature, the
 * air entering it, the air leaving it, or its zone's air, depending on the component.
 *
 * A first-order engineering estimate for ranking layouts, not CFD.
 */

export const RHO = 1.2; // kg/m³, air near 20 °C at sea level
export const CP = 1005; // J/(kg·K)
export const MMH2O_TO_PA = 9.80665;
export const M3S_TO_CFM = 2118.88;

/** 'case' is zone 0; a number is a zone index. */
export type Endpoint = 'outside' | 'case' | number;

export interface LossTerm {
  label: string;
  zeta: number;
  /** Reference area in m² for the velocity head. */
  area: number;
}

/** How a component's temperature follows the air around it. */
export type AirTerm = 'mean' | 'coolant' | 'inlet' | 'exit' | 'zone';

export interface ComponentSpec {
  id: string;
  label: string;
  limitC: number;
  /** Rise from the air (or coolant) to the component itself: power × thermal resistance, K. */
  selfRiseK: number;
  air: AirTerm;
  /** Heat used to weight the score. */
  heatW: number;
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
  /** The component this heat path cools. */
  component?: ComponentSpec;
}

export interface ZoneInput {
  id: string;
  label: string;
  /** Heat released straight into this zone's air (board, drives, …). */
  heatW: number;
  /** Passive vent area to the outside, m², with its loss coefficient. */
  passiveArea: number;
  passiveZeta: number;
  /** Seam leakage to the outside, m². */
  leakArea: number;
  /** Components rated against this zone's air temperature. */
  components: ComponentSpec[];
}

export interface LinkInput {
  a: number;
  b: number;
  area: number;
  zeta: number;
  label: string;
}

export interface NetworkInput {
  zones: ZoneInput[];
  links: LinkInput[];
  groups: FanGroupInput[];
  ambientC: number;
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
  /** Adequacy of the component this group cools (2 when it cools nothing). */
  adequacy: number;
  coolantRiseC?: number;
  pressurePa: number;
}

export interface ZoneResult {
  id: string;
  label: string;
  pressurePa: number;
  riseC: number;
  /** Air entering the zone from the outside and other zones, m³/s. */
  throughFlow: number;
  passiveFlow: number;
  heatW: number;
}

export interface ComponentResult {
  id: string;
  label: string;
  tempC: number;
  limitC: number;
  headroomK: number;
  /** Share of the component's budget (limit − room) still unused: 1 = at room temperature, 0 = at its limit. */
  margin: number;
  adequacy: number;
  heatW: number;
  /** Group or zone whose air sets the temperature. */
  via: string;
  /** How the temperature follows the air, and the component's own rise above it, K. */
  air: AirTerm;
  selfRiseK: number;
}

export interface FlowResult {
  groups: GroupResult[];
  zones: ZoneResult[];
  links: { label: string; flow: number }[];
  components: ComponentResult[];
  /** Zone 0, kept for single-chamber callers. */
  casePressurePa: number;
  caseThroughFlow: number;
  caseRiseC: number;
  caseAdequacy: number;
  passiveFlow: number;
  /** 0…1, heat-weighted; 0.5 means every component sits exactly at its limit. */
  score: number;
  worstAdequacy: number;
  /** The component with the smallest share of its budget left: that share, its margin in K, its name. */
  worstMargin: number;
  worstHeadroomK: number;
  worstComponent: string;
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

export const zoneOf = (e: Endpoint): number => (e === 'outside' ? -1 : e === 'case' ? 0 : e);

/** Signed flow through an orifice from pressure pa to pb. */
function orifice(area: number, zeta: number, pa: number, pb: number): number {
  if (area <= 0) return 0;
  const dp = pa - pb;
  return Math.sign(dp) * area * Math.sqrt((2 * Math.abs(dp)) / (RHO * Math.max(zeta, 1e-3)));
}

/** Natural convection through the seams when nothing else moves air (~1 CFM per zone). */
const TRICKLE = 0.0005;

export function solveNetwork(input: NetworkInput): FlowResult {
  const { zones, links, groups } = input;
  const K = zones.length;
  const pz = (p: number[], e: Endpoint) => (zoneOf(e) < 0 ? 0 : p[zoneOf(e)]);
  const passiveArea = (z: ZoneInput) => z.passiveArea + z.leakArea;
  const passiveZeta = (z: ZoneInput) => (z.passiveArea * z.passiveZeta + z.leakArea * 2.5) / Math.max(1e-9, passiveArea(z));

  const groupFlows = (p: number[]) => groups.map((g) => operatingFlow(g.fan, g.fanCount, g.losses, pz(p, g.sink) - pz(p, g.source)));
  /** Net volume inflow into every zone. */
  const residual = (p: number[]) => {
    const r = new Array(K).fill(0);
    const q = groupFlows(p);
    groups.forEach((g, i) => {
      const s = zoneOf(g.source);
      const t = zoneOf(g.sink);
      if (s === t) return;
      if (s >= 0) r[s] -= q[i];
      if (t >= 0) r[t] += q[i];
    });
    zones.forEach((z, k) => (r[k] += orifice(passiveArea(z), passiveZeta(z), 0, p[k])));
    for (const l of links) {
      const f = orifice(l.area, l.zeta, p[l.a], p[l.b]);
      r[l.a] -= f;
      r[l.b] += f;
    }
    return r;
  };

  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  let p = new Array(K).fill(0);
  if (K === 1) {
    p = [bisect((x) => residual([x])[0])];
  } else {
    // Newton on the zone pressures with a numerical Jacobian and step halving.
    let r = residual(p);
    for (let it = 0; it < 80 && norm(r) > 1e-10; it++) {
      const J: number[][] = [];
      for (let j = 0; j < K; j++) {
        const h = Math.max(1e-4, Math.abs(p[j]) * 1e-5);
        const pp = p.slice();
        pp[j] += h;
        const rr = residual(pp);
        for (let i = 0; i < K; i++) (J[i] ??= [])[j] = (rr[i] - r[i]) / h;
      }
      const step = solveLinear(J, r.map((x) => -x));
      if (!step) break;
      let t = 1;
      let accepted = false;
      for (let k = 0; k < 40; k++) {
        const pn = p.map((x, i) => Math.max(-500, Math.min(500, x + t * step[i])));
        const rn = residual(pn);
        if (norm(rn) < norm(r)) {
          p = pn;
          r = rn;
          accepted = true;
          break;
        }
        t /= 2;
      }
      if (!accepted) break;
    }
  }

  const q = groupFlows(p);
  const passive = zones.map((z, k) => orifice(passiveArea(z), passiveZeta(z), 0, p[k]));
  const linkFlows = links.map((l) => orifice(l.area, l.zeta, p[l.a], p[l.b]));

  // Energy balance in rises above room temperature: Σ inflow·T_in + heat/(ρ cp) = (Σ inflow)·T_k.
  // A group's air arrives at its source temperature plus heat / (ρ cp Q).
  const A: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
  const b = new Array(K).fill(0);
  const inflow = new Array(K).fill(0);
  const add = (k: number, m: number, src: number, extra: number) => {
    inflow[k] += m;
    A[k][k] += m;
    if (src >= 0) A[k][src] -= m;
    b[k] += m * extra;
  };
  zones.forEach((z, k) => {
    b[k] += z.heatW / (RHO * CP);
    if (passive[k] > 0) add(k, passive[k], -1, 0);
  });
  groups.forEach((g, i) => {
    const s = zoneOf(g.source);
    const t = zoneOf(g.sink);
    if (t < 0) return;
    if (s === t || q[i] <= 1e-9) {
      // A fan recirculating inside one zone (or stalled): its heat stays in the zone.
      b[t] += g.heatW / (RHO * CP);
      return;
    }
    add(t, q[i], s, g.heatW / (RHO * CP * q[i]));
  });
  links.forEach((l, i) => {
    const f = linkFlows[i];
    if (f > 0) add(l.b, f, l.a, 0);
    else if (f < 0) add(l.a, -f, l.b, 0);
  });
  zones.forEach((_, k) => {
    if (inflow[k] < TRICKLE) add(k, TRICKLE - inflow[k], -1, 0);
  });
  const rise = solveLinear(A, b) ?? new Array(K).fill(0);

  const riseAt = (e: Endpoint) => (zoneOf(e) < 0 ? 0 : rise[zoneOf(e)]);
  const groupResults: GroupResult[] = groups.map((g, i) => {
    const inletRise = riseAt(g.source);
    const delta = q[i] > 1e-6 ? g.heatW / (RHO * CP * q[i]) : g.heatW > 0 ? 999 : 0;
    const { qmax, pmax } = fanCurve(g.fan, g.fanCount);
    return {
      id: g.id,
      label: g.label,
      heatW: g.heatW,
      flow: q[i],
      cfm: q[i] * M3S_TO_CFM,
      source: g.source,
      sink: g.sink,
      inletRiseC: inletRise,
      deltaC: delta,
      exitRiseC: inletRise + delta,
      adequacy: 2,
      coolantRiseC: g.isRadiator ? inletRise + delta / Math.max(0.05, input.radEffectiveness) : undefined,
      pressurePa: pmax * (1 - q[i] / qmax),
    };
  });

  const amb = input.ambientC;
  const rate = (c: ComponentSpec, airRise: number, via: string): ComponentResult => {
    const tempC = amb + airRise + c.selfRiseK;
    const allowed = c.limitC - amb - c.selfRiseK;
    const adequacy = allowed <= 0 ? 0 : allowed / Math.max(airRise, 1e-6);
    const margin = (c.limitC - tempC) / Math.max(1, c.limitC - amb);
    return { id: c.id, label: c.label, tempC, limitC: c.limitC, headroomK: c.limitC - tempC, margin, adequacy: Math.min(adequacy, 50), heatW: c.heatW, via, air: c.air, selfRiseK: c.selfRiseK };
  };
  const components: ComponentResult[] = [];
  groups.forEach((g, i) => {
    const c = g.component;
    if (!c) return;
    const gr = groupResults[i];
    const airRise =
      c.air === 'coolant'
        ? (gr.coolantRiseC ?? gr.exitRiseC)
        : c.air === 'inlet'
          ? gr.inletRiseC
          : c.air === 'mean'
            ? gr.inletRiseC + gr.deltaC / 2
            : c.air === 'exit'
              ? gr.exitRiseC
              : riseAt(g.source);
    const res = rate(c, airRise, g.id);
    gr.adequacy = res.adequacy;
    components.push(res);
  });
  zones.forEach((z, k) => {
    for (const c of z.components) components.push(rate(c, rise[k], z.id));
  });

  // Diminishing returns: a = 1 (exactly at the limit) scores 0.5, a = 3 scores 0.75.
  const s = (a: number) => a / (a + 1);
  let wsum = 0;
  let acc = 0;
  let worst = Infinity;
  let worstMargin = Infinity;
  let worstHead = 99;
  let worstName = '';
  for (const c of components) {
    const w = Math.max(c.heatW, 30);
    wsum += w;
    acc += w * s(c.adequacy);
    worst = Math.min(worst, c.adequacy);
    if (c.margin < worstMargin) {
      worstMargin = c.margin;
      worstHead = c.headroomK;
      worstName = c.label;
    }
  }
  const zoneResults: ZoneResult[] = zones.map((z, k) => {
    let through = Math.max(0, passive[k]);
    groups.forEach((g, i) => {
      if (zoneOf(g.sink) === k && zoneOf(g.source) !== k) through += q[i];
    });
    links.forEach((l, i) => {
      if (l.b === k && linkFlows[i] > 0) through += linkFlows[i];
      if (l.a === k && linkFlows[i] < 0) through -= linkFlows[i];
    });
    return { id: z.id, label: z.label, pressurePa: p[k], riseC: rise[k], throughFlow: through, passiveFlow: passive[k], heatW: z.heatW };
  });
  const caseComp = components.find((c) => c.via === zones[0].id);
  return {
    groups: groupResults,
    zones: zoneResults,
    links: links.map((l, i) => ({ label: l.label, flow: linkFlows[i] })),
    components,
    casePressurePa: p[0],
    caseThroughFlow: zoneResults[0].throughFlow,
    caseRiseC: rise[0],
    caseAdequacy: caseComp?.adequacy ?? 2,
    passiveFlow: -passive[0],
    score: wsum > 0 ? acc / wsum : 1,
    worstAdequacy: Number.isFinite(worst) ? worst : 2,
    worstMargin: Number.isFinite(worstMargin) ? worstMargin : 1,
    worstHeadroomK: worstHead,
    worstComponent: worstName,
  };
}

function bisect(f: (x: number) => number) {
  let lo = -500;
  let hi = 500;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Gaussian elimination with partial pivoting; null when singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export interface FlowInput {
  groups: FanGroupInput[];
  /** Heat released straight into case air (board, extras, …). */
  internalHeatW: number;
  /** Gross passive vent area, m², with its loss coefficient. */
  passiveArea: number;
  passiveZeta: number;
  ambientC: number;
  /** Allowed air rise for groups and case air that have no component limit of their own. */
  targetRiseC: number;
  radEffectiveness: number;
  caseComponents?: ComponentSpec[];
}

/** One-zone case: every 'case' endpoint is the same well-mixed air. */
export function solveFlow(input: FlowInput): FlowResult {
  const lim = input.ambientC + input.targetRiseC;
  const comps = input.caseComponents ?? [{ id: 'case', label: 'Case interior', limitC: lim, selfRiseK: 0, air: 'zone' as const, heatW: Math.max(30, input.internalHeatW) }];
  // Groups without a component of their own are rated on their exit air against the same target.
  const groups = input.groups.map((g) =>
    g.component || g.heatW <= 0 ? g : { ...g, component: { id: g.id, label: g.label, limitC: lim, selfRiseK: 0, air: 'exit' as const, heatW: g.heatW } },
  );
  return solveNetwork({
    zones: [{ id: 'case', label: 'Case', heatW: input.internalHeatW, passiveArea: input.passiveArea, passiveZeta: input.passiveZeta, leakArea: 0.001, components: comps }],
    links: [],
    groups,
    ambientC: input.ambientC,
    radEffectiveness: input.radEffectiveness,
  });
}
