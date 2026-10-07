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
  /**
   * Rated on the air in a pocket around it instead of the mixed zone (the board): the pocket's own
   * heat leaves with the air the jets landing on it sweep through (see `pocketRise`).
   */
  pocketHeatW?: number;
}

/**
 * Share of a jet's flow that sweeps a pocket it lands on, and the pocket's exchange with the mixed
 * zone (m³/s). Fitted to the 3D simulation's air over the board in 31 layouts of three builds
 * (default parts, tower cooler with an air-cooled card, AIO CPU cooler): the mixed-zone model put
 * that air 9–10 K too cool on average (RMSE 10–12 K); with the pocket the bias is about 0 and the
 * RMSE 3–6 K. The fit leaves the zone's through-flow out (no gain from it) and gives jets little
 * weight, so this mostly corrects the level, not the ranking of layouts. Estimates.
 */
export const POCKET_SWEEP = 0.02;
export const POCKET_EXCHANGE = 0.002;

/** Air rise in a pocket swept by jets (flow m³/s, exit rise K), with `heatW` of its own. */
export function pocketRise(zoneRise: number, heatW: number, jets: { q: number; rise: number }[]): number {
  let Q = POCKET_EXCHANGE;
  let QT = POCKET_EXCHANGE * zoneRise;
  for (const j of jets) {
    Q += POCKET_SWEEP * j.q;
    QT += POCKET_SWEEP * j.q * j.rise;
  }
  return QT / Q + heatW / (RHO * CP * Q);
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
  /** Fan speed as a share of its maximum (fan laws: airflow ∝ speed, pressure ∝ speed²). Default 1. */
  speed?: number;
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
  /** Height the zone's openings span, m: drives the buoyant (stack) exchange through them. */
  heightM?: number;
}

export interface LinkInput {
  a: number;
  b: number;
  area: number;
  zeta: number;
  label: string;
}

/**
 * A fan's discharge landing on something inside its zone (see jets.ts): a fan group that breathes
 * there (`toGroup`) or a component rated on the zone's air (`toComp`). `share` is the part of the
 * jet's excess temperature over the zone that reaches it.
 */
export interface JetLink {
  from: string;
  toGroup?: string;
  toComp?: string;
  share: number;
}

