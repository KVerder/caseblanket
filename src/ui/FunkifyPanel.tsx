import { useEffect, useRef, useState } from 'react';
import type { DesignConfig } from '../model/types';
import type { FunkResult } from '../solver/funkify';
import { FUNK_CFD_TOL, FUNK_THERMAL_TOL } from '../solver/funkify';
import { FunkClient, type FunkProgress } from '../state/funkClient';
import { produce } from '../state/config';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mm = (x: number) => `${Math.round(x)}`;

/**
 * Funkify: organic, sculpted designs that give up nothing on cooling (size ignored). Runs in its
 * own worker: a thermal-only search, organic shells on every layout within the model's
 * uncertainty of the coolest, a look score, and a 3D check of the picks.
 */
export function FunkifyPanel({ cfg, setCfg, onPick }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void; onPick: (designId: string) => void }) {
  const client = useRef<FunkClient | null>(null);
  const [state, setState] = useState<{ running: boolean; progress?: FunkProgress; result?: FunkResult; error?: string }>({ running: false });
  useEffect(() => () => client.current?.cancel(), []);

  const run = () => {
    client.current ??= new FunkClient();
    setState({ running: true });
    client.current
      .run(cfg, (progress) => setState((s) => ({ ...s, progress })))
      .then((result) => setState({ running: false, result }))
      .catch((e: Error) => setState({ running: false, error: e.message }));
  };
  const apply = (prefs: Partial<DesignConfig['prefs']>, id: string) => {
    onPick(id);
    // Shrinkwrap mode would override the picked shell: applying a Funkify shape turns it off.
    setCfg(produce(cfg, (d) => void Object.assign(d.prefs, structuredClone(prefs), { mold: false })));
  };
  const r = state.result;

  return (
    <section className="funkify" aria-label="Funkify">
      <div className="section-head">
        <h3>Funkify</h3>
        <button type="button" className="btn small" onClick={run} disabled={state.running}>
          {state.running ? 'Funkifying…' : r ? 'Funkify again' : 'Funkify'}
        </button>
      </div>
      <p className="muted small">
        Sculpted, organic cases that give up nothing on cooling. Size is ignored: the solver looks for the coolest layouts with every flow structure on, tries curved
        shells on each one within {pct(FUNK_THERMAL_TOL)} of the coolest, scores how they look, and checks the best in 3D, keeping a shape only if it stays within{' '}
        {FUNK_CFD_TOL} K of the coolest layout in a straight box. The look score is a stated heuristic: how much of the surface curves, how round it is, how calm
        the form is (no lumps), and its proportions against φ.
      </p>
      {state.running && (
        <p className="sim-status small" role="status">
          <span className="spinner" aria-hidden="true" /> {state.progress ? `${state.progress.label}… (${state.progress.done} of ${state.progress.total})` : 'Starting…'} About
          30–60 s in all.
        </p>
      )}
      {cfg.prefs.mold && !state.running && (
        <p className="muted small">Shrinkwrap mode is on; applying a shape turns it off, since it would override the shape.</p>
      )}
      {state.error && <p className="small error">Funkify failed: {state.error}</p>}
      {r && (
        <>
          <p className="muted small">
            {r.stats.layouts} layout{r.stats.layouts === 1 ? '' : 's'} within reach of the coolest ({pct(r.stats.floorMargin)} of the tightest part's budget left, {r.stats.floorHeadroomK.toFixed(1)}{' '}
            K), {r.stats.shapes} shapes scored{r.stats.dropped ? `, ${r.stats.dropped} dropped by the 3D check` : ''}.
          </p>
          <ul className="funk-list">
            {r.picks.map((p) => (
              <li key={`${p.designId}-${p.name}`}>
                <button type="button" className="btn ghost small" onClick={() => apply(p.prefs, p.designId)}>
                  {p.name}
                </button>
                <span className="small">
                  look {Math.round(p.look.score * 100)} · {pct(p.margin)} of budget left{p.cfd ? ` · 3D ${p.cfd.headroomK.toFixed(1)} K (coolest in a box ${p.cfd.refHeadroomK.toFixed(1)} K)` : ''}
                </span>
                <span className="muted small">
                  {mm(p.world.width)} × {mm(p.world.height)} × {mm(p.world.depth)} mm, {p.volumeL.toFixed(1)} L · curves {pct(p.look.curved)}, round {pct(p.look.round)}, calm{' '}
                  {pct(p.look.calm)}, proportion {pct(p.look.ratio)}
                </span>
              </li>
            ))}
          </ul>
          {!r.picks.length && <p className="small">No shape kept up with the coolest layout in 3D; try again with fewer limits, or look at the Shapes table.</p>}
        </>
      )}
    </section>
  );
}
