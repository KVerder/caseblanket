import { useState } from 'react';
import type { CatalogKind } from '../catalog/online';
import {
  BOARD_FORM_FACTORS,
  boardFromFormFactor,
  COOLERS,
  FANS,
  genericRadiator,
  GPUS,
  PSU_FORM_FACTORS,
  psuFromFormFactor,
} from '../model/presets';
import type { BoardFormFactor, DesignConfig, PsuFormFactor, RadiatorSpec, SourceInfo } from '../model/types';
import { produce } from '../state/config';
import { CatalogDialog } from './CatalogDialog';
import { Grid, NumberField, Section, Segmented, Select, Toggle } from './fields';

const PROV_LABEL: Record<SourceInfo['provenance'], string> = {
  standard: 'Standard',
  catalog: 'Catalogue',
  unverified: 'Unverified',
  estimate: 'Estimate',
  user: 'Your values',
};

export function SourceBadge({ source }: { source: SourceInfo }) {
  return (
    <span className={`badge prov-${source.provenance}`} title={source.note ?? ''}>
      {PROV_LABEL[source.provenance]}
    </span>
  );
}

function SourceNote({ source }: { source: SourceInfo }) {
  if (!source.note && !source.url) return null;
  return (
    <p className="source-note">
      {source.provenance === 'unverified' && <strong>Check before building: </strong>}
      {source.note}{' '}
      {source.url && (
        <a href={source.url} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </p>
  );
}

/** Mark a part as user-edited and clear the "missing" flag of the field just typed in. */
const edited = (s: SourceInfo, field?: string): SourceInfo => ({
  provenance: 'user',
  url: s.url,
  note: s.provenance === 'user' ? s.note : `Edited — started from ${s.provenance} data. ${s.note ?? ''}`.trim(),
  missing: s.missing?.filter((m) => m !== field),
});
const miss = (s: SourceInfo, field: string) => !!s.missing?.includes(field);

function RadiatorFields(props: { rad: RadiatorSpec; onChange: (r: RadiatorSpec) => void; idPrefix: string }) {
  const { rad } = props;
  const size = rad.fanCount * rad.fan.size;
  const set = (patch: Partial<RadiatorSpec>) => props.onChange({ ...rad, ...patch });
  return (
    <>
      <Select
        id={`${props.idPrefix}-size`}
        label="Radiator size"
        value={String(size)}
        options={[120, 140, 240, 280, 360, 420].map((s) => ({ value: String(s), label: `${s} mm` }))}
        onChange={(v) => props.onChange({ ...genericRadiator(Number(v), rad.coreThickness, rad.fan.size === 120 ? rad.fan : FANS.generic120), portClearance: rad.portClearance })}
      />
      <Grid cols={3}>
        <NumberField id={`${props.idPrefix}-len`} label="Length" unit="mm" value={rad.length} min={100} max={600} onChange={(v) => set({ length: v })} />
        <NumberField id={`${props.idPrefix}-wid`} label="Width" unit="mm" value={rad.width} min={80} max={200} onChange={(v) => set({ width: v })} />
        <NumberField id={`${props.idPrefix}-core`} label="Core" unit="mm" value={rad.coreThickness} min={15} max={80} onChange={(v) => set({ coreThickness: v })} hint="Radiator thickness without fans" />
        <NumberField id={`${props.idPrefix}-fant`} label="Fan thick." unit="mm" value={rad.fan.thickness} min={10} max={40} onChange={(v) => set({ fan: { ...rad.fan, thickness: v } })} />
        <NumberField id={`${props.idPrefix}-port`} label="Port space" unit="mm" value={rad.portClearance} min={0} max={80} onChange={(v) => set({ portClearance: v })} hint="Room past the tank end for fittings and the hose bend" />
        <NumberField id={`${props.idPrefix}-fans`} label="Fans" value={rad.fanCount} min={1} max={4} onChange={(v) => set({ fanCount: Math.round(v) })} />
      </Grid>
    </>
  );
}

export function PartsPanel({ cfg, setCfg }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void }) {
  const [catalog, setCatalog] = useState<CatalogKind | null>(null);
  const { board, cooler, gpu, psu, extras, caseFans } = cfg.parts;
  const up = (recipe: (d: DesignConfig) => void) => setCfg(produce(cfg, recipe));

  return (
    <div className="panel-stack">
      <p className="panel-intro">
        Pick parts from the library or search the online catalogue, then correct any dimension. Fields marked
        <span className="flag-dot" aria-hidden="true" /> came from a source that did not include them.
      </p>

      <Section title="Graphics card" aside={<SourceBadge source={gpu.source} />}>
        <div className="row-actions">
          <Select
            id="gpu-preset"
            label="Library"
            value={GPUS.some((g) => g.name === gpu.name) ? gpu.name : ''}
            options={[{ value: '', label: gpu.name || 'Custom card' }, ...GPUS.filter((g) => g.name !== gpu.name).map((g) => ({ value: g.name, label: g.name }))].filter(
              (o, i, a) => a.findIndex((x) => x.value === o.value) === i,
            )}
            onChange={(v) => {
              const g = GPUS.find((x) => x.name === v);
              if (g) up((d) => void (d.parts.gpu = structuredClone(g)));
            }}
          />
          <button type="button" className="btn ghost" onClick={() => setCatalog('video-card')}>
            Search online
          </button>
        </div>
        <SourceNote source={gpu.source} />
        <Segmented
          label="Mounting"
          value={cfg.prefs.gpuMount}
          options={[
            { value: 'slot', label: 'In the board slot', title: 'Card sits directly in the motherboard x16 slot, perpendicular to the board' },
            { value: 'riser', label: 'Riser cable', title: 'Card connects through a PCIe riser, so it can lie flat or sit behind the board' },
            { value: 'any', label: 'Try both' },
          ]}
          onChange={(v) => up((d) => void (d.prefs.gpuMount = v))}
        />
        {cfg.prefs.gpuMount !== 'slot' && (
          <NumberField id="gpu-riser" label="Riser cable length" unit="mm" value={cfg.prefs.riserLength} min={50} max={600} step={10} onChange={(v) => up((d) => void (d.prefs.riserLength = v))} />
        )}
        <Segmented
          label="Cooling"
          value={gpu.cooling}
          options={[
            { value: 'aio', label: 'AIO liquid' },
            { value: 'air', label: 'Air' },
          ]}
          onChange={(v) =>
            up((d) => {
              d.parts.gpu.cooling = v;
              if (v === 'aio' && !d.parts.gpu.radiator) d.parts.gpu.radiator = genericRadiator(240);
              if (v === 'air') d.parts.gpu.cardFan = true;
            })
          }
        />
        <Grid cols={3}>
          <NumberField id="gpu-len" label="Length" unit="mm" value={gpu.length} min={120} max={400} onChange={(v) => up((d) => void ((d.parts.gpu.length = v), (d.parts.gpu.source = edited(d.parts.gpu.source, 'length'))))} />
          <NumberField id="gpu-h" label="Height" unit="mm" flagged={miss(gpu.source, 'height')} value={gpu.height} min={60} max={200} onChange={(v) => up((d) => void ((d.parts.gpu.height = v), (d.parts.gpu.source = edited(d.parts.gpu.source, 'height'))))} hint="Fingers edge to top edge, shroud included" />
          <NumberField id="gpu-t" label="Thickness" unit="mm" flagged={miss(gpu.source, 'thickness')} value={gpu.thickness} min={15} max={90} onChange={(v) => up((d) => void ((d.parts.gpu.thickness = v), (d.parts.gpu.source = edited(d.parts.gpu.source, 'thickness'))))} hint="Backplate to front of cooler/pump" />
          <NumberField id="gpu-w" label="Board power" unit="W" flagged={miss(gpu.source, 'board power')} value={gpu.boardPowerW} min={30} max={1000} step={5} onChange={(v) => up((d) => void ((d.parts.gpu.boardPowerW = v), (d.parts.gpu.source = edited(d.parts.gpu.source, 'board power'))))} />
          <NumberField id="gpu-conn" label="Plug room" unit="mm" value={gpu.connectorClearance} min={0} max={80} onChange={(v) => up((d) => void (d.parts.gpu.connectorClearance = v))} hint="Straight cable length before the first bend at the power connector (35 mm is the commonly cited 12V-2x6 guidance)" />
          {gpu.cooling === 'aio' && (
            <NumberField id="gpu-share" label="To radiator" unit="%" value={Math.round(gpu.radiatorHeatShare * 100)} min={0} max={100} onChange={(v) => up((d) => void (d.parts.gpu.radiatorHeatShare = v / 100))} hint="Share of board power carried by the coolant; the rest is dumped by the card (VRM, memory)" />
          )}
        </Grid>
        <Toggle id="gpu-fan" label={gpu.cooling === 'aio' ? 'Card has its own fan (VRM/memory)' : 'Card fans'} checked={gpu.cardFan} onChange={(v) => up((d) => void (d.parts.gpu.cardFan = v))} />
        {gpu.cooling === 'aio' && gpu.radiator && (
          <>
            <h4 className="sub">GPU radiator & hoses</h4>
            {miss(gpu.source, 'radiator') && <p className="flag-note">Radiator outline is a generic estimate — check the card's spec sheet.</p>}
            <RadiatorFields idPrefix="gpu-rad" rad={gpu.radiator} onChange={(r) => up((d) => void ((d.parts.gpu.radiator = r), (d.parts.gpu.source = edited(d.parts.gpu.source, 'radiator'))))} />
            <Grid cols={3}>
              <NumberField id="gpu-tube" label="Hose length" unit="mm" flagged={miss(gpu.source, 'tube length')} value={gpu.tubeLength ?? 400} min={100} max={1000} onChange={(v) => up((d) => void ((d.parts.gpu.tubeLength = v), (d.parts.gpu.source = edited(d.parts.gpu.source, 'tube length'))))} />
              <NumberField id="gpu-tubeclr" label="Hose exit room" unit="mm" value={gpu.tubeClearance} min={0} max={100} onChange={(v) => up((d) => void (d.parts.gpu.tubeClearance = v))} />
              <Select id="gpu-exit" label="Hoses leave" value={gpu.tubeExit} options={[{ value: 'end', label: 'Far end' }, { value: 'top', label: 'Top edge' }]} onChange={(v) => up((d) => void (d.parts.gpu.tubeExit = v))} />
            </Grid>
          </>
        )}
      </Section>

      <Section title="CPU & cooler" aside={<SourceBadge source={cooler.source} />}>
        <div className="row-actions">
          <Select
            id="cooler-preset"
            label="Library"
            value={COOLERS.some((c) => c.name === cooler.name) ? cooler.name : ''}
            options={[{ value: '', label: cooler.name || 'Custom cooler' }, ...COOLERS.filter((c) => c.name !== cooler.name).map((c) => ({ value: c.name, label: c.name }))]}
            onChange={(v) => {
              const c = COOLERS.find((x) => x.name === v);
              if (c) up((d) => void (d.parts.cooler = { ...structuredClone(c), cpuPowerW: d.parts.cooler.cpuPowerW }));
            }}
          />
          <button type="button" className="btn ghost" onClick={() => setCatalog('cpu-cooler')}>
            Search online
          </button>
        </div>
        <SourceNote source={cooler.source} />
        <Segmented
          label="Type"
          value={cooler.kind}
          options={[
            { value: 'air-downdraft', label: 'Low-profile', title: 'Top-down air cooler, fan facing the panel' },
            { value: 'air-tower', label: 'Tower' },
            { value: 'aio', label: 'AIO' },
          ]}
          onChange={(v) =>
            up((d) => {
              d.parts.cooler.kind = v;
              if (v === 'aio' && !d.parts.cooler.radiator) {
                d.parts.cooler.radiator = genericRadiator(240);
                d.parts.cooler.tubeLength = 400;
                d.parts.cooler.height = 50;
              }
            })
          }
        />
        <Grid cols={3}>
          <NumberField id="cpu-w" label="CPU power" unit="W" value={cooler.cpuPowerW} min={15} max={400} step={5} onChange={(v) => up((d) => void (d.parts.cooler.cpuPowerW = v))} hint="Sustained package power under your workload" />
          <NumberField id="cool-h" label={cooler.kind === 'aio' ? 'Pump height' : 'Height'} unit="mm" flagged={miss(cooler.source, 'height') || miss(cooler.source, 'pump height')} value={cooler.height} min={10} max={200} onChange={(v) => up((d) => void ((d.parts.cooler.height = v), (d.parts.cooler.source = edited(edited(d.parts.cooler.source, 'height'), 'pump height'))))} hint="Above the CPU, fan included" />
          {cooler.kind !== 'aio' && (
            <>
              <NumberField id="cool-d" label="Depth" unit="mm" flagged={miss(cooler.source, 'footprint')} value={cooler.depth} min={40} max={200} onChange={(v) => up((d) => void ((d.parts.cooler.depth = v), (d.parts.cooler.source = edited(d.parts.cooler.source, 'footprint'))))} hint="Along the board, away from the rear I/O edge" />
              <NumberField id="cool-w" label="Width" unit="mm" flagged={miss(cooler.source, 'footprint')} value={cooler.width} min={40} max={200} onChange={(v) => up((d) => void ((d.parts.cooler.width = v), (d.parts.cooler.source = edited(d.parts.cooler.source, 'footprint'))))} />
              <NumberField id="cool-fs" label="Fan size" unit="mm" value={cooler.fan.size} min={40} max={140} onChange={(v) => up((d) => void (d.parts.cooler.fan.size = v))} />
              <NumberField id="cool-ft" label="Fan thick." unit="mm" value={cooler.fan.thickness} min={10} max={30} onChange={(v) => up((d) => void (d.parts.cooler.fan.thickness = v))} />
            </>
          )}
        </Grid>
        <button type="button" className="btn ghost small" onClick={() => setCatalog('cpu')}>
          Look up a CPU's TDP
        </button>
        {cooler.kind === 'aio' && cooler.radiator && (
          <>
            <h4 className="sub">CPU radiator & hoses</h4>
            {miss(cooler.source, 'radiator dimensions') && <p className="flag-note">Radiator outline is a generic estimate — check the cooler's spec sheet.</p>}
            <RadiatorFields idPrefix="cpu-rad" rad={cooler.radiator} onChange={(r) => up((d) => void ((d.parts.cooler.radiator = r), (d.parts.cooler.source = edited(d.parts.cooler.source, 'radiator dimensions'))))} />
            <NumberField id="cpu-tube" label="Hose length" unit="mm" flagged={miss(cooler.source, 'tube length')} value={cooler.tubeLength ?? 400} min={100} max={1000} onChange={(v) => up((d) => void ((d.parts.cooler.tubeLength = v), (d.parts.cooler.source = edited(d.parts.cooler.source, 'tube length'))))} />
          </>
        )}
      </Section>

      <Section title="Motherboard" aside={<SourceBadge source={board.source} />}>
        <div className="row-actions">
          <Select
            id="board-ff"
            label="Form factor"
            value={board.formFactor}
            options={[
              ...Object.entries(BOARD_FORM_FACTORS).map(([k, f]) => ({ value: k as BoardFormFactor, label: `${f.label} (${f.edge} × ${f.depth})` })),
              { value: 'custom' as BoardFormFactor, label: 'Custom outline' },
            ]}
            onChange={(v) =>
              up((d) => {
                if (v === 'custom') d.parts.board.formFactor = 'custom';
                else d.parts.board = { ...boardFromFormFactor(v, d.parts.board.name), heatW: d.parts.board.heatW };
              })
            }
          />
          <button type="button" className="btn ghost" onClick={() => setCatalog('motherboard')}>
            Search online
          </button>
        </div>
        <SourceNote source={board.source} />
        <Grid cols={3}>
          <NumberField id="mb-edge" label="I/O edge" unit="mm" value={board.edge} min={100} max={340} onChange={(v) => up((d) => void ((d.parts.board.edge = v), (d.parts.board.formFactor = 'custom')))} />
          <NumberField id="mb-depth" label="Depth" unit="mm" value={board.depth} min={100} max={340} onChange={(v) => up((d) => void ((d.parts.board.depth = v), (d.parts.board.formFactor = 'custom')))} />
          <NumberField id="mb-comp" label="Tallest part" unit="mm" flagged={miss(board.source, 'component height')} value={board.componentHeight} min={5} max={80} onChange={(v) => up((d) => void ((d.parts.board.componentHeight = v), (d.parts.board.source = edited(d.parts.board.source, 'component height'))))} hint="RAM, rear I/O stack or VRM heatsink above the PCB, cooler excluded" />
          <NumberField id="mb-under" label="Underside" unit="mm" value={board.underside} min={2} max={20} onChange={(v) => up((d) => void (d.parts.board.underside = v))} hint="Standoffs, solder points and backplate" />
          <NumberField id="mb-sock" label="CPU stack" unit="mm" value={board.socketStack} min={0} max={20} onChange={(v) => up((d) => void (d.parts.board.socketStack = v))} hint="Socket + CPU height above the PCB before the cooler starts" />
          <NumberField id="mb-heat" label="Board heat" unit="W" value={board.heatW} min={0} max={150} onChange={(v) => up((d) => void (d.parts.board.heatW = v))} hint="VRM, chipset, RAM and SSDs" />
        </Grid>
      </Section>

      <Section title="Power supply" aside={<SourceBadge source={psu.source} />}>
        <div className="row-actions">
          <Select
            id="psu-ff"
            label="Form factor"
            value={psu.formFactor}
            options={[
              ...Object.entries(PSU_FORM_FACTORS).map(([k, f]) => ({ value: k as PsuFormFactor, label: `${f.label} (${f.width} × ${f.height} × ${f.length})` })),
              { value: 'custom' as PsuFormFactor, label: 'Custom' },
            ]}
            onChange={(v) =>
              up((d) => {
                if (v === 'custom') d.parts.psu.formFactor = 'custom';
                else d.parts.psu = { ...psuFromFormFactor(v, d.parts.psu.ratedW), efficiency: d.parts.psu.efficiency };
              })
            }
          />
          <button type="button" className="btn ghost" onClick={() => setCatalog('power-supply')}>
            Search online
          </button>
        </div>
        <SourceNote source={psu.source} />
        <Grid cols={3}>
          <NumberField id="psu-l" label="Length" unit="mm" flagged={!!psu.source.missing?.some((m) => m.startsWith('length'))} value={psu.length} min={60} max={220} onChange={(v) => up((d) => void ((d.parts.psu.length = v), (d.parts.psu.formFactor = 'custom'), (d.parts.psu.source = { ...edited(d.parts.psu.source), missing: d.parts.psu.source.missing?.filter((m) => !m.startsWith('length')) })))} hint="AC inlet to cable face" />
          <NumberField id="psu-w" label="Width" unit="mm" value={psu.width} min={30} max={200} onChange={(v) => up((d) => void ((d.parts.psu.width = v), (d.parts.psu.formFactor = 'custom')))} />
          <NumberField id="psu-h" label="Height" unit="mm" value={psu.height} min={20} max={120} onChange={(v) => up((d) => void ((d.parts.psu.height = v), (d.parts.psu.formFactor = 'custom')))} />
          <NumberField id="psu-rated" label="Rating" unit="W" value={psu.ratedW} min={100} max={2000} step={50} onChange={(v) => up((d) => void (d.parts.psu.ratedW = v))} />
          <NumberField id="psu-eff" label="Efficiency" unit="%" value={Math.round(psu.efficiency * 100)} min={60} max={99} onChange={(v) => up((d) => void (d.parts.psu.efficiency = v / 100))} />
          <NumberField id="psu-cable" label="Cable room" unit="mm" value={psu.cableClearance} min={0} max={100} onChange={(v) => up((d) => void (d.parts.psu.cableClearance = v))} hint="Space in front of the modular connectors" />
        </Grid>
        <Segmented
          label="PSU fan"
          value={psu.fanOn}
          options={[
            { value: 'face', label: 'On the large face' },
            { value: 'end', label: 'On the cable end' },
          ]}
          onChange={(v) => up((d) => void (d.parts.psu.fanOn = v))}
        />
      </Section>

      <Section title="Case fans" aside={<span className="muted">{caseFans.count ? `${caseFans.count} × ${caseFans.fan.size} mm` : 'none'}</span>} open={caseFans.count > 0}>
        <p className="muted small">
          Fans on a panel of their own, besides the cooler, card, PSU and radiator fans. The solver places each against a vented panel and, on Auto, tries both
          directions and keeps the one that cools the tightest part best.
        </p>
        <Segmented
          label="Fans"
          value={String(caseFans.count)}
          options={[
            { value: '0', label: 'None' },
            { value: '1', label: '1 × 120 mm' },
            { value: '2', label: '2 × 120 mm' },
          ]}
          onChange={(v) => up((d) => void (d.parts.caseFans.count = Number(v)))}
        />
        {caseFans.count > 0 && (
          <>
            <Segmented
              label="Direction"
              value={caseFans.direction}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'intake', label: 'Intake' },
                { value: 'exhaust', label: 'Exhaust' },
              ]}
              onChange={(v) => up((d) => void (d.parts.caseFans.direction = v))}
            />
            <Select
              id="case-fan-model"
              label="Fan"
              value={caseFans.fan.thickness === 15 ? 'slim' : caseFans.fan.acoustics ? 'a12x25' : 'generic'}
              options={[
                { value: 'a12x25', label: '120 × 25 mm, 2000 rpm (NF-A12x25 class)' },
                { value: 'slim', label: '120 × 15 mm slim, 1850 rpm (NF-A12x15 class)' },
                { value: 'generic', label: '120 × 25 mm, generic' },
              ]}
              onChange={(v) => up((d) => void (d.parts.caseFans.fan = structuredClone(v === 'slim' ? FANS.a12x15 : v === 'generic' ? FANS.generic120 : FANS.a12x25)))}
            />
            <Grid cols={2}>
              <NumberField id="case-fan-flow" label="Airflow" unit="m³/h" value={caseFans.fan.maxAirflowM3h} min={20} max={300} onChange={(v) => up((d) => void (d.parts.caseFans.fan.maxAirflowM3h = v))} hint="Free-air rating" />
              <NumberField id="case-fan-p" label="Pressure" unit="mm H₂O" value={caseFans.fan.maxPressureMmH2O} min={0.3} max={10} step={0.1} onChange={(v) => up((d) => void (d.parts.caseFans.fan.maxPressureMmH2O = v))} hint="Static pressure at zero flow" />
            </Grid>
          </>
        )}
      </Section>

      <Section title="Other parts" aside={<span className="muted">{extras.length ? `${extras.length} item${extras.length > 1 ? 's' : ''}` : 'none'}</span>} open={extras.length > 0}>
        <p className="muted small">Drives, fan hubs, a 2.5" SSD — any box the case must hold. They can sit in any orientation.</p>
        {extras.map((e, i) => (
          <div className="extra-row" key={e.id}>
            <label className="field text" htmlFor={`extra-name-${e.id}`}>
              <span className="field-label">Name</span>
              <input id={`extra-name-${e.id}`} value={e.name} onChange={(ev) => up((d) => void (d.parts.extras[i].name = ev.target.value))} />
            </label>
            <Grid cols={3}>
              <NumberField id={`extra-x-${e.id}`} label="L" unit="mm" value={e.x} min={5} max={400} onChange={(v) => up((d) => void (d.parts.extras[i].x = v))} />
              <NumberField id={`extra-y-${e.id}`} label="W" unit="mm" value={e.y} min={5} max={400} onChange={(v) => up((d) => void (d.parts.extras[i].y = v))} />
              <NumberField id={`extra-z-${e.id}`} label="H" unit="mm" value={e.z} min={2} max={400} onChange={(v) => up((d) => void (d.parts.extras[i].z = v))} />
              <NumberField id={`extra-heat-${e.id}`} label="Heat" unit="W" value={e.heatW} min={0} max={200} onChange={(v) => up((d) => void (d.parts.extras[i].heatW = v))} />
            </Grid>
            <button type="button" className="btn ghost small danger" onClick={() => up((d) => void d.parts.extras.splice(i, 1))}>
              Remove {e.name}
            </button>
          </div>
        ))}
        {extras.length < 4 && (
          <div className="row-actions wrap">
            <button type="button" className="btn ghost small" onClick={() => up((d) => void d.parts.extras.push({ id: crypto.randomUUID().slice(0, 8), name: '2.5" SSD', x: 100, y: 70, z: 7, heatW: 3 }))}>
              Add 2.5" SSD
            </button>
            <button type="button" className="btn ghost small" onClick={() => up((d) => void d.parts.extras.push({ id: crypto.randomUUID().slice(0, 8), name: 'Custom box', x: 60, y: 40, z: 20, heatW: 0 }))}>
              Add custom box
            </button>
          </div>
        )}
      </Section>

      {catalog && <CatalogDialog kind={catalog} cfg={cfg} setCfg={setCfg} onClose={() => setCatalog(null)} />}
    </div>
  );
}
