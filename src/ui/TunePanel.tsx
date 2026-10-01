import { closeRadius } from '../solver/shrinkwrap';
import { FINISHES, MATERIALS, VENT_STYLES } from '../model/presets';
import type { DesignConfig, PanelName, Preferences, TopologyId } from '../model/types';
import { produce } from '../state/config';
import { Grid, NumberField, Section, Segmented, Select, Slider, Toggle } from './fields';

const TOPO: { id: TopologyId; label: string; hint: string }[] = [
  { id: 'flat', label: 'Flat', hint: 'All parts side by side in one layer, GPU on a riser. Usually the thinnest.' },
  { id: 'sandwich', label: 'Sandwich', hint: 'GPU behind the motherboard on a riser. Usually the smallest volume.' },
  { id: 'direct', label: 'Direct slot', hint: 'GPU plugged straight into the board — no riser.' },
  { id: 'direct-stack', label: 'Direct + stack', hint: 'Direct slot, with PSU or radiators stacked behind the board.' },
];

const PANELS: PanelName[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

export function TunePanel({ cfg, setCfg }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void }) {
  const p = cfg.prefs;
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setCfg(produce(cfg, (d) => void (d.prefs[k] = v)));
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="panel-stack">
      <Section title="Priorities">
        <Slider
          id="pri-air"
          label="Airflow vs. compactness"
          value={p.airflowPriority}
          min={0}
          max={1}
          step={0.05}
          left="Smallest case"
          right="Coolest air"
          format={(v) => (v < 0.34 ? 'Compact first' : v > 0.66 ? 'Airflow first' : 'Balanced')}
          onChange={(v) => set('airflowPriority', v)}
        />
        <Slider
          id="pri-thin"
          label="Thinness vs. total volume"
          value={p.thinnessPriority}
          min={0}
          max={1}
          step={0.05}
          left="Least litres"
          right="Thinnest"
          format={(v) => (v < 0.34 ? 'Volume first' : v > 0.66 ? 'Thickness first' : 'Both')}
          onChange={(v) => set('thinnessPriority', v)}
        />
        <Slider
          id="pri-floor"
          label="Minimum airflow"
          value={p.minAirflowAdequacy}
          min={0.4}
          max={1.5}
          step={0.05}
          left="Accept tight"
          right="Demand headroom"
          format={pct}
          onChange={(v) => set('minAirflowAdequacy', v)}
        />
        <p className="muted small">
          Designs whose weakest heat path gets less than this share of the air it needs to stay within the temperature target drop to the
          bottom of the list.
        </p>
      </Section>

      <Section title="Shape & finish">
        <Segmented
          label="Shell"
          value={p.shell}
          options={[
            { value: 'wrap', label: 'Shrinkwrap' },
            { value: 'box', label: 'Straight box' },
          ]}
          onChange={(v) => set('shell', v)}
        />
        {p.shell === 'wrap' && (
          <>
            <Slider
              id="organic"
              label="Smoothness"
              value={p.organic}
              min={0}
              max={1}
              step={0.05}
              left="Tight, straight faces"
              right="Smooth, sweeping"
              format={(v) => `bridges ${Math.round(2 * closeRadius(v))} mm`}
              onChange={(v) => set('organic', v)}
            />
            <p className="muted small">
              The shell is pulled tight around the parts, their air gaps, the AIO hoses and the GPU power cable. Smoothness bridges
              gaps between parts up to the width shown and rounds the edges; the results show the litres it adds.
            </p>
          </>
        )}
        <Segmented
          label="Edges"
          value={p.edgeStyle}
          options={[
            { value: 'round', label: 'Rounded' },
            { value: 'chamfer', label: 'Chamfered' },
          ]}
          onChange={(v) => set('edgeStyle', v)}
        />
        <Slider id="edge-r" label="Edge radius" value={p.edgeRadius} min={0} max={40} step={1} format={(v) => `${v} mm`} onChange={(v) => set('edgeRadius', v)} />
        {p.edgeRadius > p.wallThickness + 1 && (
          <p className="muted small">Radii larger than the wall eat into the corners inside; the case grows where a part sits in a corner.</p>
        )}
        <Segmented
          label="Stands as"
          value={p.orientation}
          options={[
            { value: 'tower', label: 'Slim tower' },
            { value: 'console', label: 'Flat console' },
          ]}
          onChange={(v) => set('orientation', v)}
        />
        <Grid>
          <Select
            id="material"
            label="Material"
            value={p.materialId}
            options={MATERIALS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) =>
              setCfg(
                produce(cfg, (d) => {
                  d.prefs.materialId = v;
                  d.prefs.wallThickness = MATERIALS.find((m) => m.id === v)?.defaultWall ?? d.prefs.wallThickness;
                }),
              )
            }
          />
          <NumberField id="wall" label="Wall" unit="mm" value={p.wallThickness} min={0.5} max={8} step={0.1} onChange={(v) => set('wallThickness', v)} />
        </Grid>
        {MATERIALS.find((m) => m.id === p.materialId)?.print && (
          <>
            <span className="field-label">Printer build volume</span>
            <Grid cols={3}>
              {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <NumberField
                  key={axis}
                  id={`bv-${axis}`}
                  label={axis}
                  unit="mm"
                  value={p.buildVolume[i]}
                  min={100}
                  max={1000}
                  onChange={(v) => set('buildVolume', p.buildVolume.map((b, j) => (j === i ? v : b)) as [number, number, number])}
                />
              ))}
            </Grid>
            <p className="muted small">The shell is cut into pieces that fit; their glued joints count as a small leak in the airflow model.</p>
          </>
        )}
        <div className="field">
          <span className="field-label">Finish</span>
          <div className="swatches" role="radiogroup" aria-label="Finish colour">
            {FINISHES.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={p.finish === f.id}
                aria-label={f.label}
                title={f.label}
                className={`swatch${p.finish === f.id ? ' on' : ''}`}
                style={{ background: f.id }}
                onClick={() => set('finish', f.id)}
              />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Vents & fans">
        <Select id="vent-style" label="Perforation" value={p.ventStyleId} options={VENT_STYLES.map((v) => ({ value: v.id, label: v.label }))} onChange={(v) => set('ventStyleId', v)} />
        <div className="field">
          <span className="field-label">Panels that may be vented</span>
          <div className="chips">
            {PANELS.map((name) => (
              <label key={name} className={`chip${p.ventPanels[name] ? ' on' : ''}`} htmlFor={`vent-${name}`}>
                <input
                  id={`vent-${name}`}
                  type="checkbox"
                  checked={p.ventPanels[name]}
                  onChange={(e) => setCfg(produce(cfg, (d) => void (d.prefs.ventPanels[name] = e.target.checked)))}
                />
                {name}
              </label>
            ))}
          </div>
        </div>
        <Slider id="passive" label="Passive venting" value={p.passiveVentCoverage} min={0} max={0.8} step={0.05} format={pct} onChange={(v) => set('passiveVentCoverage', v)} left="Solid panels" right="Mostly mesh" />
        <Segmented
          label="Radiator fans"
          value={p.radDirection}
          options={[
            { value: 'auto', label: 'Best', title: 'Try intake and exhaust, keep whichever runs cooler' },
            { value: 'intake', label: 'Intake' },
            { value: 'exhaust', label: 'Exhaust' },
          ]}
          onChange={(v) => set('radDirection', v)}
        />
        <Toggle id="slim" label="Allow 15 mm slim radiator fans" checked={p.allowSlimFans} onChange={(v) => set('allowSlimFans', v)} />
        <Toggle id="filters" label="Dust filters on vents" checked={p.dustFilters} onChange={(v) => set('dustFilters', v)} />
      </Section>

      <Section title="Layouts to try">
        <Segmented
          label="Graphics card mounting"
          value={p.gpuMount}
          options={[
            { value: 'slot', label: 'Board slot' },
            { value: 'riser', label: 'Riser' },
            { value: 'any', label: 'Try both' },
          ]}
          onChange={(v) => set('gpuMount', v)}
        />
        <div className="chips">
          {TOPO.map((t) => {
            const usable = p.gpuMount === 'any' || (p.gpuMount === 'slot') === t.id.startsWith('direct');
            return (
            <label key={t.id} className={`chip${p.topologies[t.id] && usable ? ' on' : ''}${usable ? '' : ' off'}`} htmlFor={`topo-${t.id}`} title={usable ? t.hint : `Needs the graphics card ${t.id.startsWith('direct') ? 'in the board slot' : 'on a riser'}`}>
              <input
                id={`topo-${t.id}`}
                type="checkbox"
                disabled={!usable}
                checked={p.topologies[t.id] && usable}
                onChange={(e) =>
                  setCfg(
                    produce(cfg, (d) => {
                      d.prefs.topologies[t.id] = e.target.checked;
                      if (!Object.values(d.prefs.topologies).some(Boolean)) d.prefs.topologies.flat = true;
                    }),
                  )
                }
              />
              {t.label}
            </label>
            );
          })}
        </div>
        <Toggle id="psu-back" label="PSU power socket on the back panel" checked={p.psuInletAtBack} onChange={(v) => set('psuInletAtBack', v)} hint="Off lets the PSU sit anywhere (often a smaller case), fed by an internal IEC extension to a panel socket: mains wiring you do yourself" />
        <Grid>
          {p.gpuMount !== 'slot' && (
            <NumberField id="riser" label="Riser cable" unit="mm" value={p.riserLength} min={50} max={600} step={10} onChange={(v) => set('riserLength', v)} />
          )}
          <NumberField id="tol" label="Clearance" unit="mm" value={p.tolerance} min={0} max={10} step={0.5} onChange={(v) => set('tolerance', v)} hint="Gap kept between any two parts" />
        </Grid>
      </Section>

      <Section title="Size limits" open={p.maxWidth + p.maxHeight + p.maxDepth > 0}>
        <p className="muted small">External limits, e.g. a shelf or a TV stand. Leave 0 for no limit.</p>
        <Grid cols={3}>
          <NumberField id="max-w" label="Max width" unit="mm" value={p.maxWidth} min={0} max={2000} step={5} onChange={(v) => set('maxWidth', v)} />
          <NumberField id="max-h" label="Max height" unit="mm" value={p.maxHeight} min={0} max={2000} step={5} onChange={(v) => set('maxHeight', v)} />
          <NumberField id="max-d" label="Max depth" unit="mm" value={p.maxDepth} min={0} max={2000} step={5} onChange={(v) => set('maxDepth', v)} />
        </Grid>
      </Section>

      <Section title="Internal chambers">
        <Segmented
          label="Partitions"
          value={p.chambers}
          options={[
            { value: 'auto', label: 'Add when they help' },
            { value: 'single', label: 'One chamber' },
          ]}
          onChange={(v) => set('chambers', v)}
        />
        <p className="muted small">
          Printed walls that split the case into separate air chambers, so one part's hot air can't reach another's intake. The solver
          tries every wall that fits between the parts and keeps one only if it lifts the tightest part by more than 5 % of its budget.
        </p>
      </Section>

      <Section title="Noise">
        <Segmented
          label="Fan speeds"
          value={p.noiseMode}
          options={[
            { value: 'budget', label: 'Coolest within budget' },
            { value: 'quiet', label: 'Quietest that stays safe' },
          ]}
          onChange={(v) => set('noiseMode', v)}
        />
        {p.noiseMode === 'budget' && (
          <Slider
            id="noise-budget"
            label="Noise budget"
            value={p.noiseBudgetDb}
            min={18}
            max={45}
            step={1}
            left="Whisper"
            right="Loud"
            format={(v) => `${v} dB(A)`}
            onChange={(v) => set('noiseBudgetDb', v)}
          />
        )}
        <p className="muted small">
          {p.noiseMode === 'budget'
            ? 'The solver sets every fan’s speed to keep the tightest part as cool as possible without the case getting louder than this, at 1 m on a desk.'
            : 'The solver slows every fan as far as it can while every part stays under its limit.'}{' '}
          Noise is an estimate from fan ratings (free field, 1 m), not a measurement.
        </p>
      </Section>

      <Section title="Thermal targets">
        <Segmented
          label="Rate the design at"
          value={p.loadProfile}
          options={[
            { value: 'gaming', label: 'Typical gaming' },
            { value: 'full', label: 'Sustained full load' },
          ]}
          onChange={(v) => set('loadProfile', v)}
        />
        <Grid>
          <NumberField id="ambient" label="Room" unit="°C" value={p.ambientC} min={0} max={45} onChange={(v) => set('ambientC', v)} />
        </Grid>
        <p className="muted small">
          Each part is rated against its own temperature limit (Model tab). Results show both loads; this choice decides which one ranks
          the designs.
        </p>
      </Section>
    </div>
  );
}
