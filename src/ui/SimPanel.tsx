import { useEffect, useRef, useState } from 'react';
import type { ShapingResult } from '../cfd/run';
import type { Shaping } from '../cfd/scene';
import type { FlowStats } from '../cfd/solver';
import type { DesignConfig } from '../model/types';
import type { CaseViewer } from '../render/Viewer';
import type { Design } from '../solver/evaluate';
import { CfdClient } from '../state/cfdClient';

type Status = { kind: 'idle' } | { kind: 'running'; simSeconds: number } | { kind: 'done' } | { kind: 'error'; text: string };

const f1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);

/** Live airflow simulation of the selected design, and the flow-shaping optimiser. */
export function SimPanel({ design, cfg, viewer }: { design: Design; cfg: DesignConfig; viewer: () => CaseViewer | null }) {
  const client = useRef<CfdClient | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [stats, setStats] = useState<FlowStats | null>(null);
  const [opt, setOpt] = useState<{ running: boolean; done: number; total: number; label: string; result: ShapingResult | null; error?: string }>({
    running: false,
    done: 0,
    total: 0,
    label: '',
    result: null,
  });
  const [shaping, setShaping] = useState<Shaping | null>(null);

  // A new design (or new settings) invalidates every simulation result.
  useEffect(() => {
    client.current?.stop();
    setStatus({ kind: 'idle' });
    setStats(null);
    setOpt({ running: false, done: 0, total: 0, label: '', result: null });
    setShaping(null);
  }, [design]);
  useEffect(() => () => client.current?.stop(), []);

  const run = (s: Shaping | null) => {
    client.current ??= new CfdClient();
    setStatus({ kind: 'running', simSeconds: 0 });
    viewer()?.setShaping(s);
    client.current.simulate(design, cfg, s ?? { louvres: [], ducts: [], flipped: [] }, {
      frame: (f) => {
        viewer()?.setFlowFrame(f);
        setStats(f.stats);
        setStatus(f.done ? { kind: 'done' } : { kind: 'running', simSeconds: f.stats.time });
      },
      error: (text) => setStatus({ kind: 'error', text }),
    });
  };

  const optimise = () => {
    client.current ??= new CfdClient();
    setOpt({ running: true, done: 0, total: 1, label: 'Preparing', result: null });
    client.current.optimise(design, cfg, {
      progress: (p) => setOpt((o) => ({ ...o, ...p })),
      result: (result) => {
        setOpt({ running: false, done: 1, total: 1, label: '', result });
        const s = result.shaping.louvres.length + result.shaping.ducts.length + result.shaping.flipped.length ? result.shaping : null;
        setShaping(s);
        run(s);
      },
      error: (text) => setOpt((o) => ({ ...o, running: false, error: text })),
    });
  };

  const stop = () => {
    client.current?.stop();
    setStatus(stats ? { kind: 'done' } : { kind: 'idle' });
    setOpt((o) => ({ ...o, running: false }));
  };

  const model = (id: string) => design.flow.groups.find((g) => g.id === id);
  const running = status.kind === 'running' || opt.running;

  return (
    <section className="sim" aria-label="Airflow simulation">
      <div className="section-head">
        <h3>Airflow simulation</h3>
        <span className="muted small">3D, coarse</span>
      </div>
      <p className="muted small">
        Simulates the air in and around the case on a ~1 cm grid: fans push along their fan curves, radiators and panels resist, heat rides
        with the air. The 3D view shows it as moving streaks coloured from room temperature (blue) to hot (red).
      </p>
      <div className="row-actions wrap">
        {!running ? (
          <>
            <button type="button" className="btn" onClick={() => run(shaping)}>
              {stats ? 'Run again' : 'Simulate airflow'}
            </button>
            <button type="button" className="btn ghost" onClick={optimise}>
              Shape the airflow
            </button>
          </>
        ) : (
          <button type="button" className="btn ghost" onClick={stop}>
            Stop
          </button>
        )}
      </div>
      {status.kind === 'running' && (
        <p className="sim-status" role="status">
          <span className="spinner" aria-hidden="true" /> Simulating… {status.simSeconds.toFixed(1)} s of airflow
        </p>
      )}
      {status.kind === 'error' && <p className="error-text">{status.text}</p>}
      {opt.running && (
        <div className="sim-status" role="status">
          <span className="spinner" aria-hidden="true" /> Trying {opt.done} of {opt.total}: {opt.label}
          <span className="meter wide" aria-hidden="true">
            <span style={{ width: `${(opt.done / Math.max(1, opt.total)) * 100}%` }} />
          </span>
        </div>
      )}
      {opt.error && <p className="error-text">{opt.error}</p>}

      {stats && (
        <table className="sim-table">
          <thead>
            <tr>
              <th scope="col">Heat source</th>
              <th scope="col" className="num" title="Temperature rise of the air entering it, simulation">
                Air in
              </th>
              <th scope="col" className="num" title="Mean rise of the air inside it, simulation">
                In part
              </th>
              <th scope="col" className="num" title="Air temperature rise leaving it, from the fan-curve model">
                Model out
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.sources.map((s) => (
              <tr key={s.id}>
                <th scope="row">
                  {s.label}
                  <span className="path-sub">{Math.round(s.watts)} W</span>
                </th>
                <td className="num">{f1(s.inletRise)}°</td>
                <td className="num">{f1(s.meanRise)}°</td>
                <td className="num">{model(s.id) ? `${f1(model(s.id)!.exitRiseC)}°` : '—'}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Case air (mean)</th>
              <td className="num" colSpan={2}>
                {f1(stats.caseRise)}°
              </td>
              <td className="num">{f1(design.flow.caseRiseC)}°</td>
            </tr>
          </tbody>
        </table>
      )}

      {opt.result && (
        <div className="shaping">
          <h4 className="sub">Airflow shaping</h4>
          <p className="small">
            Heat-weighted intake air: <b>{f1(opt.result.baselineScore)} °C</b> → <b>{f1(opt.result.bestScore)} °C</b>
            {opt.result.bestScore < opt.result.baselineScore - 0.05
              ? ` (${(opt.result.baselineScore - opt.result.bestScore).toFixed(1)} °C cooler)`
              : ' — nothing tried beat the plain design.'}
          </p>
          <ul className="checks-list">
            {opt.result.steps.map((s) => (
              <li key={s.label} className={`check ${s.kept ? 'ok' : 'info'}`}>
                <span className="dot" aria-hidden="true" />
                <span>
                  {s.kept ? 'Kept: ' : 'Tried: '}
                  {s.label} ({f1(s.score)} °C)
                </span>
              </li>
            ))}
          </ul>
          {shaping && (
            <p className="muted small">The copper louvres and duct plates in the 3D view are the kept changes; the simulation now runs with them.</p>
          )}
        </div>
      )}
      <p className="muted small">
        Coarse model: cells are about {Math.round(Math.cbrt(((design.interior[0] + 120) * (design.interior[1] + 120) * (design.interior[2] + 120)) / 20000))} mm, so fan
        blades, fin passages, boundary layers and turbulence are not resolved. Fans are pressure jumps on their rated curves and
        radiators, fins and grilles are porous blocks; on test ducts this matches the fan-curve model within 2 % and changes under 1 %
        when the grid is halved. Use it to compare options, not as a measurement.
      </p>
    </section>
  );
}
