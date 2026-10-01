import { MATERIALS } from '../model/presets';
import type { DesignConfig, LoadProfileId } from '../model/types';
import { M3S_TO_CFM } from '../solver/airflow';
import { CHAMBER_MIN_GAIN, TOPOLOGY_LABELS, type Design } from '../solver/evaluate';
import { PARTITION_THICKNESS } from '../solver/chambers';
import type { SolveResult } from '../solver/solve';

const mm = (v: number) => Math.round(v).toString();
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Outer size to report: the shrinkwrapped shell when there is one, otherwise the box. */
export function outline(d: Design) {
  if (!d.wrap) return { world: d.world, thickness: d.thickness, volumeL: d.volumeL, weightKg: d.weightKg, wrapped: false };
  const world = { ...d.wrap.world, height: d.wrap.world.height + d.feet };
  return { world, thickness: Math.min(world.width, world.height, world.depth), volumeL: d.wrap.volumeL, weightKg: d.wrap.weightKg, wrapped: true };
}

function headroomClass(a: number) {
  return a >= 1.2 ? 'good' : a >= 1 ? 'fair' : 'bad';
}

function Headroom({ a }: { a: number }) {
  const pct = Math.min(250, Math.round(a * 100));
  return (
    <span className={`headroom ${headroomClass(a)}`}>
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (pct / 250) * 100)}%` }} />
        <i style={{ left: `${(100 / 250) * 100}%` }} />
      </span>
      <span className="pct">{pct}%</span>
    </span>
  );
}

export function Summary({ d, cfg }: { d: Design; cfg: DesignConfig }) {
  const mat = MATERIALS.find((m) => m.id === cfg.prefs.materialId);
  const ol = outline(d);
  const w = ol.world;
  return (
    <section className="summary" aria-label="Selected design">
      <p className="eyebrow">{d.tags[0] ?? 'Alternative'} · {TOPOLOGY_LABELS[d.effectiveTopology].split(' — ')[0]}</p>
      <div className="big-dims" aria-label={`External size ${mm(w.width)} by ${mm(w.height)} by ${mm(w.depth)} millimetres`}>
        <span>
          <b>{mm(w.width)}</b>
          <small>W</small>
        </span>
        <span className="x">×</span>
        <span>
          <b>{mm(w.height)}</b>
          <small>H</small>
        </span>
        <span className="x">×</span>
        <span>
          <b>{mm(w.depth)}</b>
          <small>D mm</small>
        </span>
      </div>
      <dl className="kv">
        <div>
          <dt>Thickness</dt>
          <dd>{mm(ol.thickness)} mm</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>{ol.volumeL.toFixed(1)} L</dd>
        </div>
        <div>
          <dt>Panels</dt>
          <dd>≈ {ol.weightKg.toFixed(2)} kg</dd>
        </div>
        <div>
          <dt>Noise</dt>
          <dd title="Estimate at 1 m, free field">≈ {d.noise[cfg.prefs.loadProfile].noise.spl.toFixed(0)} dB(A)</dd>
        </div>
        <div>
          <dt>Tightest part</dt>
          <dd title={`${d.flow.worstComponent}: ${d.flow.worstHeadroomK.toFixed(0)} K below its limit at ${LOAD_LABEL[cfg.prefs.loadProfile]} load`}>
            {Math.round(d.flow.worstMargin * 100)}% left
          </dd>
        </div>
      </dl>
      <p className="muted small">
        {capitalise(TOPOLOGY_LABELS[d.effectiveTopology].split(' — ')[1])}. {d.profile.label}. {mat?.label}, {cfg.prefs.wallThickness} mm walls
        {ol.wrapped ? `, shrinkwrapped (box envelope ${mm(d.world.width)} × ${mm(d.world.height)} × ${mm(d.world.depth)}, ${d.volumeL.toFixed(1)} L)` : ''}
        {d.wrap?.smoothingL !== undefined ? `; smoothness adds ${d.wrap.smoothingL.toFixed(1)} L` : ''}
        {d.feet ? `, ${d.feet} mm feet for the bottom vents` : ''}.
      </p>
    </section>
  );
}

export const LOAD_LABEL: Record<LoadProfileId, string> = { gaming: 'typical gaming', full: 'sustained full' };

function marginClass(m: number) {
  return m >= 0.3 ? 'good' : m >= 0.1 ? 'fair' : 'bad';
}

/** Every component's predicted temperature against its own limit, at both loads. */
export function Temperatures({ d, cfg }: { d: Design; cfg: DesignConfig }) {
  const sel = cfg.prefs.loadProfile;
  const loads: LoadProfileId[] = ['gaming', 'full'];
  const rows = d.thermal[sel].components;
  const at = (id: LoadProfileId, cid: string) => d.thermal[id].components.find((c) => c.id === cid);
  return (
    <section className="airflow temps" aria-label="Component temperatures">
      <div className="section-head">
        <h3>Component temperatures</h3>
        <span className="muted small">estimate, {cfg.prefs.ambientC} °C room</span>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Component</th>
            {loads.map((l) => (
              <th key={l} scope="col" className={`num${l === sel ? ' sel' : ''}`}>
                {l === 'gaming' ? 'Gaming' : 'Full'}
              </th>
            ))}
            <th scope="col" className="num">
              Limit
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <span className="path-name">{r.label}</span>
                <span className="path-sub">{Math.round(r.heatW)} W at {LOAD_LABEL[sel]} load</span>
              </th>
              {loads.map((l) => {
                const c = at(l, r.id);
                return (
                  <td key={l} className={`num temp ${c ? marginClass(c.margin) : ''}${l === sel ? ' sel' : ''}`}>
                    {c ? `${Math.round(c.tempC)}°` : '—'}
                  </td>
                );
              })}
              <td className="num muted">{r.limitC}°</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Air or coolant temperature from the airflow model plus each part's own rise (power × an estimated thermal resistance). Limits and
        resistances are estimates, editable in the Model tab. Colour: share of each part's budget (limit − room) left.
      </p>
    </section>
  );
}

export function AirflowTable({ d, cfg }: { d: Design; cfg: DesignConfig }) {
  const rows = [
    ...d.flow.groups.map((g) => ({
      id: g.id,
      label: g.label,
      path: g.source === 'outside' && g.sink === 'outside' ? 'through-flow' : g.source === 'outside' ? 'intake' : g.sink === 'outside' ? 'exhaust' : 'case air',
      cfm: g.cfm,
      rise: g.exitRiseC,
      coolant: g.coolantRiseC,
      heat: g.heatW,
      a: g.adequacy,
    })),
    {
      id: 'case',
      label: 'Case interior',
      path: `${(d.flow.caseThroughFlow * M3S_TO_CFM).toFixed(0)} CFM through`,
      cfm: NaN,
      rise: d.flow.caseRiseC,
      coolant: undefined,
      heat: NaN,
      a: d.flow.caseAdequacy,
    },
  ];
  return (
    <section className="airflow" aria-label="Airflow estimate">
      <div className="section-head">
        <h3>Airflow estimate</h3>
        <span className="muted small">at {LOAD_LABEL[cfg.prefs.loadProfile]} load</span>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Heat path</th>
            <th scope="col" className="num">
              Air
            </th>
            <th scope="col" className="num">
              Out
            </th>
            <th scope="col">Part's margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <span className="path-name">{r.label}</span>
                <span className="path-sub">
                  {Number.isFinite(r.heat) ? `${Math.round(r.heat)} W · ` : ''}
                  {r.path}
                  {r.coolant !== undefined ? ` · coolant ≈ +${r.coolant.toFixed(0)} °C` : ''}
                </span>
              </th>
              <td className="num">{Number.isFinite(r.cfm) ? `${r.cfm.toFixed(0)}` : '—'}</td>
              <td className="num">+{r.rise.toFixed(1)}°</td>
              <td>
                <Headroom a={r.a} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Air in CFM, “Out” is how much warmer than the room the air leaves. Case pressure {d.flow.casePressurePa >= 0 ? '+' : ''}
        {d.flow.casePressurePa.toFixed(1)} Pa ({d.flow.casePressurePa >= 0 ? 'positive — dust stays out of the seams' : 'negative — expect dust at the seams'}).
      </p>
    </section>
  );
}

export function Checks({ d }: { d: Design }) {
  const order = { error: 0, warn: 1, info: 2, ok: 3 } as const;
  const list = [...d.checks].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <section className="checks" aria-label="Build checks">
      <h3>Build checks</h3>
      <ul>
        {list.map((c, i) => (
          <li key={i} className={`check ${c.level}`}>
            <span className="dot" aria-hidden="true" />
            <span className="sr-only">{c.level}: </span>
            {c.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Candidates({ result, selected, onSelect }: { result: SolveResult; selected: string | null; onSelect: (id: string) => void }) {
  const best = result.designs[0];
  return (
    <section className="candidates" aria-label="Alternative designs">
      <div className="section-head">
        <h3>Alternatives</h3>
        <span className="muted small">
          {result.stats.evaluated} layouts in {(result.stats.ms / 1000).toFixed(1)} s
        </span>
      </div>
      <ul>
        {result.designs.map((d) => {
          const ol = outline(d);
          const bo = best ? outline(best) : ol;
          const dt = ol.thickness - bo.thickness;
          const dv = ol.volumeL - bo.volumeL;
          return (
            <li key={d.id}>
              <button type="button" className={`cand${d.id === selected ? ' on' : ''}${d.invalid ? ' invalid' : ''}`} onClick={() => onSelect(d.id)} aria-pressed={d.id === selected}>
                <span className="cand-tags">
                  {d.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                  {d.invalid && <span className="tag bad">Won't build</span>}
                  {!d.invalid && d.limited && <span className="tag warn">Airflow tight</span>}
                </span>
                <span className="cand-main">
                  <b>{mm(ol.thickness)} mm</b> thick · <b>{ol.volumeL.toFixed(1)} L</b>
                </span>
                <span className="cand-sub">
                  {mm(ol.world.width)} × {mm(ol.world.height)} × {mm(ol.world.depth)} · {TOPOLOGY_LABELS[d.effectiveTopology].split(' — ')[0]}
                  {d !== best && ` · ${dt >= 0 ? '+' : ''}${mm(dt)} mm, ${dv >= 0 ? '+' : ''}${dv.toFixed(1)} L`}
                </span>
                <span className="cand-air" title="Airflow score: 50% means every heat path gets exactly the air it needs">
                  <span className="meter" aria-hidden="true">
                    <span style={{ width: `${Math.round(d.flow.score * 100)}%` }} />
                  </span>
                  airflow {Math.round(d.flow.score * 100)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Which chamber's air a component sits in: its zone, or the zone its fan draws from. */
function chamberOf(d: Design, via: string): string {
  const ch = d.chamber!.chambers;
  const z = ch.find((c) => c.id === via);
  if (z) return z.label;
  const g = d.flow.groups.find((x) => x.id === via);
  if (!g) return '';
  const k = typeof g.source === 'number' ? g.source : typeof g.sink === 'number' ? g.sink : -1;
  return k >= 0 ? ch[k].label : g.source === 'outside' ? 'draws room air' : '';
}

/** The partitions in use (or the best one tried), and what they change part by part. */
export function Chambers({ d, cfg }: { d: Design; cfg: DesignConfig }) {
  if (cfg.prefs.chambers === 'single') return null;
  const opt = d.chamberOptions[0];
  if (!d.chamber) {
    return (
      <section className="chambers" aria-label="Internal chambers">
        <h3>Internal chambers</h3>
        <p className="muted small">
          {opt
            ? `One chamber. The best partition that fits (${opt.layout.chambers.map((c) => c.label.replace(' chamber', '')).join(' | ')}) changes the tightest part by ${opt.gainK >= 0 ? '+' : ''}${opt.gainK.toFixed(1)} K, ${(opt.gain * 100).toFixed(1)} % of its budget — not more than the model's ±${CHAMBER_MIN_GAIN * 100} %.`
            : 'One chamber. No partition fits between these parts without cutting a part or an air gap.'}
        </p>
      </section>
    );
  }
  const base = d.singleChamberFlow!;
  return (
    <section className="airflow chambers" aria-label="Internal chambers">
      <div className="section-head">
        <h3>Internal chambers</h3>
        <span className="muted small">
          {d.chamber.cuts.length} wall{d.chamber.cuts.length > 1 ? 's' : ''}, ≈ {Math.round(d.chamberWeightKg * 1000)} g
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col" className="num">
              1 chamber
            </th>
            <th scope="col" className="num">
              {d.chamber.chambers.length} chambers
            </th>
          </tr>
        </thead>
        <tbody>
          {d.flow.components.map((c) => {
            const b = base.components.find((x) => x.id === c.id);
            const dT = b ? c.tempC - b.tempC : 0;
            return (
              <tr key={c.id}>
                <th scope="row">
                  <span className="path-name">{c.label}</span>
                  <span className="path-sub">{chamberOf(d, c.via)}</span>
                </th>
                <td className="num muted">{b ? `${Math.round(b.tempC)}°` : '—'}</td>
                <td className={`num ${dT < -0.5 ? 'better' : dT > 0.5 ? 'worse' : ''}`}>
                  {Math.round(c.tempC)}° <small>({dT >= 0 ? '+' : ''}{dT.toFixed(1)})</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="muted small chamber-list">
        {d.chamber.chambers.map((z) => (
          <li key={z.id}>
            <b>{z.label}</b>: {z.parts.map((p) => d.parts.find((x) => x.id === p)?.label ?? p).join(', ')}
          </li>
        ))}
        {d.chamber.links.map((l, i) => (
          <li key={i}>
            Leak {l.label}: ≈ {(l.area * 1e4).toFixed(1)} cm²
          </li>
        ))}
      </ul>
      <p className="muted small">Walls are {PARTITION_THICKNESS} mm printed plates in existing gaps, so they add no volume. Leak areas are estimates.</p>
    </section>
  );
}

/** Fan speeds and the noise they make, source by source, at the selected load. */
export function Noise({ d, cfg }: { d: Design; cfg: DesignConfig }) {
  const load = cfg.prefs.loadProfile;
  const other: LoadProfileId = load === 'gaming' ? 'full' : 'gaming';
  const n = d.noise[load];
  const budget = cfg.prefs.noiseMode === 'budget';
  const fans = n.noise.sources;
  return (
    <section className="airflow noise" aria-label="Noise">
      <div className="section-head">
        <h3>Noise</h3>
        <span className="muted small">estimate, 1 m on a desk</span>
      </div>
      <p className="noise-big">
        <b>{n.noise.spl.toFixed(1)}</b> dB(A)
        <span className="muted small">
          {' '}
          at {LOAD_LABEL[load]} load · {d.noise[other].noise.spl.toFixed(1)} dB(A) at {LOAD_LABEL[other]}
        </span>
      </p>
      <p className="small">
        {budget
          ? n.feasible
            ? `Within the ${cfg.prefs.noiseBudgetDb} dB(A) budget.`
            : `Over the ${cfg.prefs.noiseBudgetDb} dB(A) budget even at the slowest fan speeds.`
          : n.feasible
            ? 'As quiet as the fans can go with every part under its limit.'
            : 'Even full speed leaves a part over its limit.'}{' '}
        {Number.isFinite(n.quietDb) && budget ? `Quietest with every part under its limit: ${n.quietDb.toFixed(1)} dB(A).` : ''}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col" className="num">
              Speed
            </th>
            <th scope="col" className="num">
              dB(A)
            </th>
          </tr>
        </thead>
        <tbody>
          {fans.map((s) => {
            const sp = s.id === 'psu' ? d.flow.groups.find((g) => g.id === 'psu')?.speed : n.speeds[s.id];
            return (
              <tr key={s.id}>
                <th scope="row">
                  <span className="path-name">{s.label}</span>
                  <span className="path-sub">
                    {s.bpfHz ? `blade tone ${Math.round(s.bpfHz)} Hz` : ''}
                    {s.penaltyDb ? ` · +${s.penaltyDb.toFixed(1)} dB from the grille${s.tonal ? ' (tonal)' : ''}` : ''}
                  </span>
                </th>
                <td className="num">{sp !== undefined ? `${Math.round(sp * 100)}%` : '—'}</td>
                <td className="num">{Number.isFinite(s.lw) && s.lw - 8 > 0 ? (s.lw - 8).toFixed(1) : '< 0'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        Each row is that source alone at 1 m; they add as powers (two equal sources = +3 dB). Fan ratings are read as sound pressure at 1 m and
        scaled by the fan laws; grille penalties, vent noise and the pump level are estimates.
      </p>
    </section>
  );
}
