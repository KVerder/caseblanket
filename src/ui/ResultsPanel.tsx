import { MATERIALS } from '../model/presets';
import type { DesignConfig } from '../model/types';
import { M3S_TO_CFM } from '../solver/airflow';
import { TOPOLOGY_LABELS, type Design } from '../solver/evaluate';
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
          <dt>Case air</dt>
          <dd>+{d.flow.caseRiseC.toFixed(1)} °C</dd>
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
        <span className="muted small">vs. +{cfg.prefs.targetRiseC} °C allowed</span>
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
            <th scope="col">Headroom</th>
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
