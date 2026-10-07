import { useEffect, useMemo, useRef, useState } from 'react';
import type { CfdThermal } from '../cfd/components';
import type { DesignConfig, LoadProfileId } from '../model/types';
import { TOPOLOGY_LABELS, type Design } from '../solver/evaluate';
import { frontier, rescoreCandidates, sizeOf, type SizeAxis } from '../solver/frontier';
import { CfdClient } from '../state/cfdClient';
import { SolverClient } from '../state/solverClient';
import { ALL_FLOW, NO_FLOW } from '../solver/flow';
import { LOAD_LABEL } from './ResultsPanel';

interface Pt {
  d: Design;
  id: string;
  size: number;
  /** The plotted value, higher is better: margin (share of budget) or −noise (dB). */
  margin: number;
  /** Can't meet the noise budget (thermal view) or can't keep every part under its limit (noise view). */
  out: boolean;
}

type YMode = 'margin' | 'noise';

const PAD = { l: 48, r: 18, t: 22, b: 40 };
const pct = (m: number) => `${Math.round(m * 100)} %`;

/** Range of fan speeds a design runs at, e.g. "40–80 %". */
function speedRange(d: Design, load: LoadProfileId): string {
  const v = Object.values(d.noise[load].speeds);
  if (!v.length) return '—';
  const lo = Math.round(Math.min(...v) * 100);
  const hi = Math.round(Math.max(...v) * 100);
  return lo === hi ? `${lo} %` : `${lo}–${hi} %`;
}

/** Round, readable tick steps covering [lo, hi]. */
function ticks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/**
 * The design space: every valid layout the solver evaluated, size against the tightest part's
 * thermal margin, with the trade-off frontier. Pick any point; slide along the frontier.
 */
