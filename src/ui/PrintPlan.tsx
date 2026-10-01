import { useEffect, useRef, useState } from 'react';
import { MATERIALS } from '../model/presets';
import type { DesignConfig } from '../model/types';
import type { Manifest } from '../print/analysis';
import { DEFAULT_PRINT } from '../print/printable';
import type { Design } from '../solver/evaluate';

/** Print plan for the selected design: pieces, filament, mass, time and support (built on request). */
export function PrintPlan({ design, cfg }: { design: Design; cfg: DesignConfig }) {
  const [state, setState] = useState<{ busy: boolean; done: number; total: number; m?: Manifest; error?: string }>({ busy: false, done: 0, total: 0 });
  const worker = useRef<Worker | null>(null);
  useEffect(() => {
    worker.current?.terminate();
    setState({ busy: false, done: 0, total: 0 });
  }, [design]);
  useEffect(() => () => worker.current?.terminate(), []);
  const mat = MATERIALS.find((m) => m.id === cfg.prefs.materialId);
  if (!mat?.print) return null;
  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../print/worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setState({ busy: true, done: 0, total: 1 });
    w.onmessage = (e) => {
      const d = e.data as { progress?: { done: number; total: number }; manifest?: Manifest; error?: string };
      if (d.progress) setState((s) => ({ ...s, ...d.progress }));
      if (d.manifest) {
        setState({ busy: false, done: 0, total: 0, m: d.manifest });
        w.terminate();
      }
      if (d.error) setState({ busy: false, done: 0, total: 0, error: d.error });
    };
    w.postMessage({ design, cfg, opt: { ...DEFAULT_PRINT, bed: cfg.prefs.buildVolume ?? DEFAULT_PRINT.bed, filament: mat.id }, planOnly: true });
  };
  const m = state.m;
  const mats = m ? [...new Set(m.rows.map((r) => r.filament))].join(', ') : '';
  return (
    <section className="print-plan" aria-label="3D print plan">
      <div className="section-head">
        <h3>3D print</h3>
        <span className="muted small">{cfg.prefs.buildVolume?.join(' × ')} mm build volume</span>
      </div>
      {!m && (
        <button type="button" className="btn ghost small" onClick={run} disabled={state.busy}>
          {state.busy ? `Meshing piece ${Math.min(state.done + 1, state.total)} of ${state.total}…` : 'Plan the print'}
        </button>
      )}
      {state.error && <p className="error-text">{state.error}</p>}
      {m && (
        <>
          <dl className="kv">
            <div>
              <dt>Pieces</dt>
              <dd>{m.rows.length}</dd>
            </div>
            <div>
              <dt>Filament</dt>
              <dd>≈ {(m.totalMassG / 1000).toFixed(2)} kg</dd>
            </div>
            <div>
              <dt>Print time</dt>
              <dd>≈ {(m.totalTimeMin / 60).toFixed(0)} h</dd>
            </div>
            <div>
              <dt>Support</dt>
              <dd>{m.totalSupportCm3.toFixed(0)} cm³</dd>
            </div>
          </dl>
          <p className="muted small">
            {mats}. {m.flags.length} note{m.flags.length === 1 ? '' : 's'} (flame rating, EMI, hot pieces) and the per-piece plan are in Export → 3D-printable pieces. Mass and time are estimates from typical slicer settings.
          </p>
        </>
      )}
    </section>
  );
}
