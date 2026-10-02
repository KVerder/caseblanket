import { isWrap } from '../solver/shrinkwrap';
import { useEffect, useRef, useState } from 'react';
import type { DesignConfig } from '../model/types';
import { MATERIALS, VENT_STYLES } from '../model/presets';
import { perforation } from '../model/perforation';
import { DEFAULT_SLICER, type Manifest, type SlicerSettings } from '../print/analysis';
import { DEFAULT_PRINT, planPieces, type PrintOptions } from '../print/printable';
import type { MountPlan } from '../print/mounts';
import { download } from '../render/export';
import type { Design } from '../solver/evaluate';
import { NumberField } from './fields';

/** Export the shell as print-ready STL pieces (zipped), built in a worker. */
export function PrintDialog({ design, cfg, onClose }: { design: Design; cfg: DesignConfig; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = useRef<Worker | null>(null);
  const preferred = MATERIALS.find((m) => m.id === cfg.prefs.materialId && m.print)?.id ?? 'petg';
  const [opt, setOpt] = useState<PrintOptions>({ ...DEFAULT_PRINT, bed: cfg.prefs.buildVolume ?? DEFAULT_PRINT.bed, filament: preferred });
  const [state, setState] = useState<{ busy: boolean; done: number; total: number; error?: string; result?: string; manifest?: Manifest; plan?: MountPlan }>({ busy: false, done: 0, total: 0 });
  const slicer = opt.slicer ?? DEFAULT_SLICER;
  const setSlicer = (k: keyof SlicerSettings, v: number) => setOpt((o) => ({ ...o, slicer: { ...(o.slicer ?? DEFAULT_SLICER), [k]: v } }));
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
      const d = e.data as { progress?: { done: number; total: number }; zip?: Uint8Array; pieces?: number; manifest?: Manifest; plan?: MountPlan; error?: string };
      if (d.progress) setState((s) => ({ ...s, ...d.progress }));
      if (d.zip) {
        const stem = `caseblanket-print-${Math.round(design.world.width)}x${Math.round(design.world.height)}x${Math.round(design.world.depth)}`;
        download(new Blob([d.zip.buffer as ArrayBuffer], { type: 'application/zip' }), `${stem}.zip`);
        setState({ busy: false, done: 0, total: 0, result: `${d.pieces} pieces and fit tests, ${(d.zip.length / 1e6).toFixed(0)} MB. Print fit-test/ first; README.txt has the build guide.`, manifest: d.manifest, plan: d.plan });
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
          The {isWrap(cfg) ? 'shrinkwrapped' : 'box'} shell as solid walls with the vent holes and I/O cut-outs cut through, split into
          pieces that fit your printer. One closed STL per piece, zipped, in millimetres.
        </p>
        <span className="field-label">Print bed (mm)</span>
        <div className="grid g3">
          <NumberField id="bed-x" label="X" unit="mm" value={opt.bed[0]} min={100} max={1000} onChange={(v) => setBed(0, v)} />
          <NumberField id="bed-y" label="Y" unit="mm" value={opt.bed[1]} min={100} max={1000} onChange={(v) => setBed(1, v)} />
          <NumberField id="bed-z" label="Z" unit="mm" value={opt.bed[2]} min={100} max={1000} onChange={(v) => setBed(2, v)} />
        </div>
        <p className="muted small">
          Vents: {VENT_STYLES.find((v) => v.id === cfg.prefs.ventStyleId)?.label ?? cfg.prefs.ventStyleId}, the pattern the 3D view shows (change it in Tune → Perforation). Holes
          are cut whole, only where the wall faces its vent, with webs of at least {perforation(cfg.prefs.ventStyleId).web} mm and a solid border at the joints.
        </p>
        <div className="grid g2">
          <label className="field" htmlFor="filament">
            <span className="field-label">Preferred filament</span>
            <select id="filament" value={opt.filament} onChange={(e) => setOpt((o) => ({ ...o, filament: e.target.value }))}>
              {MATERIALS.filter((m) => m.print).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label.replace('3D print — ', '')} (HDT ≈ {m.print!.hdtC} °C{m.print!.ul94 === 'V-0' ? ', V-0' : ''})
                </option>
              ))}
            </select>
          </label>
          <label className="field check" htmlFor="liner">
            <input id="liner" type="checkbox" checked={!!opt.liner} onChange={(e) => setOpt((o) => ({ ...o, liner: e.target.checked }))} /> Plan a conductive EMI liner
          </label>
        </div>
        <span className="field-label">Slicer assumptions (for mass and time)</span>
        <div className="grid g4">
          <NumberField id="sl-layer" label="Layer" unit="mm" value={slicer.layerMm} min={0.08} max={0.4} step={0.02} onChange={(v) => setSlicer('layerMm', v)} />
          <NumberField id="sl-walls" label="Walls" value={slicer.walls} min={1} max={8} onChange={(v) => setSlicer('walls', v)} />
          <NumberField id="sl-infill" label="Infill" unit="%" value={Math.round(slicer.infill * 100)} min={0} max={100} onChange={(v) => setSlicer('infill', v / 100)} />
          <NumberField id="sl-speed" label="Speed" unit="mm/s" value={slicer.speedMmS} min={20} max={500} onChange={(v) => setSlicer('speedMmS', v)} />
        </div>
        <p className="muted small">
          {pieces} piece{pieces === 1 ? '' : 's'}, cut on straight planes. Wall {design.wall} mm
          {thin ? ' — thin for FDM; choose "3D print — PETG" in Tune → Shape & finish for 2.4 mm walls.' : '.'} Files run to tens of MB.
          Each piece gets a suggested orientation (least support), a filament for the hottest air it meets, mass and print time; standoff
          bosses and screw holes are listed, not modelled.
        </p>
        {state.busy && (
          <p className="sim-status" role="status">
            <span className="spinner" aria-hidden="true" /> Meshing piece {Math.min(state.done + 1, state.total)} of {state.total}…
          </p>
        )}
        {state.result && <p className="small">Saved: {state.result}</p>}
        {state.manifest && <ManifestView m={state.manifest} plan={state.plan} />}
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

