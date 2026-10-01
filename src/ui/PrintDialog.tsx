import { useEffect, useRef, useState } from 'react';
import type { DesignConfig } from '../model/types';
import { DEFAULT_PRINT, planPieces, type PrintOptions } from '../print/printable';
import { download } from '../render/export';
import type { Design } from '../solver/evaluate';
import { NumberField } from './fields';

/** Export the shell as print-ready STL pieces (zipped), built in a worker. */
export function PrintDialog({ design, cfg, onClose }: { design: Design; cfg: DesignConfig; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = useRef<Worker | null>(null);
  const [opt, setOpt] = useState<PrintOptions>(DEFAULT_PRINT);
  const [state, setState] = useState<{ busy: boolean; done: number; total: number; error?: string; result?: string }>({ busy: false, done: 0, total: 0 });
  useEffect(() => {
    dialog.current?.showModal();
    return () => worker.current?.terminate();
  }, []);
  const pieces = planPieces(design, opt).length;
  const thin = design.wall < 2;

  const build = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../print/worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setState({ busy: true, done: 0, total: pieces });
    w.onmessage = (e) => {
      const d = e.data as { progress?: { done: number; total: number }; zip?: Uint8Array; pieces?: number; error?: string };
      if (d.progress) setState((s) => ({ ...s, ...d.progress }));
      if (d.zip) {
        const stem = `caseblanket-print-${Math.round(design.world.width)}x${Math.round(design.world.height)}x${Math.round(design.world.depth)}`;
        download(new Blob([d.zip.buffer as ArrayBuffer], { type: 'application/zip' }), `${stem}.zip`);
        setState({ busy: false, done: 0, total: 0, result: `${d.pieces} pieces, ${(d.zip.length / 1e6).toFixed(0)} MB.` });
        w.terminate();
      }
      if (d.error) setState({ busy: false, done: 0, total: 0, error: d.error });
    };
    w.postMessage({ design, cfg, opt });
  };

  const close = () => {
    worker.current?.terminate();
    dialog.current?.close();
    onClose();
  };
  const setBed = (i: number, v: number) => setOpt((o) => ({ ...o, bed: o.bed.map((b, j) => (j === i ? v : b)) as [number, number, number] }));

  return (
    <dialog ref={dialog} className="catalog print" onCancel={close} aria-labelledby="print-title">
      <div className="catalog-head">
        <h3 id="print-title">3D-printable shell</h3>
        <button type="button" className="btn icon" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
      <div className="catalog-body print-body">
        <p className="small">
          The {cfg.prefs.organic > 0 ? 'shrinkwrapped' : 'box'} shell as solid walls with the vent holes and I/O cut-outs cut through, split into
          pieces that fit your printer. One closed STL per piece, zipped, in millimetres.
        </p>
        <span className="field-label">Print bed (mm)</span>
        <div className="grid g3">
          <NumberField id="bed-x" label="X" unit="mm" value={opt.bed[0]} min={100} max={1000} onChange={(v) => setBed(0, v)} />
          <NumberField id="bed-y" label="Y" unit="mm" value={opt.bed[1]} min={100} max={1000} onChange={(v) => setBed(1, v)} />
          <NumberField id="bed-z" label="Z" unit="mm" value={opt.bed[2]} min={100} max={1000} onChange={(v) => setBed(2, v)} />
        </div>
        <div className="grid g2">
          <NumberField id="hole-d" label="Vent holes" unit="mm" value={opt.holeDiameter} min={3} max={12} step={0.5} onChange={(v) => setOpt((o) => ({ ...o, holeDiameter: v, holePitch: Math.max(o.holePitch, v + 1.5) }))} />
          <NumberField id="hole-p" label="Hole pitch" unit="mm" value={opt.holePitch} min={opt.holeDiameter + 1.2} max={20} step={0.5} onChange={(v) => setOpt((o) => ({ ...o, holePitch: v }))} />
        </div>
        <p className="muted small">
          {pieces} piece{pieces === 1 ? '' : 's'}, cut on straight planes. Wall {design.wall} mm
          {thin ? ' — thin for FDM; choose "3D print — PETG" in Tune → Shape & finish for 2.4 mm walls.' : '.'} Files run to tens of MB.
          Standoffs and screw bosses are not included.
        </p>
        {state.busy && (
          <p className="sim-status" role="status">
            <span className="spinner" aria-hidden="true" /> Meshing piece {Math.min(state.done + 1, state.total)} of {state.total}…
          </p>
        )}
        {state.result && <p className="small">Saved: {state.result}</p>}
        {state.error && <p className="error-text">{state.error}</p>}
      </div>
      <div className="catalog-foot">
        <button type="button" className="btn" disabled={state.busy} onClick={build}>
          {state.busy ? 'Building…' : 'Build and download'}
        </button>
      </div>
    </dialog>
  );
}