export function Explorer({
  space,
  selected,
  cfg,
  onSelect,
}: {
  space: Design[];
  selected: Design;
  cfg: DesignConfig;
  onSelect: (id: string) => void;
}) {
  const [axis, setAxis] = useState<SizeAxis>(cfg.prefs.thinnessPriority > 0.5 ? 'thickness' : 'volume');
  const [hover, setHover] = useState<Pt | null>(null);
  const [yMode, setYMode] = useState<YMode>('margin');
  const load = cfg.prefs.loadProfile;
  const [table, setTable] = useState(false);
  const [check, setCheck] = useState<{ running: boolean; done: number; total: number; results: { id: string; thermal: CfdThermal }[]; error?: string }>({
    running: false,
    done: 0,
    total: 0,
    results: [],
  });
  // 3D scores of a spread of designs: the airflow model's ranking disagrees with the 3D sim.
  const [score, setScore] = useState<{ running: boolean; done: number; total: number; results: Record<string, CfdThermal>; error?: string }>({
    running: false,
    done: 0,
    total: 0,
    results: {},
  });
  const [view3d, setView3d] = useState(false);
  // The same parts solved with every flow structure on (or off, if they are on now): its frontier, overlaid.
  const flowOn = !!cfg.prefs.flow && Object.values(cfg.prefs.flow).every(Boolean);
  const [alt, setAlt] = useState<{ running: boolean; space?: Design[]; error?: string }>({ running: false });
  const altClient = useRef<SolverClient | null>(null);
  const client = useRef<CfdClient | null>(null);
  const scoreClient = useRef<CfdClient | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  // Draw at the container's own pixel width so text stays at its real size.
  const box = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = Math.round(Math.min(320, Math.max(220, W * 0.6)));

  // New results invalidate the 3D checks.
  useEffect(() => {
    client.current?.stop();
    scoreClient.current?.stop();
    setCheck({ running: false, done: 0, total: 0, results: [] });
    setScore({ running: false, done: 0, total: 0, results: {} });
    setView3d(false);
    setAlt({ running: false });
  }, [space]);
  useEffect(
    () => () => {
      client.current?.stop();
      scoreClient.current?.stop();
    },
    [],
  );
  // Every 3D result so far (the quick check and the frontier scoring run the same short simulation).
  const scored3d: Record<string, CfdThermal> = { ...score.results };
  for (const r of check.results) scored3d[r.id] ??= r.thermal;
  const in3d = view3d && yMode === 'margin' && Object.keys(scored3d).length > 0;
  // Parts that dump their heat into the case air: the zone model can't rank those layouts reliably.
  const caseAirHeated = cfg.parts.cooler.kind === 'air-tower' || cfg.parts.gpu.cooling === 'air';

  const toPt = (d: Design): Pt => {
    const n = d.noise[load];
    if (yMode === 'noise') {
      const q = n.quietDb;
      return { d, id: d.id, size: sizeOf(d, axis), margin: Number.isFinite(q) ? -q : NaN, out: !Number.isFinite(q) };
    }
    if (in3d) {
      const t = scored3d[d.id];
      return { d, id: d.id, size: sizeOf(d, axis), margin: t ? t.worstMargin : NaN, out: !n.feasible };
    }
    return { d, id: d.id, size: sizeOf(d, axis), margin: d.flow.worstMargin, out: !n.feasible };
  };
  const everything: Pt[] = useMemo(() => space.map(toPt), [space, axis, yMode, load, in3d, score.results, check.results]);
  const pts = everything.filter((p) => !p.out && Number.isFinite(p.margin));
  const outs = everything.filter((p) => p.out);
  const front = useMemo(() => frontier(pts), [pts]);
  const selRaw = everything.find((p) => p.id === selected.id) ?? toPt(selected);
  // In the 3D view a design without a 3D score has no place on the chart: it is left out, not parked at the bottom.
  const selUnscored = in3d && !Number.isFinite(selRaw.margin);
  const sel = Number.isFinite(selRaw.margin) ? selRaw : { ...selRaw, margin: pts.length ? Math.min(...pts.map((p) => p.margin)) : 0 };
  const all = [...pts, sel];
  const fmtY = (v: number) => (yMode === 'noise' ? `${(-v).toFixed(1)} dB(A)` : pct(v));

  const altPts: Pt[] = useMemo(
    () => (alt.space && yMode === 'margin' && !in3d ? alt.space.filter((d) => !d.invalid && d.noise[load].feasible).map((d) => ({ d, id: d.id, size: sizeOf(d, axis), margin: d.flow.worstMargin, out: false })) : []),
    [alt.space, yMode, in3d, axis, load],
  );
  const altFront = useMemo(() => frontier(altPts), [altPts]);
  const runAlt = () => {
    if (alt.space) return setAlt({ running: false });
    altClient.current ??= new SolverClient();
    setAlt({ running: true });
    const flow = flowOn ? { ...NO_FLOW } : { ...ALL_FLOW };
    altClient.current
      .run({ ...cfg, prefs: { ...cfg.prefs, flow } })
      .then((r) => setAlt({ running: false, space: r.space }))
      .catch((e: Error) => e.message !== 'superseded' && setAlt({ running: false, error: e.message }));
  };
  const xs = [...all, ...outs, ...altFront].map((p) => p.size);
  const ysRaw = [...all, ...altFront].map((p) => p.margin);
  if (yMode === 'margin' && !in3d) for (const r of check.results) ysRaw.push(r.thermal.worstMargin);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const xPad = (xHi - xLo || 1) * 0.06;
  const x0 = xLo - xPad;
  const x1 = xHi + xPad;
  // Fit the data, with at least 10 points of range so a flat frontier reads as flat.
  const yMin = Math.min(...ysRaw);
  const yMax = Math.max(...ysRaw);
  const yMid = (yMin + yMax) / 2;
  const yHalf = Math.max(yMode === 'noise' ? 1.5 : 0.05, (yMax - yMin) / 2) * 1.15;
  const y0 = yMid - yHalf;
  const y1 = yMid + yHalf;
  const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const unit = axis === 'volume' ? 'L' : 'mm';
  const fmtSize = (v: number) => (axis === 'volume' ? `${v.toFixed(1)} L` : `${Math.round(v)} mm`);

  const nearest = (clientX: number, clientY: number): Pt | null => {
    const el = svg.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const py = ((clientY - r.top) / r.height) * H;
    let best: Pt | null = null;
    let bd = Infinity;
    for (const p of all) {
      const d = Math.hypot(sx(p.size) - px, sy(p.margin) - py);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    // ~24 px hit radius in screen space.
    return bd * (r.width / W) <= 24 ? best : null;
  };

  // On the frontier unless some design beats it on both, by more than rounding (0.5 point of margin, 1 mm or 0.1 L).
  const sizeEps = axis === 'volume' ? 0.1 : 1;
  const beaten = pts.some(
    (p) => (p.size < sel.size - sizeEps && p.margin >= sel.margin - 0.005) || (p.size <= sel.size + sizeEps && p.margin > sel.margin + 0.005),
  );
  const frontIdx = (() => {
    const exact = front.findIndex((p) => p.id === selected.id);
    if (exact >= 0 || beaten) return exact;
    let best = -1;
    let bd = Infinity;
    front.forEach((p, i) => {
      const d = Math.abs(p.size - sel.size) + Math.abs(p.margin - sel.margin);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  })();
  const step = (dir: number) => {
    if (!front.length) return;
    const i = frontIdx < 0 ? (dir > 0 ? 0 : front.length - 1) : Math.max(0, Math.min(front.length - 1, frontIdx + dir));
    onSelect(front[i].id);
  };

  const smallest = front[0];
  const coolest = front[front.length - 1];
  const runCheck = () => {
    const ids = [...new Set([smallest?.id, coolest?.id, selected.id].filter(Boolean) as string[])];
    const designs = ids.map((id) => all.find((p) => p.id === id)!.d);
    client.current ??= new CfdClient();
    setCheck({ running: true, done: 0, total: designs.length, results: [] });
    client.current.check(designs, cfg, {
      progress: (p) => setCheck((c) => ({ ...c, done: p.done })),
      checks: (results) => setCheck({ running: false, done: results.length, total: results.length, results }),
      error: (e) => setCheck((c) => ({ ...c, running: false, error: e })),
    });
  };

  const runScore = () => {
    const model = space.filter((d) => d.noise[load].feasible).map((d) => ({ d, id: d.id, size: sizeOf(d, axis), margin: d.flow.worstMargin }));
    const designs = rescoreCandidates(model, 19).map((p) => p.d);
    // The selected design itself, even when the design space holds only its duplicate.
    if (!designs.some((d) => d.id === selected.id)) designs.push(selected);
    scoreClient.current ??= new CfdClient();
    setScore({ running: true, done: 0, total: designs.length, results: {} });
    scoreClient.current.check(designs, cfg, {
      progress: (p) => setScore((c) => ({ ...c, done: p.done })),
      checks: (results) => {
        setScore({ running: false, done: results.length, total: results.length, results: Object.fromEntries(results.map((r) => [r.id, r.thermal])) });
        setView3d(true);
      },
      error: (e) => setScore((c) => ({ ...c, running: false, error: e })),
    });
  };

  const label = (p: Pt) => TOPOLOGY_LABELS[p.d.effectiveTopology].split(' — ')[0];
  const tip = hover ?? null;

  return (
    <section className="explorer" aria-label="Design space">
      <div className="section-head">
        <h3>Design space</h3>
        <div className="seg-mini" role="radiogroup" aria-label="Size axis">
          {(['volume', 'thickness'] as const).map((a) => (
            <button key={a} type="button" role="radio" aria-checked={axis === a} className={axis === a ? 'on' : ''} onClick={() => setAxis(a)}>
              {a === 'volume' ? 'Volume' : 'Thickness'}
            </button>
          ))}
        </div>
      </div>
      <div className="seg-mini y-toggle" role="radiogroup" aria-label="Vertical axis">
        <button type="button" role="radio" aria-checked={yMode === 'margin'} className={yMode === 'margin' ? 'on' : ''} onClick={() => setYMode('margin')}>
          {cfg.prefs.noiseMode === 'budget' ? `Cooling at ${cfg.prefs.noiseBudgetDb} dB(A)` : 'Cooling'}
        </button>
        <button type="button" role="radio" aria-checked={yMode === 'noise'} className={yMode === 'noise' ? 'on' : ''} onClick={() => setYMode('noise')}>
          Noise needed
        </button>
      </div>
      {yMode === 'margin' && Object.keys(scored3d).length > 0 && (
        <div className="seg-mini y-toggle" role="radiogroup" aria-label="Thermal score from">
          <button type="button" role="radio" aria-checked={!view3d} className={!view3d ? 'on' : ''} onClick={() => setView3d(false)}>
            Airflow model
          </button>
          <button type="button" role="radio" aria-checked={view3d} className={view3d ? 'on' : ''} onClick={() => setView3d(true)}>
            3D simulation ({Object.keys(scored3d).length})
          </button>
        </div>
      )}
      <p className="muted small">
        {space.length} layouts the solver evaluated, at {LOAD_LABEL[load]} load. Up and left is better:{' '}
        {yMode === 'noise'
          ? 'smaller case, and quieter while still keeping every part under its limit (fans as slow as that allows).'
          : `smaller case, and more of the tightest part's temperature budget left${cfg.prefs.noiseMode === 'budget' ? ` with the fans held to ${cfg.prefs.noiseBudgetDb} dB(A)` : ''}.`}{' '}
        The line joins the designs nothing else beats on both.
        {in3d
          ? ` Scored by 3D simulations of ${Object.keys(scored3d).length} designs, each run until its temperatures settle (1.4–8 s of airflow; a gain between two designs is uncertain by about ±55 %).`
          : caseAirHeated
            ? ` Scored by the fast airflow model. With ${cfg.parts.cooler.kind === 'air-tower' ? 'a tower cooler' : 'an air-cooled card'} heating the case air, its ranking agrees poorly with the 3D simulation (where the cooler sits against the vents matters, and the model can't see it): score the frontier in 3D before choosing.`
            : " Scored by the fast airflow model. Its temperatures are calibrated against the 3D simulation, but its ranking of layouts is not: in tests on the built-in parts it agreed weakly with 3D on the tightest part (rank correlation 0–0.4, where 3D runs on two grids agree at 0.8), because where the air goes inside the case decides most of the difference. Score the frontier in 3D before choosing."}
        {outs.length > 0 && ` ${outs.length} design${outs.length > 1 ? 's' : ''} ${yMode === 'noise' ? "can't keep every part under its limit at any speed" : "can't meet the noise budget"} (hollow, along the bottom).`}
      </p>

      <div className="viz" ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Scatter of ${space.length} designs, ${axis} against thermal margin; ${front.length} on the frontier`}
          tabIndex={0}
          onPointerMove={(e) => setHover(nearest(e.clientX, e.clientY))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const p = nearest(e.clientX, e.clientY);
            if (p) onSelect(p.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
            if (e.key === 'ArrowRight') (e.preventDefault(), step(1));
          }}
        >
          {/* grid and axes */}
          {ticks(y0, y1, 4).map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} className={t === 0 ? 'zero' : 'grid'} />
              <text x={PAD.l - 6} y={sy(t) + 4} className="tick" textAnchor="end">
                {yMode === 'noise' ? Math.round(-t) : `${Math.round(t * 100)}%`}
              </text>
            </g>
          ))}
          {ticks(x0, x1, 5).map((t) => (
            <text key={`x${t}`} x={sx(t)} y={H - PAD.b + 16} className="tick" textAnchor="middle">
              {axis === 'volume' ? t : Math.round(t)}
            </text>
          ))}
          <text x={(PAD.l + W - PAD.r) / 2} y={H - 6} className="axis-label" textAnchor="middle">
            {axis === 'volume' ? 'Volume (box envelope), L' : 'Thickness (box envelope), mm'}
          </text>
          <text x={12} y={(PAD.t + H - PAD.b) / 2} className="axis-label" textAnchor="middle" transform={`rotate(-90 12 ${(PAD.t + H - PAD.b) / 2})`}>
            {yMode === 'noise' ? 'Quietest safe noise, dB(A)' : 'Budget left, tightest part'}
          </text>

          {/* designs that can't meet the target, pinned to the bottom edge */}
          {outs.map((p) => (
            <circle key={`o${p.id}`} cx={sx(p.size)} cy={H - PAD.b - 4} r={3.5} className="pt-out" />
          ))}
          {/* every design */}
          {pts.map((p) => (
            <circle key={p.id} cx={sx(p.size)} cy={sy(p.margin)} r={3.5} className="pt" />
          ))}
          {/* the other flow-structure setting's frontier, dashed */}
          {altFront.length > 0 && (
            <g aria-label={flowOn ? 'Frontier without flow structures' : 'Frontier with every flow structure'}>
              <polyline points={altFront.map((p) => `${sx(p.size)},${sy(p.margin)}`).join(' ')} className="alt-line" />
              {altFront.map((p) => (
                <circle key={`a${p.id}`} cx={sx(p.size)} cy={sy(p.margin)} r={4} className="alt-pt" />
              ))}
            </g>
          )}
          {/* frontier */}
          <polyline points={front.map((p) => `${sx(p.size)},${sy(p.margin)}`).join(' ')} className="front-line" />
          {front.map((p) => (
            <circle key={`f${p.id}`} cx={sx(p.size)} cy={sy(p.margin)} r={5} className="front-pt" />
          ))}
          {/* 3D checks: hollow diamonds joined to their 1D point */}
          {yMode === 'margin' && !in3d && check.results.map((r) => {
            const p = all.find((q) => q.id === r.id);
            if (!p) return null;
            const x = sx(p.size);
            const y = sy(r.thermal.worstMargin);
            return (
              <g key={`c${r.id}`}>
                <line x1={x} x2={x} y1={sy(p.margin)} y2={y} className="check-link" />
                <path d={`M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z`} className="check-pt" />
              </g>
            );
          })}
          {/* selected */}
          {!selUnscored && <circle cx={sx(sel.size)} cy={sy(sel.margin)} r={9} className="sel-ring" />}
          {/* end labels */}
          {smallest && coolest && Math.hypot(sx(coolest.size) - sx(smallest.size), sy(coolest.margin) - sy(smallest.margin)) < 90 ? (
            <text x={sx(smallest.size) + 10} y={sy(smallest.margin) + 18} className="end-label">
              {coolest === smallest ? `Smallest and ${yMode === 'noise' ? 'quietest' : 'coolest'}` : `Smallest ≈ ${yMode === 'noise' ? 'quietest' : 'coolest'}`}
            </text>
          ) : (
            <>
              {smallest && (
                <text x={sx(smallest.size) + 10} y={sy(smallest.margin) + 18} className="end-label">
                  Smallest
                </text>
              )}
              {coolest && (
                <text x={sx(coolest.size) - 10} y={sy(coolest.margin) - 12} className="end-label" textAnchor="end">
                  {yMode === 'noise' ? 'Quietest' : 'Coolest'}
                </text>
              )}
            </>
          )}
          {tip && <circle cx={sx(tip.size)} cy={sy(tip.margin)} r={7} className="hover-ring" />}
        </svg>
        {tip && (
          <div
            className="viz-tip"
            role="status"
            style={{ left: `${(sx(tip.size) / W) * 100}%`, top: `${(sy(tip.margin) / H) * 100}%` }}
          >
            <b>{label(tip)}</b> · {tip.d.profile.label}
            <br />
            {tip.d.volumeL.toFixed(1)} L · {Math.round(tip.d.thickness)} mm thick
            <br />
            {tip.d.flow.worstComponent}: {pct(tip.d.flow.worstMargin)} left ({tip.d.flow.worstHeadroomK.toFixed(0)} K)
            <br />
            {tip.d.noise[load].noise.spl.toFixed(1)} dB(A), fans {speedRange(tip.d, load)}
            {tip.d.noise[load].feasible ? '' : ' · over budget'}
            {Number.isFinite(tip.d.noise[load].quietDb) ? ` · quietest safe ${tip.d.noise[load].quietDb.toFixed(1)} dB(A)` : ''}
            {tip.d.chamber ? ` · ${tip.d.chamber.chambers.length} chambers` : ''}
          </div>
        )}
      </div>

      <div className="legend-row small">
        <span>
          <i className="key front" /> Frontier
        </span>
        <span>
          <i className="key pt" /> Other designs
        </span>
        <span>
          <i className="key sel" /> Selected
        </span>
        {altFront.length > 0 && (
          <span>
            <i className="key alt" /> {flowOn ? 'Without flow structures' : 'With every flow structure'}
          </span>
        )}
        {check.results.length > 0 && (
          <span>
            <i className="key check" /> 3D simulation
          </span>
        )}
      </div>

      {front.length > 1 && (
        <label className="slider-row" htmlFor="front-pick">
          <span>Size</span>
          <input
            id="front-pick"
            type="range"
            min={0}
            max={front.length - 1}
            step={1}
            value={frontIdx < 0 ? 0 : frontIdx}
            onChange={(e) => onSelect(front[Number(e.target.value)].id)}
            aria-valuetext={frontIdx < 0 ? 'off the frontier' : `${fmtSize(front[frontIdx].size)}, ${fmtY(front[frontIdx].margin)}`}
          />
          <span>{yMode === 'noise' ? 'Quiet' : 'Thermal'}</span>
        </label>
      )}
      {pts.length === 0 && (
        <p className="small">
          {yMode === 'noise'
            ? 'No layout keeps every part under its limit at any fan speed.'
            : `No layout meets ${cfg.prefs.noiseBudgetDb} dB(A): the quietest one makes ${Math.min(...outs.map((p) => p.d.noise[load].noise.spl)).toFixed(1)} dB(A) even at its slowest fan speeds (pumps and the PSU set a floor). Raise the budget or switch to "Quietest that stays safe".`}
        </p>
      )}
      {beaten && !selUnscored && pts.length > 0 && <p className="muted small">The selected design is not on the frontier: another design is both smaller and cooler. Move the slider to snap to it.</p>}
      {selUnscored && <p className="muted small">The selected design has no 3D score yet: score again to include it.</p>}
      {yMode === 'margin' && !in3d && front.length > 1 && front[front.length - 1].margin - front[0].margin < 0.05 && (
        <p className="muted small">
          The frontier is nearly flat: the coolest design keeps only {((front[front.length - 1].margin - front[0].margin) * 100).toFixed(1)} points more of the tightest part's
          budget than the smallest. For these parts the case shape hardly changes temperatures — each part's own rise above its air or
          coolant dominates — so size is close to free.
        </p>
      )}

      <div className="explorer-actions">
        <button type="button" className="btn ghost small" onClick={runAlt} disabled={alt.running || yMode !== 'margin'}>
          {alt.running ? 'Solving…' : alt.space ? 'Hide the comparison' : flowOn ? 'Compare without flow structures' : 'Compare with every flow structure'}
        </button>
        <button type="button" className="btn small" onClick={runScore} disabled={score.running || yMode !== 'margin'}>
          {score.running ? `Simulating ${score.done + 1} of ${score.total}…` : Object.keys(score.results).length ? 'Score again in 3D' : 'Score the frontier in 3D (20 designs)'}
        </button>
        <button type="button" className="btn ghost small" onClick={runCheck} disabled={check.running}>
          {check.running ? `Simulating ${check.done + 1} of ${check.total}…` : 'Check ends and selection in 3D'}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setTable((t) => !t)} aria-expanded={table}>
          {table ? 'Hide table' : 'Show as table'}
        </button>
      </div>
      {check.error && <p className="muted small">{check.error}</p>}
      {score.error && <p className="muted small">{score.error}</p>}
      {check.results.length > 0 && (
        <table className="sim-table">
          <thead>
            <tr>
              <th scope="col">Design</th>
              <th scope="col" className="num">
                Model
              </th>
              <th scope="col" className="num">
                3D sim
              </th>
            </tr>
          </thead>
          <tbody>
            {check.results.map((r) => {
              const p = all.find((q) => q.id === r.id)!;
              const name = p.id === smallest?.id ? 'Smallest' : p.id === coolest?.id ? 'Coolest' : 'Selected';
              return (
                <tr key={r.id}>
                  <th scope="row">
                    {name}
                    <span className="path-sub">
                      {fmtSize(p.size)} · tightest: {r.thermal.worstComponent}
                    </span>
                  </th>
                  <td className="num">{pct(p.margin)}</td>
                  <td className="num">{pct(r.thermal.worstMargin)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {check.results.length > 0 && (
        <p className="muted small">Short, coarse 3D runs (about 1.4 s of airflow); they confirm the ranking when model and simulation move the same way.</p>
      )}

      {table && (
        <table className="sim-table">
          <thead>
            <tr>
              <th scope="col">Frontier design</th>
              <th scope="col" className="num">
                {axis === 'volume' ? 'Volume' : 'Thickness'}
              </th>
              <th scope="col" className="num">
                Left
              </th>
            </tr>
          </thead>
          <tbody>
            {front.map((p) => (
              <tr key={p.id} className={p.id === selected.id ? 'on' : ''}>
                <th scope="row">
                  <button type="button" className="linklike" onClick={() => onSelect(p.id)}>
                    {label(p)}
                  </button>
                  <span className="path-sub">
                    {p.d.profile.label} · tightest: {p.d.flow.worstComponent}
                  </span>
                </th>
                <td className="num">
                  {axis === 'volume' ? p.size.toFixed(1) : Math.round(p.size)} {unit}
                </td>
                <td className="num">{fmtY(p.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cfg.prefs.shell === 'wrap' && <p className="muted small">Sizes here are box envelopes; the selected design's shrinkwrapped size is in the summary above.</p>}
    </section>
  );
}
