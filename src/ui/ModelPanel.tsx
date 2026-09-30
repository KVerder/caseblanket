import { DEFAULT_ADVANCED } from '../model/presets';
import type { AdvancedModel, DesignConfig } from '../model/types';
import { perforatedPlateZeta } from '../solver/airflow';
import { produce } from '../state/config';
import { Grid, NumberField, Section } from './fields';

export function ModelPanel({ cfg, setCfg }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void }) {
  const a = cfg.advanced;
  const set = <K extends keyof AdvancedModel>(k: K, v: AdvancedModel[K]) => setCfg(produce(cfg, (d) => void (d.advanced[k] = v)));
  return (
    <div className="panel-stack">
      <Section title="Gaps">
        <Grid cols={3}>
          <NumberField id="gap-cool" label="CPU fan" unit="mm" value={a.coolerFanGap} min={0} max={40} onChange={(v) => set('coolerFanGap', v)} hint="Between a low-profile cooler's fan and its panel" />
          <NumberField id="gap-card" label="Card fan" unit="mm" value={a.cardFanGap} min={0} max={40} onChange={(v) => set('cardFanGap', v)} />
          <NumberField id="gap-psu" label="PSU fan" unit="mm" value={a.psuFanGap} min={0} max={40} onChange={(v) => set('psuFanGap', v)} />
          <NumberField id="gap-rad" label="Radiator" unit="mm" value={a.radWallGap} min={0} max={40} onChange={(v) => set('radWallGap', v)} hint="0 = fans screwed to the panel" />
          <NumberField id="gap-plenum" label="Plenum" unit="mm" value={a.radPlenumGap} min={0} max={60} onChange={(v) => set('radPlenumGap', v)} hint="Air space behind a radiator that blows into or pulls from the case" />
        </Grid>
        <p className="muted small">The solver also tries each layout with 6 mm and 12 mm more on every gap; the airflow priority decides whether that is worth the size.</p>
      </Section>

      <Section title="Loss coefficients">
        <Grid cols={3}>
          <NumberField id="k-rad" label="Radiator core" value={a.radLossK} min={1} max={60} step={0.5} onChange={(v) => set('radLossK', v)} hint="ζ at 27 mm core thickness, scaled linearly with thickness" />
          <NumberField id="k-fin" label="Air cooler fins" value={a.finStackLossK} min={1} max={60} step={0.5} onChange={(v) => set('finStackLossK', v)} />
          <NumberField id="k-psu" label="PSU internals" value={a.psuLossK} min={0.5} max={30} step={0.5} onChange={(v) => set('psuLossK', v)} />
          <NumberField id="k-filter" label="Dust filter" value={a.dustFilterLossK} min={0} max={20} step={0.5} onChange={(v) => set('dustFilterLossK', v)} />
          <NumberField id="k-eff" label="Radiator ε" value={a.radEffectiveness} min={0.2} max={1} step={0.05} onChange={(v) => set('radEffectiveness', v)} hint="Heat-exchanger effectiveness, only used for the coolant estimate" />
        </Grid>
        <button type="button" className="btn ghost small" onClick={() => setCfg(produce(cfg, (d) => void (d.advanced = structuredClone(DEFAULT_ADVANCED))))}>
          Reset model values
        </button>
      </Section>

      <Section title="How the estimate works">
        <div className="prose">
          <p>
            Every fan is modelled with a straight-line curve between its rated free airflow and maximum static pressure, working against
            quadratic losses: the perforated panel, the radiator core or fin stack, a fan-to-panel proximity term and, for radiators that blow
            into the case, the plenum behind them.
          </p>
          <p>
            Panels use Idelchik's thin perforated-plate coefficient: ζ ≈ {perforatedPlateZeta(0.7).toFixed(2)} for a 70% open mesh,{' '}
            {perforatedPlateZeta(0.5).toFixed(2)} for 50% and {perforatedPlateZeta(0.4).toFixed(2)} for 40%, on the approach velocity.
          </p>
          <p>
            The case is one air zone. Fans that push in or pull out change the case pressure; passive vents settle the balance. The air
            leaving each heat source is warmer than the room by ΔT = P / (ρ·c<sub>p</sub>·Q), plus the case-air rise if it drew case air.
            That rise is compared with your allowed rise to get each path's headroom.
          </p>
          <p>
            This is a first-order estimate for ranking layouts, not CFD. Real fan curves bend, air leaks through seams and hot air short-circuits
            between neighbouring vents. Treat anything under about 120% headroom as worth prototyping before you cut metal.
          </p>
        </div>
      </Section>
    </div>
  );
}
