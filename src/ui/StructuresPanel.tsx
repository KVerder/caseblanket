import { useMemo, useState } from 'react';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { evaluateStructures, NOISE_MIN_GAIN_DB, STRUCTURES_NOT_ESTIMATED } from '../solver/structures';
import { STRUCTURE_MIN_GAIN } from '../cfd/run';
import { gainWithUncertainty } from '../solver/uncertainty';
import { LOAD_LABEL } from './ResultsPanel';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number, digits = 1, unit = '') => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}${unit}`;
const time = (min: number) => (min >= 90 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min`);

/**
 * Bell-mouths, diffusers, deeper plenums and silencers, estimated in the airflow and noise model
 * with the fan speeds solved again for each. Listed with every cost; none is applied to the design.
 */
export function StructuresPanel({ design, cfg }: { design: Design; cfg: DesignConfig }) {
  const [open, setOpen] = useState<string | null>(null);
  const { baseline, results } = useMemo(() => evaluateStructures(design, cfg), [design, cfg]);
  const quiet = design.recipe.control.quiet;
  const worth = results.filter((r) => r.worthIt);

  return (
    <section className="structures" aria-label="Flow and noise structures">
      <div className="section-head">
        <h3>Structures</h3>
        <span className="muted small">estimates, at {LOAD_LABEL[cfg.prefs.loadProfile]} load</span>
      </div>
      <p className="muted small">
        Each structure is added on its own, then the fan speeds are solved again {quiet ? 'for the quietest safe setting' : `within the ${design.recipe.control.budgetDb} dB(A) budget`},
        so noise freed by a silencer can come back as cooling, and pressure lost to it as noise. All coefficients are textbook-style estimates:
        nothing here is applied to the design or the explorer until a reference simulation or a measured prototype confirms it.
      </p>
      <p className="small">
        {worth.length
          ? `${worth.length} of ${results.length} beat the uncertainty (${pct(STRUCTURE_MIN_GAIN)} of the tightest part's budget, or ${NOISE_MIN_GAIN_DB} dB).`
          : `None of the ${results.length} beats the uncertainty (${pct(STRUCTURE_MIN_GAIN)} of the tightest part's budget, or ${NOISE_MIN_GAIN_DB} dB) for this design.`}{' '}
        As solved: tightest part {pct(baseline.flow.worstMargin)} of its budget left, {baseline.noise.spl.toFixed(1)} dB(A).
      </p>
      <div className="table-scroll">
        <table className="sim-table structures-table">
          <thead>
            <tr>
              <th scope="col">Structure</th>
              <th scope="col" className="num" title="Tightest part: change of its headroom below the limit">
                Cooling
              </th>
              <th scope="col" className="num" title="Case noise at 1 m">
                Noise
              </th>
              <th scope="col" className="num" title="Case volume added">
                Volume
              </th>
              <th scope="col" className="num" title="Filament and print time, default slicer settings">
                Print
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} className={r.worthIt ? 'worth' : undefined}>
                <th scope="row">
                  <button type="button" className="link-btn" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    {r.worthIt ? '✓ ' : ''}
                    {r.short}
                  </button>
                  {open === r.id && (
                    <span className="path-sub">
                      {r.label}. {r.basis}. {r.note} Tightest part after: {r.after.flow.worstComponent}, {pct(r.after.flow.worstMargin)} left.
                    </span>
                  )}
                </th>
                <td className="num">{Math.abs(r.headroomGainK) < 0.05 ? '0' : gainWithUncertainty(r.headroomGainK)}</td>
                <td className="num">{Math.abs(r.noiseDeltaDb) < 0.05 ? '0' : signed(r.noiseDeltaDb, 1, ' dB')}</td>
                <td className="num">{r.volumeL < 0.05 ? '0' : `+${r.volumeL.toFixed(1)} L`}</td>
                <td className="num">
                  {Math.round(r.massG)} g<span className="path-sub">{time(r.printMin)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Not estimated: {STRUCTURES_NOT_ESTIMATED.map((s) => `${s.label} (${s.why})`).join('; ')}.</p>
    </section>
  );
}
