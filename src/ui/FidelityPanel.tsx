import { useEffect, useRef, useState } from 'react';
import type { DesignConfig } from '../model/types';
import { compareWithApp, parseFoamResults } from '../export/foamResults';
import { download } from '../render/export';
import { fitCorrection, fitProblem, type Measurement } from '../solver/calibrate';
import type { Design } from '../solver/evaluate';
import { FLOW_UNCERTAINTY, GAIN_RELATIVE_UNCERTAINTY } from '../solver/uncertainty';

type Compared = ReturnType<typeof compareWithApp>;
type Fitted = ReturnType<typeof fitCorrection>;

/** Independent references: an OpenFOAM case to run elsewhere, and measurements from a prototype. */
export function FidelityPanel({ design, cfg }: { design: Design; cfg: DesignConfig }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ref, setRef] = useState<Compared | null>(null);
  const [rows, setRows] = useState<Measurement[]>([]);
  const [fit, setFit] = useState<Fitted | null>(null);
  const worker = useRef<Worker | null>(null);
  useEffect(() => {
    setRef(null);
    setFit(null);
    setRows([]);
  }, [design]);
  useEffect(() => () => worker.current?.terminate(), []);
  const fans = design.recipe.fans;
  const comps = design.flow.components;

  const exportCase = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../export/worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setBusy(true);
    setErr(null);
    w.onmessage = (e) => {
      const d = e.data as { zip?: Uint8Array; error?: string };
      setBusy(false);
      if (d.zip) download(new Blob([d.zip.buffer as ArrayBuffer], { type: 'application/zip' }), `caseblanket-openfoam-${design.id}.zip`);
      if (d.error) setErr(d.error);
      w.terminate();
    };
    w.postMessage({ design, cfg });
  };

  const importResults = async (list: FileList | null) => {
    if (!list) return;
    const files = await Promise.all(
      [...list]
        .filter((f) => f.name.endsWith('.dat'))
        .map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text: await f.text() })),
    );
    const r = parseFoamResults(files);
    if (!Object.keys(r.flow).length && !Object.keys(r.zone).length) {
      setErr('No flow_*, tin_* or tzone_* results found: choose the case’s postProcessing folder.');
      return;
    }
    setErr(null);
    setRef(compareWithApp(design, cfg.prefs.ambientC, r));
  };

  const blank = (): Measurement => ({
    rpm: Object.fromEntries(fans.map((f) => [f.id, Math.round((design.flow.groups.find((g) => g.id === f.id)?.speed ?? 1) * f.rpmMax)])),
    temps: {},
    roomC: cfg.prefs.ambientC,
  });
  const setRow = (i: number, m: Measurement) => setRows((r) => r.map((x, j) => (j === i ? m : x)));
  const problem = rows.length ? fitProblem(design.recipe, rows) : null;

  return (
    <section className="fidelity" aria-label="References and measurements">
      <div className="section-head">
        <h3>Check against references</h3>
      </div>
      <p className="muted small">
        The in-app models agree with each other (airflow ±{Math.round(FLOW_UNCERTAINTY * 100)} %, structure gains ±{Math.round(GAIN_RELATIVE_UNCERTAINTY * 100)} %
        from grid refinement), but neither is checked against reality. Two independent references:
      </p>

      <h4 className="sub">OpenFOAM</h4>
      <p className="muted small">
        A case for openfoam.com v2312+ (buoyantSimpleFoam, k-omega SST, fans on their curves, porous radiators and vents, heat sources). Run it
        with ./Allrun, then import its postProcessing folder. The mesh is stair-stepped (not snapped to the shell): snapping made the solver
        diverge. On the default design it converges in about 300 iterations.
      </p>
      <div className="explorer-actions">
        <button type="button" className="btn ghost small" onClick={exportCase} disabled={busy}>
          {busy ? 'Building the case…' : 'Export OpenFOAM case'}
        </button>
        <label className="btn ghost small file-btn">
          Import results folder
          <input type="file" multiple {...({ webkitdirectory: '' } as Record<string, string>)} onChange={(e) => void importResults(e.target.files)} />
        </label>
      </div>
      {err && <p className="error-text">{err}</p>}
      {ref && (
        <>
          <table className="sim-table">
            <thead>
              <tr>
                <th scope="col">Quantity</th>
                <th scope="col" className="num">
                  App
                </th>
                <th scope="col" className="num">
                  OpenFOAM
                </th>
                <th scope="col" className="num">
                  Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {ref.rows.map((r) => (
                <tr key={r.what}>
                  <th scope="row">{r.what}</th>
                  <td className="num">
                    {r.app.toFixed(1)} {r.unit}
                  </td>
                  <td className="num">{r.reference.toFixed(1)}</td>
                  <td className="num">{r.unit === 'CFM' ? `${r.difference.toFixed(0)} %` : `${r.difference.toFixed(1)} K`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            After {ref.iteration} iterations: airflow off by {ref.flowRmsPct.toFixed(0)} % rms, air temperatures by {ref.tempRmsK.toFixed(1)} K rms.
            {ref.recirculation.length > 0 &&
              ` Recirculation (tracer from the heat sources reaching each fan): ${ref.recirculation.map((x) => `${x.group} ${Math.round(x.share * 100)} %`).join(', ')}.`}
          </p>
        </>
      )}

      <h4 className="sub">Prototype measurements</h4>
      <p className="muted small">
        Print it, run it at a steady load, and enter what you measured: fan speeds, thermocouple readings and noise at 1 m. At least two runs at
        different fan speeds. The fit adjusts radiator resistance, case leakage and a noise offset.
      </p>
      {rows.map((m, i) => (
        <fieldset key={i} className="measure">
          <legend>Run {i + 1}</legend>
          <div className="grid g3">
            {fans.map((f) => (
              <label key={f.id} className="field">
                <span className="field-label">{f.label} RPM</span>
                <input type="number" value={m.rpm[f.id] ?? ''} onChange={(e) => setRow(i, { ...m, rpm: { ...m.rpm, [f.id]: Number(e.target.value) } })} />
              </label>
            ))}
            {comps.map((c) => (
              <label key={c.id} className="field">
                <span className="field-label">{c.label} °C</span>
                <input
                  type="number"
                  value={m.temps[c.id] ?? ''}
                  onChange={(e) => {
                    const temps = { ...m.temps };
                    if (e.target.value === '') delete temps[c.id];
                    else temps[c.id] = Number(e.target.value);
                    setRow(i, { ...m, temps });
                  }}
                />
              </label>
            ))}
            <label className="field">
              <span className="field-label">Room °C</span>
              <input type="number" value={m.roomC} onChange={(e) => setRow(i, { ...m, roomC: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">Noise dB(A) at 1 m</span>
              <input
                type="number"
                value={m.splDb ?? ''}
                onChange={(e) => setRow(i, { ...m, splDb: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
          </div>
        </fieldset>
      ))}
      <div className="explorer-actions">
        <button type="button" className="btn ghost small" onClick={() => setRows((r) => [...r, blank()])}>
          Add a run
        </button>
        <button type="button" className="btn ghost small" disabled={!rows.length || !!problem} onClick={() => setFit(fitCorrection(design.recipe, rows))}>
          Fit the model
        </button>
      </div>
      {problem && <p className="muted small">{problem}</p>}
      {fit && (
        <p className="small">
          Radiator resistance ×{fit.correction.radiator.toFixed(2)}
          {fit.identifiable.radiator ? '' : ' (not constrained by these runs)'}, leakage ×{fit.correction.leakage.toFixed(2)}
          {fit.identifiable.leakage ? '' : ' (not constrained by these runs)'}
          {fit.identifiable.noise ? `, noise ${fit.correction.noiseDb >= 0 ? '+' : ''}${fit.correction.noiseDb.toFixed(1)} dB` : ''}. Error{' '}
          {fit.rmsBefore.toFixed(1)} → {fit.rmsAfter.toFixed(1)} rms (K and dB). Enter the factors in the Model tab (radiator loss, noise
          sources) to design with them.
        </p>
      )}
    </section>
  );
}
