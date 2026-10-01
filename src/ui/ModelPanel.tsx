import { DEFAULT_ADVANCED } from '../model/presets';
import type { AdvancedModel, ComponentLimits, ComponentResistances, DesignConfig, LoadProfileId } from '../model/types';
import { perforatedPlateZeta } from '../solver/airflow';
import { produce } from '../state/config';
import { Grid, NumberField, Section } from './fields';

export function ModelPanel({ cfg, setCfg }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void }) {
  const a = cfg.advanced;
  const set = <K extends keyof AdvancedModel>(k: K, v: AdvancedModel[K]) => setCfg(produce(cfg, (d) => void (d.advanced[k] = v)));
  const setLoads = (l: LoadProfileId, part: 'cpu' | 'gpu', pct: number) => setCfg(produce(cfg, (d) => void (d.advanced.loads[l][part] = pct / 100)));
  const setLimit = (k: keyof ComponentLimits, v: number) => setCfg(produce(cfg, (d) => void (d.advanced.limits[k] = v)));
  const setRth = (k: keyof ComponentResistances, v: number) => setCfg(produce(cfg, (d) => void (d.advanced.rth[k] = v)));
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

      <Section title="Loads">
        <Grid cols={2}>
          <NumberField id="ld-gc" label="Gaming: CPU" unit="%" value={Math.round(a.loads.gaming.cpu * 100)} min={5} max={100} onChange={(v) => setLoads('gaming', 'cpu', v)} />
          <NumberField id="ld-gg" label="Gaming: GPU" unit="%" value={Math.round(a.loads.gaming.gpu * 100)} min={5} max={100} onChange={(v) => setLoads('gaming', 'gpu', v)} />
          <NumberField id="ld-fc" label="Full: CPU" unit="%" value={Math.round(a.loads.full.cpu * 100)} min={5} max={120} onChange={(v) => setLoads('full', 'cpu', v)} />
          <NumberField id="ld-fg" label="Full: GPU" unit="%" value={Math.round(a.loads.full.gpu * 100)} min={5} max={120} onChange={(v) => setLoads('full', 'gpu', v)} />
        </Grid>
        <p className="muted small">Share of the CPU's and card's rated power drawn at each load. Estimates: games rarely load a CPU fully; the card usually runs near its limit.</p>
      </Section>

      <Section title="Temperature limits (estimates)">
        <Grid cols={3}>
          <NumberField id="lim-cpu" label="CPU" unit="°C" value={a.limits.cpu} min={40} max={115} onChange={(v) => setLimit('cpu', v)} />
          <NumberField id="lim-gpu" label="GPU core" unit="°C" value={a.limits.gpuCore} min={40} max={110} onChange={(v) => setLimit('gpuCore', v)} />
          <NumberField id="lim-mem" label="GPU memory/VRM" unit="°C" value={a.limits.gpuMem} min={40} max={125} onChange={(v) => setLimit('gpuMem', v)} />
          <NumberField id="lim-psu" label="PSU intake air" unit="°C" value={a.limits.psuInlet} min={25} max={60} onChange={(v) => setLimit('psuInlet', v)} hint="Check your PSU's rated ambient for full power" />
          <NumberField id="lim-case" label="Case air" unit="°C" value={a.limits.caseAir} min={30} max={70} onChange={(v) => setLimit('caseAir', v)} hint="Around the board VRM, chipset and SSD" />
        </Grid>
        <p className="muted small">Typical throttle points, not taken from your parts' datasheets. Set them from your parts' specifications where you have them.</p>
      </Section>

      <Section title="Thermal resistances (estimates)">
        <Grid cols={3}>
          <NumberField id="r-cpu-c" label="CPU → coolant" unit="K/W" value={a.rth.cpuToCoolant} min={0.01} max={2} step={0.01} onChange={(v) => setRth('cpuToCoolant', v)} />
          <NumberField id="r-gpu-c" label="GPU → coolant" unit="K/W" value={a.rth.gpuToCoolant} min={0.01} max={1} step={0.01} onChange={(v) => setRth('gpuToCoolant', v)} />
          <NumberField id="r-cpu-a" label="CPU → air" unit="K/W" value={a.rth.cpuToAir} min={0.05} max={2} step={0.01} onChange={(v) => setRth('cpuToAir', v)} hint="Through an air cooler" />
          <NumberField id="r-gpu-a" label="GPU → air" unit="K/W" value={a.rth.gpuToAir} min={0.02} max={1} step={0.01} onChange={(v) => setRth('gpuToAir', v)} hint="Air-cooled cards" />
          <NumberField id="r-mem" label="Card memory → air" unit="K/W" value={a.rth.gpuMemToAir} min={0.05} max={3} step={0.05} onChange={(v) => setRth('gpuMemToAir', v)} hint="Per watt the AIO card's own fan handles" />
        </Grid>
      </Section>

      <Section title="Noise sources (estimates)">
        <Grid cols={2}>
          <NumberField id="pump-db" label="AIO pump" unit="dB(A)" value={a.pumpDb} min={0} max={45} step={0.5} onChange={(v) => set('pumpDb', v)} hint="Each AIO pump, at 1 m" />
          <NumberField id="psu-fanless" label="PSU fan off below" unit="%" value={Math.round(a.psuFanlessShare * 100)} min={0} max={100} onChange={(v) => set('psuFanlessShare', v / 100)} hint="Semi-passive PSUs keep their fan off at light load" />
        </Grid>
        <p className="muted small">Fans use their rated noise at full speed (or a typical value for their size) and the fan laws: +50·log₁₀ of the speed ratio.</p>
      </Section>

      <Section title="Loss coefficients">
        <Grid cols={3}>
          <NumberField id="k-rad" label="Radiator core" value={a.radLossK} min={1} max={60} step={0.5} onChange={(v) => set('radLossK', v)} hint="ζ at 27 mm core thickness, scaled linearly with thickness" />
          <NumberField id="k-fin" label="Air cooler fins" value={a.finStackLossK} min={1} max={60} step={0.5} onChange={(v) => set('finStackLossK', v)} />
          <NumberField id="k-psu" label="PSU internals" value={a.psuLossK} min={0.5} max={30} step={0.5} onChange={(v) => set('psuLossK', v)} />
          <NumberField id="k-filter" label="Dust filter" value={a.dustFilterLossK} min={0} max={20} step={0.5} onChange={(v) => set('dustFilterLossK', v)} />
          <NumberField id="k-eff" label="Radiator ε" value={a.radEffectiveness} min={0.2} max={1} step={0.05} onChange={(v) => set('radEffectiveness', v)} hint="Heat-exchanger effectiveness, only used for the coolant estimate" />
          <NumberField
            id="k-recirc"
            label="Internal fan re-ingestion"
            value={a.internalRecirculation}
            min={0}
            max={0.9}
            step={0.05}
            onChange={(v) => set('internalRecirculation', v)}
            hint="Share of a fan's intake that is its own exhaust when it moves case air inside the case (a tower cooler); fitted to the 3D simulation"
          />
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
            The case is a network of air zones (one, unless internal partitions split it). Fans that push in or pull out set each zone's
            pressure; passive vents, seams and openings between zones settle the balance. The air leaving each heat source is warmer than
            the air it drew by ΔT = P / (ρ·c<sub>p</sub>·Q). Each part's temperature is that air (or its coolant) plus its own rise, power
            × thermal resistance, compared with its own limit.
          </p>
          <p>
            This is a first-order estimate for ranking layouts, not CFD. Real fan curves bend, air leaks through seams and hot air short-circuits
            between neighbouring vents. Treat any part with less than about a third of its budget left as worth prototyping first.
          </p>
        </div>
      </Section>
    </div>
  );
}
