import { useMemo } from 'react';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { ALL_FLOW, applyFlow, FLOW_ELEMENTS, NO_FLOW, type FlowKey } from '../solver/flow';
import { solveWith } from '../solver/structures';
import { produce } from '../state/config';
import { Section, Segmented, Select, Toggle } from './fields';

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;

interface Gain {
  /** Headroom change on the tightest part, K; noise change, dB; the part that gains most. */
  k: number;
  db: number;
  best: { label: string; k: number };
}

function gainText(g: Gain): string {
  const parts: string[] = [];
  if (Math.abs(g.k) >= 0.05) parts.push(`${signed(g.k)} K on the tightest part`);
  if (g.best.k >= 0.05 && (Math.abs(g.k) < 0.05 || g.best.label !== '')) parts.push(`up to ${signed(g.best.k)} K (${g.best.label})`);
  if (Math.abs(g.db) >= 0.05) parts.push(`${signed(g.db)} dB`);
  return parts.length ? `On this design: ${parts.join(', ')}.` : 'Nothing measurable on this design (no fan it applies to).';
}

/**
 * Flow: every structure that shapes the air, as switches. A switched-on structure is part of the
 * design: the airflow model rates it (estimates, see solver/flow.ts), the 3D simulation includes
 * it where its size allows, and the printed pieces have it. Next to each switch that is off, what
 * it would do for the selected design (its fans re-solved within the same noise budget).
 */
export function FlowPanel({ cfg, setCfg, design }: { cfg: DesignConfig; setCfg: (c: DesignConfig) => void; design: Design | null }) {
  const p = cfg.prefs;
  const flow = { ...NO_FLOW, ...(p.flow ?? {}) };
  const up = (recipe: (d: DesignConfig) => void) => setCfg(produce(cfg, recipe));
  const setFlow = (k: FlowKey, v: boolean) => up((d) => void (d.prefs.flow = { ...NO_FLOW, ...(d.prefs.flow ?? {}), [k]: v }));

  // What switching each structure on would do for the selected design (loss-term structures only).
  const gains = useMemo(() => {
    if (!design) return {} as Record<string, Gain | null>;
    const r = design.recipe;
    const base = solveWith(r);
    const out: Record<string, Gain | null> = {};
    for (const e of FLOW_ELEMENTS) {
      if (flow[e.key] || e.key === 'deepPlenums' || e.key === 'deflectors') continue;
      const net = applyFlow(r.net, { ...flow, [e.key]: true }, r.flowFans ?? [], r.openRatio ?? 0.5, r.holeD ?? 6);
      const after = solveWith({ ...r, net });
      // The tightest part, and the part that gains most.
      let best = { label: '', k: 0 };
      for (const c of after.flow.components) {
        const b0 = base.flow.components.find((x) => x.id === c.id);
        if (b0 && c.headroomK - b0.headroomK > best.k) best = { label: c.label, k: c.headroomK - b0.headroomK };
      }
      out[e.key] = { k: after.flow.worstHeadroomK - base.flow.worstHeadroomK, db: after.noise.spl - base.noise.spl, best };
    }
    return out;
  }, [design, flow.ducts, flow.bellMouths, flow.diffusers, flow.roundedHoles, flow.radiusedTurns, flow.deepPlenums, flow.deflectors]);

  return (
    <div className="panel-stack flow-panel">
      <p className="panel-intro">
        Structures that shape the air. Switched on, each is part of the design: the airflow model rates it, the 3D simulation includes it where it is big enough for
        its grid, and the printed pieces have it. Off, it shows what it would do for the selected design (its fans solved again within the same noise budget). The
        coefficients are textbook-style estimates until a reference simulation or a measured prototype confirms them.
      </p>

      <Section title="Chambers">
        <Toggle id="flow-chambers" label="Multi-chamber (internal walls where they help)" checked={p.chambers !== 'single'} onChange={(v) => up((d) => void (d.prefs.chambers = v ? 'auto' : 'single'))} />
        <p className="muted small">The solver tries walls between the hot parts and keeps them only when they lift the tightest part by more than the model's uncertainty.</p>
      </Section>

      <Section title="Structures">
        <div className="row-actions">
          <button type="button" className="btn ghost small" onClick={() => up((d) => void (d.prefs.flow = { ...ALL_FLOW }))}>
            All on
          </button>
          <button type="button" className="btn ghost small" onClick={() => up((d) => void (d.prefs.flow = { ...NO_FLOW }))}>
            All off
          </button>
        </div>
        <ul className="flow-list">
          {FLOW_ELEMENTS.map((e) => {
            const g = gains[e.key];
            return (
              <li key={e.key}>
                <Toggle id={`flow-${e.key}`} label={e.label} checked={flow[e.key]} onChange={(v) => setFlow(e.key, v)} />
                <span className="muted small">
                  {e.what} <em>{e.where}.</em>{' '}
                  {flow[e.key]
                    ? ''
                    : e.key === 'deepPlenums'
                      ? 'Changes the layout: switch it on to see.'
                      : e.key === 'deflectors'
                        ? 'Shows in the 3D simulation.'
                        : g
                          ? gainText(g)
                          : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Fans and radiators">
        <Toggle id="flow-tilt" label="Tilted radiators and case fans (15°, 30°, 45°)" checked={p.allowTilt} onChange={(v) => up((d) => void (d.prefs.allowTilt = v))} />
        <Segmented
          label="Case fans"
          value={String(cfg.parts.caseFans.count)}
          options={[
            { value: '0', label: 'None' },
            { value: '1', label: '1 × 120 mm' },
            { value: '2', label: '2 × 120 mm' },
          ]}
          onChange={(v) => up((d) => void (d.parts.caseFans.count = Number(v)))}
        />
        <Select
          id="flow-raddir"
          label="Radiator fans"
          value={p.radDirection}
          options={[
            { value: 'auto', label: 'Try intake and exhaust' },
            { value: 'intake', label: 'Intake' },
            { value: 'exhaust', label: 'Exhaust' },
          ]}
          onChange={(v) => up((d) => void (d.prefs.radDirection = v))}
        />
      </Section>
    </div>
  );
}
