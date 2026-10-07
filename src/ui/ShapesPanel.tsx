import { useEffect, useState } from 'react';
import { SHELL_SHAPES, SHOWCASE } from '../model/presets';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { wrapMetrics, type WrapMetrics } from '../solver/shrinkwrap';
import { produce } from '../state/config';

const mm = (x: number) => `${Math.round(x)}`;

/**
 * The shape side of the design space: the selected layout under each shell (box, shrinkwrap,
 * angled panels, curved panels), measured from its own mesh. The parts, vents and fans do not
 * move, so the airflow model rates them alike; the 3D simulation sees each shape's outside.
 */
export function ShapesPanel({
  design,
  cfg,
  setCfg,
  onPick,
}: {
  design: Design;
  cfg: DesignConfig;
  setCfg: (c: DesignConfig) => void;
  /** A layout to select once the showcase's settings are solved. */
  onPick?: (id: string) => void;
}) {
  const [rows, setRows] = useState<(WrapMetrics | null)[]>(() => SHELL_SHAPES.map(() => null));
  useEffect(() => {
    let cancelled = false;
    setRows(SHELL_SHAPES.map(() => null));
    // One shape per tick, so the page stays responsive while they are measured.
    const next = (i: number) => {
      if (cancelled || i >= SHELL_SHAPES.length) return;
      const s = SHELL_SHAPES[i];
      const c = { ...cfg, prefs: { ...cfg.prefs, ...s.prefs } };
      const m = wrapMetrics(design, c, c.prefs.organic ?? 0, 0.4);
      if (cancelled) return;
      setRows((r) => r.map((x, k) => (k === i ? m : x)));
      setTimeout(() => next(i + 1), 0);
    };
    const t = setTimeout(() => next(0), 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [design, cfg]);

  const current = SHELL_SHAPES.findIndex((s) => Object.entries(s.prefs).every(([k, v]) => JSON.stringify(cfg.prefs[k as keyof typeof cfg.prefs]) === JSON.stringify(v)));
  const use = (prefs: Partial<DesignConfig['prefs']>) => setCfg(produce(cfg, (d) => void Object.assign(d.prefs, structuredClone(prefs))));

  return (
    <section className="shapes" aria-label="Shell shapes">
      <div className="section-head">
        <h3>Shapes</h3>
        <span className="muted small">this layout, other skins</span>
      </div>
      <p className="muted small">
        The same parts under straight, shrinkwrapped, angled and curved panels. Each panel is pushed out just far enough to clear the parts, so angles can save
        volume where a corner is empty and curves cost it where the parts fill one. Vents and fans stay where they are.
      </p>
      <div className="table-scroll">
        <table className="sim-table">
          <thead>
            <tr>
              <th scope="col">Shell</th>
              <th scope="col" className="num">Volume</th>
              <th scope="col" className="num" title="Width × height × depth, feet excluded">Outside, mm</th>
              <th scope="col" className="num">Panels</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {SHELL_SHAPES.map((s, i) => {
              const m = rows[i];
              return (
                <tr key={s.id} className={i === current ? 'worth' : undefined}>
                  <th scope="row">{s.label}</th>
                  <td className="num">{m ? `${m.volumeL.toFixed(1)} L` : '…'}</td>
                  <td className="num">{m ? `${mm(m.world.width)} × ${mm(m.world.height)} × ${mm(m.world.depth)}` : '…'}</td>
                  <td className="num">{m ? `${m.weightKg.toFixed(2)} kg` : '…'}</td>
                  <td>
                    {i === current ? (
                      <span className="muted small">in use</span>
                    ) : (
                      <button type="button" className="link-btn" onClick={() => use(s.prefs)}>
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h4>Showcase</h4>
      <ul className="showcase">
        {SHOWCASE.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => {
                if (x.designId) onPick?.(x.designId);
                setCfg(produce(cfg, (d) => x.apply(d)));
              }}
            >
              {x.name}
            </button>
            <span className="muted small">{x.blurb}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