function ManifestView({ m, plan }: { m: Manifest; plan?: MountPlan }) {
  return (
    <div className="manifest">
      <p className="small">
        ≈ <b>{Math.round(m.totalMassG)} g</b> of filament, ≈ <b>{(m.totalTimeMin / 60).toFixed(0)} h</b> of printing, {m.totalSupportCm3.toFixed(0)} cm³ of support (estimates).
      </p>
      <table className="sim-table">
        <thead>
          <tr>
            <th scope="col">Piece</th>
            <th scope="col">Print with</th>
            <th scope="col" className="num">
              Support
            </th>
            <th scope="col" className="num">
              g
            </th>
            <th scope="col" className="num">
              h
            </th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">
                {r.name}
                <span className="path-sub">
                  {r.orientation} · air ≤ {Math.round(r.airC)} °C{r.needsV0 ? ' · needs V-0' : ''}
                </span>
              </th>
              <td>{r.filament}</td>
              <td className="num">{r.supportCm3.toFixed(0)} cm³</td>
              <td className="num">{Math.round(r.massG)}</td>
              <td className="num">{(r.timeMin / 60).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="checks-list">
        {m.flags.map((f, i) => (
          <li key={i} className="check warn">
            <span className="dot" aria-hidden="true" />
            <span>{f}</span>
          </li>
        ))}
        {plan?.warnings.map((w, i) => (
          <li key={`w${i}`} className="check warn">
            <span className="dot" aria-hidden="true" />
            <span>{w}</span>
          </li>
        ))}
        {!plan &&
          m.inserts.map((x) => (
            <li key={x.what} className="check info">
              <span className="dot" aria-hidden="true" />
              <span>
                {x.count} × {x.what}: {x.note}
              </span>
            </li>
          ))}
      </ul>
      {plan && (
        <>
          <h4 className="sub">Hardware to buy</h4>
          <ul className="checks-list hardware">
            {plan.hardware.map((h) => (
              <li key={h.item} className="check info">
                <span className="dot" aria-hidden="true" />
                <span>
                  <b>{h.qty} ×</b> {h.item}
                  <span className="path-sub">{h.note}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Generated: {plan.standoffs.length} board standoffs with insert holes, {plan.holes.length} screw and button holes
            {plan.openings.length ? `, ${plan.openings.map((o) => o.label).join(' and ')} cut-outs` : ''}
            {plan.bulkheads.length ? `, a printed ${plan.bulkheads.map((b) => b.label).join(', ')}` : ''}. Dimensions: {plan.sources.join('; ')}.
          </p>
        </>
      )}
    </div>
  );
}