export interface NetworkInput {
  /** Jets that land on parts: local air instead of the mixed zone's. */
  jets?: JetLink[];
  zones: ZoneInput[];
  links: LinkInput[];
  groups: FanGroupInput[];
  ambientC: number;
  radEffectiveness: number;
  /**
   * Share of an internal fan's intake that is its own exhaust (a fan moving case air inside the
   * case re-ingests what it just warmed; a perfectly mixed zone would say 0). Estimate, fitted to
   * the 3D simulation.
   */
  internalRecirculation?: number;
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
  /** Part of the inlet rise that is another fan's jet landing on this one's intake, K. */
  jetRiseC?: number;
  pressurePa: number;
  /** Fan speed as a share of its maximum. */
  speed: number;
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

/** Turn into or out of the gap under a case standing on its feet, on the gap's side area (estimate). */
export const FLOOR_GAP_ZETA = 1;

/**
 * The desk or floor under bottom vents: air reaches them only through the gap between the case
 * and the surface, whose side area is the vents' perimeter (at most the footprint's) times the
 * feet height. Returns that loss as ζ on the vents' own gross area. The usual fan-clearance rule
 * (a quarter of the fan size) is where the gap's side area equals the fan's area.
 */
export function floorGapZeta(ventAreaMm2: number, ventPerimeterMm: number, feetMm: number, footprintPerimeterMm: number): number {
  const gap = Math.min(ventPerimeterMm, footprintPerimeterMm) * Math.max(feetMm, 0.5);
  return FLOOR_GAP_ZETA * (ventAreaMm2 / gap) ** 2;
}

export function fanCurve(fan: FanSpec, count: number, speed = 1) {
  return {
    qmax: (fan.maxAirflowM3h / 3600) * count * speed,
    pmax: fan.maxPressureMmH2O * MMH2O_TO_PA * speed * speed,
  };
}

/** Operating airflow for a fan (group) against Σζ losses plus a constant pressure offset p0. */
export function operatingFlow(fan: FanSpec, count: number, losses: LossTerm[], p0: number, speed = 1): number {
  if (speed <= 0) return 0;
  const { qmax, pmax } = fanCurve(fan, count, speed);
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

  const groupFlows = (p: number[]) => groups.map((g) => operatingFlow(g.fan, g.fanCount, g.losses, pz(p, g.sink) - pz(p, g.source), g.speed ?? 1));
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
  // Jets caught by a fan that takes them out of the zone (an exhaust, or into another zone) never
  // mix in: that share of the blowing group's flow bypasses the zone (a short circuit).
  const jets = (input.jets ?? []).filter((j) => groups.some((g) => g.id === j.from));
  const gIdx = new Map(groups.map((g, i) => [g.id, i]));
  const bypass = new Array(groups.length).fill(0);
  /** Share of a group's intake that is another group's jet: [from index, share]. */
  const fed: [number, number][][] = groups.map(() => []);
  for (const j of jets) {
    if (!j.toGroup) continue;
    const a = gIdx.get(j.from)!;
    const bI = gIdx.get(j.toGroup);
    if (bI === undefined || a === bI) continue;
    const z = zoneOf(groups[a].sink);
    if (z < 0 || zoneOf(groups[bI].source) !== z || q[a] <= 1e-9 || q[bI] <= 1e-9) continue;
    const m = Math.min(j.share * q[a], q[bI], q[a] - bypass[a]);
    if (m <= 0) continue;
    fed[bI].push([a, m / q[bI]]);
    if (zoneOf(groups[bI].sink) !== z) bypass[a] += m;
  }
  groups.forEach((g, i) => {
    const s = zoneOf(g.source);
    const t = zoneOf(g.sink);
    if (t < 0) return;
    if (bypass[i] > 0 && s !== t && q[i] > 1e-9) {
      // Only what is not caught straight away enters the zone, at the group's exit temperature.
      const qm = q[i] - bypass[i];
      if (qm > 1e-9) add(t, qm, s, g.heatW / (RHO * CP * q[i]));
      return;
    }
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
  // Buoyant (stack) exchange through each zone's openings: warm air leaves high, room air enters
  // low, Δp = ρ·g·(H/2)·ΔT/T across two halves of the openings in series (vents spread over the
  // height). It adds to the forced through-flow as √(Qf² + Qs²) and is solved with the temperatures.
  const fresh = zones.map((_, k) => {
    let f = Math.max(0, passive[k]);
    groups.forEach((g, i) => {
      if (zoneOf(g.sink) === k && zoneOf(g.source) < 0) f += q[i];
    });
    return f;
  });
  const stack = (k: number, riseK: number) => {
    const z = zones[k];
    const H = z.heightM ?? 0;
    const area = passiveArea(z);
    if (H <= 0 || area <= 0 || riseK <= 0) return 0;
    const dp = RHO * 9.81 * (H / 2) * (riseK / (273.15 + input.ambientC));
    return (area / 2) * Math.sqrt(dp / (RHO * Math.max(0.5, passiveZeta(z))));
  };
  const solveRise = (extra: number[]) => {
    const A2 = A.map((row, i) => row.map((x, j) => (i === j ? x + extra[i] : x)));
    return solveLinear(A2, b) ?? new Array(K).fill(0);
  };
  let rise = solveRise(new Array(K).fill(0));
  if (zones.some((z) => (z.heightM ?? 0) > 0)) {
    for (let it = 0; it < 40; it++) {
      const extra = zones.map((_, k) => {
        const qs = stack(k, Math.max(0, rise[k]));
        return Math.sqrt(fresh[k] * fresh[k] + qs * qs) - fresh[k];
      });
      const next = solveRise(extra);
      const change = Math.max(...next.map((x, i) => Math.abs(x - rise[i])));
      rise = rise.map((x, i) => 0.5 * x + 0.5 * next[i]);
      if (change < 0.01) break;
    }
  }

  const riseAt = (e: Endpoint) => (zoneOf(e) < 0 ? 0 : rise[zoneOf(e)]);
  const recirc = Math.max(0, Math.min(0.9, input.internalRecirculation ?? 0));
  const groupResults: GroupResult[] = groups.map((g, i) => {
    const delta = q[i] > 1e-6 ? g.heatW / (RHO * CP * q[i]) : g.heatW > 0 ? 999 : 0;
    // An internal fan (case air in, case air out) re-ingests part of its own exhaust.
    const internal = zoneOf(g.source) >= 0 && zoneOf(g.source) === zoneOf(g.sink);
    const inletRise = riseAt(g.source) + (internal && delta < 999 ? (recirc / (1 - recirc)) * delta : 0);
    const { qmax, pmax } = fanCurve(g.fan, g.fanCount, g.speed ?? 1);
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
      pressurePa: qmax > 0 ? pmax * (1 - q[i] / qmax) : 0,
      speed: g.speed ?? 1,
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
  // Jets: a group fed by another's jet breathes a mix of the jet and the zone (passes, since a fed
  // group may blow a jet of its own).
  if (fed.some((f) => f.length))
    for (let pass = 0; pass < 3; pass++)
      groups.forEach((g, i) => {
        if (!fed[i].length) return;
        const gr = groupResults[i];
        const zr = riseAt(g.source);
        const base = gr.inletRiseC - (gr.jetRiseC ?? 0);
        const jet = fed[i].reduce((acc, [a, f]) => acc + f * (groupResults[a].exitRiseC - zr), 0);
        gr.jetRiseC = jet;
        gr.inletRiseC = base + jet;
        gr.exitRiseC = gr.inletRiseC + gr.deltaC;
        if (gr.coolantRiseC !== undefined) gr.coolantRiseC = gr.inletRiseC + gr.deltaC / Math.max(0.05, input.radEffectiveness);
      });
  /** Air a zone component sees: the zone's, plus what jets bring where they land on it, or its pocket's. */
  const compAir = (c: ComponentSpec, k: number) => {
    const on = jets.filter((j) => j.toComp === c.id && zoneOf(groups[gIdx.get(j.from)!].sink) === k);
    if (c.pocketHeatW !== undefined)
      return pocketRise(
        rise[k],
        c.pocketHeatW,
        on.map((j) => ({ q: j.share * q[gIdx.get(j.from)!], rise: groupResults[gIdx.get(j.from)!].exitRiseC })),
      );
    return rise[k] + on.reduce((acc, j) => acc + j.share * (groupResults[gIdx.get(j.from)!].exitRiseC - rise[k]), 0);
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
    for (const c of z.components) components.push(rate(c, compAir(c, k), z.id));
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

/** Root of a decreasing function on [−500, 500] Pa: bracketed secant (Illinois), bisection fallback. */
function bisect(f: (x: number) => number) {
  let lo = -500;
  let hi = 500;
  let flo = f(lo);
  let fhi = f(hi);
  if (flo <= 0) return lo;
  if (fhi >= 0) return hi;
  let side = 0;
  let x = 0;
  for (let i = 0; i < 60; i++) {
    x = (lo * fhi - hi * flo) / (fhi - flo);
    if (!(x > lo && x < hi)) x = (lo + hi) / 2;
    const fx = f(x);
    if (Math.abs(fx) < 1e-12 || hi - lo < 1e-9) return x;
    if (fx > 0) {
      lo = x;
      flo = fx;
      if (side === -1) fhi /= 2;
      side = -1;
    } else {
      hi = x;
      fhi = fx;
      if (side === 1) flo /= 2;
      side = 1;
    }
  }
  return x;
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
  jets?: JetLink[];
  /** Leakage on top of the seams, m² (glued joints of a printed shell). */
  extraLeakArea?: number;
  /** Height of the case's openings, m (stack exchange). */
  heightM?: number;
  internalRecirculation?: number;
}

/** One-zone case: every 'case' endpoint is the same well-mixed air. */
export function solveFlow(input: FlowInput): FlowResult {
  return solveNetwork(flowNetwork(input));
}

/** The one-zone input as a zone network (to keep, re-solve or adjust). */
export function flowNetwork(input: FlowInput): NetworkInput {
  const lim = input.ambientC + input.targetRiseC;
  const comps = input.caseComponents ?? [{ id: 'case', label: 'Case interior', limitC: lim, selfRiseK: 0, air: 'zone' as const, heatW: Math.max(30, input.internalHeatW) }];
  // Groups without a component of their own are rated on their exit air against the same target.
  const groups = input.groups.map((g) =>
    g.component || g.heatW <= 0 ? g : { ...g, component: { id: g.id, label: g.label, limitC: lim, selfRiseK: 0, air: 'exit' as const, heatW: g.heatW } },
  );
  return {
    zones: [
      { id: 'case', label: 'Case', heatW: input.internalHeatW, passiveArea: input.passiveArea, passiveZeta: input.passiveZeta, leakArea: 0.001 + (input.extraLeakArea ?? 0), components: comps, heightM: input.heightM },
    ],
    links: [],
    groups,
    jets: input.jets,
    ambientC: input.ambientC,
    radEffectiveness: input.radEffectiveness,
    internalRecirculation: input.internalRecirculation,
  };
}
