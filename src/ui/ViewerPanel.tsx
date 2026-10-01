import { useEffect, useRef, useState } from 'react';
import type { DesignConfig } from '../model/types';
import { CaseViewer, DEFAULT_VIEW, type ViewOptions, type ViewPreset } from '../render/Viewer';
import type { Design } from '../solver/evaluate';
import type { ShellResult } from '../state/meshClient';

const HINT_KEY = 'caseblanket:hint-dismissed';

function readHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function ViewerPanel(props: {
  design: Design | null;
  cfg: DesignConfig;
  dark: boolean;
  solving: boolean;
  progress: number;
  /** Shrinkwrapped shell for `shellFor` (a design id), when the shell is organic. */
  shell: ShellResult | null;
  shellFor: Design | null;
  shaping: boolean;
  onViewer?: (v: CaseViewer | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<CaseViewer | null>(null);
  const [opts, setOpts] = useState<ViewOptions>(DEFAULT_VIEW);
  const [menu, setMenu] = useState(false);
  const [hintGone, setHintGone] = useState(readHint);
  const [error, setError] = useState<string | null>(null);
  const lastKey = useRef('');
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const { onViewer } = props;

  useEffect(() => {
    if (!host.current) return;
    try {
      viewer.current = new CaseViewer(host.current);
      (window as unknown as { __caseblanketViewer?: CaseViewer }).__caseblanketViewer = viewer.current;
      onViewer?.(viewer.current);
    } catch (e) {
      setError('3D preview needs WebGL, which this browser or device has turned off. The numbers on the right are still valid.');
      console.error(e);
    }
    return () => {
      viewer.current?.dispose();
      viewer.current = null;
      onViewer?.(null);
    };
  }, [onViewer]);

  useEffect(() => {
    viewer.current?.setTheme(props.dark);
  }, [props.dark]);

  useEffect(() => {
    if (!viewer.current || !props.design) return;
    // Refit the camera only when the case outline changes a lot or the orientation flips.
    const e = props.design.exterior;
    const key = `${props.cfg.prefs.orientation}|${Math.round(Math.max(...e) / 60)}`;
    const organic = props.cfg.prefs.organic > 0;
    viewer.current.setDesign(props.design, props.cfg, key !== lastKey.current, organic);
    lastKey.current = key;
    shownShell.current = null;
  }, [props.design, props.cfg]);

  const shownShell = useRef<ShellResult | null>(null);
  useEffect(() => {
    if (!viewer.current || !props.design) return;
    if (props.cfg.prefs.organic <= 0) {
      if (shownShell.current) viewer.current.setShell(null);
      shownShell.current = null;
      return;
    }
    if (props.shell && props.shellFor === props.design && shownShell.current !== props.shell) {
      viewer.current.setShell(props.shell);
      shownShell.current = props.shell;
    }
  }, [props.shell, props.shellFor, props.design, props.cfg]);

  useEffect(() => {
    viewer.current?.setOptions(opts);
  }, [opts]);

  const set = (o: Partial<ViewOptions>) => setOpts((p) => ({ ...p, ...o }));
  const view = (v: ViewPreset) => viewer.current?.setView(v);
  const dismissHint = () => {
    setHintGone(true);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  const fullscreen = () => {
    const el = host.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="viewer" aria-busy={props.solving}>
      <div ref={host} className="viewer-host" onPointerDown={() => !hintGone && dismissHint()} />
      {error && <p className="viewer-error">{error}</p>}
      {!props.solving && props.shaping && (
        <div className="solving" role="status">
          <span className="spinner" aria-hidden="true" />
          Shaping the shell…
        </div>
      )}
      {props.solving && (
        <div className="solving" role="status">
          <span className="spinner" aria-hidden="true" />
          Designing… {Math.round(props.progress * 100)}%
        </div>
      )}
      {!hintGone && !error && (
        <button type="button" className="gesture-hint" onClick={dismissHint}>
          <span>{coarse ? 'Drag to rotate · pinch to zoom · two fingers to pan · double-tap to reset' : 'Drag to rotate · scroll to zoom · right-drag to pan · double-click to reset'}</span>
          <span aria-hidden="true" className="close">
            ×
          </span>
        </button>
      )}
      <div className="view-bar" role="toolbar" aria-label="View">
        <div className="seg-mini">
          {(['iso', 'front', 'side', 'top', 'back'] as ViewPreset[]).map((v) => (
            <button key={v} type="button" className={v === 'back' ? 'opt-back' : undefined} onClick={() => view(v)}>
              {v === 'iso' ? '3D' : v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="seg-mini">
          <button type="button" className="opt-zoom" aria-label="Zoom in" onClick={() => viewer.current?.zoom(0.8)}>
            +
          </button>
          <button type="button" className="opt-zoom" aria-label="Zoom out" onClick={() => viewer.current?.zoom(1.25)}>
            −
          </button>
          <button type="button" aria-label="Full screen" onClick={fullscreen}>
            ⤢
          </button>
          <button type="button" aria-expanded={menu} aria-controls="view-menu" onClick={() => setMenu((m) => !m)}>
            Layers
          </button>
        </div>
      </div>
      {menu && (
        <div className="view-menu" id="view-menu">
          <label htmlFor="v-shell">
            <span>Shell</span>
            <input id="v-shell" type="range" min={0} max={1} step={0.05} value={opts.shellOpacity} onChange={(e) => set({ shellOpacity: Number(e.target.value) })} />
          </label>
          <label htmlFor="v-explode">
            <span>Explode</span>
            <input id="v-explode" type="range" min={0} max={1} step={0.05} value={opts.explode} onChange={(e) => set({ explode: Number(e.target.value) })} />
          </label>
          <label htmlFor="v-air" className="check">
            <input id="v-air" type="checkbox" checked={opts.showAirflow} onChange={(e) => set({ showAirflow: e.target.checked })} /> Airflow arrows
          </label>
          <label htmlFor="v-dims" className="check">
            <input id="v-dims" type="checkbox" checked={opts.showDims} onChange={(e) => set({ showDims: e.target.checked })} /> Dimensions
          </label>
          <label htmlFor="v-labels" className="check">
            <input id="v-labels" type="checkbox" checked={opts.showLabels} onChange={(e) => set({ showLabels: e.target.checked })} /> Part names
          </label>
          <label htmlFor="v-clear" className="check">
            <input id="v-clear" type="checkbox" checked={opts.showClearances} onChange={(e) => set({ showClearances: e.target.checked })} /> Clearance boxes
          </label>
        </div>
      )}
      <div className="legend" aria-hidden="true">
        <span className="in">intake</span>
        <span className="out">exhaust</span>
      </div>
    </div>
  );
}
