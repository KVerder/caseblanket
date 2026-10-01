import type { Design } from '../solver/evaluate';

/**
 * Reading an exported case's postProcessing folder back, and comparing it with the app.
 *
 *   flow_<fan>/<t>/surfaceFieldValue.dat   sum(phi): mass flow through the fan, kg/s
 *   tin_<fan>/<t>/surfaceFieldValue.dat    flow-weighted T and tracer s entering the fan
 *   tzone_<heat>/<t>/volFieldValue.dat     mean T and s in a heat source
 */

export interface FoamFile {
  path: string;
  text: string;
}

export interface FoamResults {
  /** Fan disk name → volume flow, m³/s (signed). */
  flow: Record<string, number>;
  /** Fan disk name → [T K, s] entering it. */
  inlet: Record<string, [number, number]>;
  /** Heat zone name → [T K, s]. */
  zone: Record<string, [number, number]>;
  /** Last iteration seen. */
  iteration: number;
}

const RHO = 1.2;

/** Last data row of an OpenFOAM function-object .dat file. */
function lastRow(text: string): number[] | null {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!rows.length) return null;
  const nums = rows[rows.length - 1]
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map(Number)
    .filter((x) => Number.isFinite(x));
  return nums.length ? nums : null;
}

export function parseFoamResults(files: FoamFile[]): FoamResults {
  const out: FoamResults = { flow: {}, inlet: {}, zone: {}, iteration: 0 };
  // Several restart folders may exist: the highest start time wins for each function.
  const latest = new Map<string, { t: number; row: number[] }>();
  for (const f of files) {
    const m = f.path.replace(/\\/g, '/').match(/(?:^|\/)((?:flow|tin|tzone)_[^/]+)\/([0-9.e+-]+)\/[^/]+\.dat$/);
    if (!m) continue;
    const row = lastRow(f.text);
    if (!row) continue;
    const t = Number(m[2]);
    const prev = latest.get(m[1]);
    if (!prev || t >= prev.t) latest.set(m[1], { t, row });
  }
  for (const [name, { row }] of latest) {
    out.iteration = Math.max(out.iteration, row[0]);
    if (name.startsWith('flow_')) out.flow[name.slice(5)] = row[1] / RHO;
    else if (name.startsWith('tin_')) out.inlet[name.slice(4)] = [row[1], row[2] ?? 0];
    else if (name.startsWith('tzone_')) out.zone[name.slice(6)] = [row[1], row[2] ?? 0];
  }
  return out;
}

export interface ComparisonRow {
  what: string;
  app: number;
  reference: number;
  unit: string;
  /** reference − app, in the row's unit (for % rows, percent of the app value). */
  difference: number;
}

/** Fan disk names are fan<i>_<group>; heat zones heat_<source id>. */
const groupOfFan = (name: string) => name.replace(/^fan\d+_/, '').replace(/_/g, '-');

export function compareWithApp(design: Design, ambientC: number, r: FoamResults) {
  const rows: ComparisonRow[] = [];
  // Airflow per fan group (all its disks together).
  const byGroup = new Map<string, number>();
  for (const [fan, q] of Object.entries(r.flow)) byGroup.set(groupOfFan(fan), (byGroup.get(groupOfFan(fan)) ?? 0) + Math.abs(q));
  for (const [gid, q] of byGroup) {
    const g = design.flow.groups.find((x) => x.id === gid);
    if (!g || g.flow <= 0) continue;
    rows.push({ what: `${g.label}: airflow`, app: g.flow * 2118.88, reference: q * 2118.88, unit: 'CFM', difference: (100 * (q - g.flow)) / g.flow });
  }
  // Mean air in each heat source.
  const meanS: number[] = [];
  for (const [zone, [T, s]] of Object.entries(r.zone)) {
    meanS.push(s);
    const id = zone.replace(/^heat_/, '').replace(/_/g, '-');
    const g = design.flow.groups.find((x) => x.id === id);
    const appRise = g ? g.inletRiseC + g.deltaC / 2 : id === 'board' ? design.flow.caseRiseC : NaN;
    if (!Number.isFinite(appRise)) continue;
    const refRise = T - 273.15 - ambientC;
    rows.push({ what: `${g?.label ?? 'Board & drives'}: mean air rise`, app: appRise, reference: refRise, unit: 'K', difference: refRise - appRise });
  }
  // Recirculation: tracer entering each fan relative to the heat sources' mean.
  const sRef = meanS.length ? meanS.reduce((a, b) => a + b, 0) / meanS.length : 0;
  const recirculation = Object.entries(r.inlet).map(([fan, [, s]]) => ({ fan, group: groupOfFan(fan), share: sRef > 0 ? s / sRef : 0 }));
  const pct = rows.filter((x) => x.unit === 'CFM').map((x) => Math.abs(x.difference));
  const kel = rows.filter((x) => x.unit === 'K').map((x) => Math.abs(x.difference));
  const rmsOf = (v: number[]) => (v.length ? Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : NaN);
  return { rows, recirculation, flowRmsPct: rmsOf(pct), tempRmsK: rmsOf(kel), iteration: r.iteration };
}
