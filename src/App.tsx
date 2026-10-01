import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultConfig } from './model/presets';
import type { DesignConfig } from './model/types';
import { download, shellSTL } from './render/export';
import { panelsSVG } from './render/svgPanels';
import type { CaseViewer } from './render/Viewer';
import type { Design } from './solver/evaluate';
import type { SolveResult } from './solver/solve';
import { encodeShare, initialConfig, IS_ARTIFACT, storeConfig } from './state/config';
import { MeshClient, type ShellResult } from './state/meshClient';
import { isWrap } from './solver/shrinkwrap';
import { SolverClient } from './state/solverClient';
import { ModelPanel } from './ui/ModelPanel';
import { PartsPanel } from './ui/PartsPanel';
import { PrintDialog } from './ui/PrintDialog';
import { SimPanel } from './ui/SimPanel';
import { AirflowTable, Candidates, Checks, Summary, Temperatures } from './ui/ResultsPanel';
import { TunePanel } from './ui/TunePanel';
import { ViewerPanel } from './ui/ViewerPanel';

type Tab = 'design' | 'parts' | 'tune' | 'model';
type Theme = 'system' | 'light' | 'dark';

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/** The data-theme a host page may set on <html>, kept in sync. */
function useHostTheme(): string | null {
  const [t, setT] = useState(() => document.documentElement.getAttribute('data-theme'));
  useEffect(() => {
    const obs = new MutationObserver(() => setT(document.documentElement.getAttribute('data-theme')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return t;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('caseblanket:theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export default function App() {
  const [cfg, setCfg] = useState<DesignConfig>(initialConfig);
  const [result, setResult] = useState<SolveResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (window.matchMedia('(min-width: 1180px)').matches ? 'parts' : 'design'));
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [toast, setToast] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const wide = useMedia('(min-width: 1180px)');
  const systemDark = useMedia('(prefers-color-scheme: dark)');
  const hostTheme = useHostTheme();
  const dark = IS_ARTIFACT ? hostTheme === 'dark' || (hostTheme === null && systemDark) : theme === 'dark' || (theme === 'system' && systemDark);
  const client = useRef<SolverClient | null>(null);
  const viewerRef = useRef<CaseViewer | null>(null);
  const onViewer = useCallback((v: CaseViewer | null) => (viewerRef.current = v), []);

  // Solve (debounced) whenever the configuration changes.
  useEffect(() => {
    client.current ??= new SolverClient();
    const t = setTimeout(() => {
      setSolving(true);
      setProgress(0);
      client.current!
        .run(cfg, setProgress)
        .then((r) => {
          setResult(r);
          setSelected(r.designs[0]?.id ?? null);
          setError(r.designs.length ? null : 'No layout fits these parts and limits. Relax a size limit, allow more layouts or vent more panels.');
          setSolving(false);
        })
        .catch((e: Error) => {
          if (e.message === 'superseded') return;
          setError(`The solver failed: ${e.message}`);
          setSolving(false);
        });
    }, 250);
    const s = setTimeout(() => storeConfig(cfg), 600);
    return () => {
      clearTimeout(t);
      clearTimeout(s);
    };
  }, [cfg]);

  useEffect(() => () => client.current?.dispose(), []);

  useEffect(() => {
    // Inside a host frame the host owns data-theme; only the standalone app sets it.
    if (IS_ARTIFACT) return;
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('caseblanket:theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (wide && tab === 'design') setTab('parts');
  }, [wide, tab]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const design = useMemo(() => result?.designs.find((d) => d.id === selected) ?? result?.designs[0] ?? null, [result, selected]);

  // Shrinkwrap the selected design's shell off the main thread.
  const meshClient = useRef<MeshClient | null>(null);
  const [shell, setShell] = useState<{ for: Design; result: ShellResult } | null>(null);
  const [shaping, setShaping] = useState(false);
  const organic = cfg.prefs.organic;
  const wrap = isWrap(cfg);
  useEffect(() => {
    if (!design || !wrap) {
      setShaping(false);
      return;
    }
    meshClient.current ??= new MeshClient();
    setShaping(true);
    meshClient.current
      .run(design, cfg, organic)
      .then((r) => {
        setShell({ for: design, result: r });
        setShaping(false);
      })
      .catch((e: Error) => {
        if (e.message !== 'superseded') setShaping(false);
      });
    // cfg is captured with the design it produced; re-mesh only when the design or shape changes.
  }, [design, organic, wrap]);
  useEffect(() => () => meshClient.current?.dispose(), []);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#${encodeShare(cfg)}`;
    try {
      await navigator.clipboard.writeText(url);
      setToast('Link copied — it carries all your parts and settings.');
    } catch {
      history.replaceState(null, '', url);
      setToast('Link is in the address bar — copy it from there.');
    }
  };

  const copyJson = async () => {
    if (!design) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ config: cfg, design }, null, 2));
      setToast('Design JSON copied.');
    } catch {
      setToast('Clipboard is blocked here.');
    }
  };

  const doExport = (kind: 'stl' | 'svg' | 'json' | 'png') => {
    setExportOpen(false);
    if (!design) return;
    const stem = `caseblanket-${Math.round(design.world.width)}x${Math.round(design.world.height)}x${Math.round(design.world.depth)}`;
    if (kind === 'stl') download(shellSTL(design, cfg), `${stem}-shell.stl`);
    if (kind === 'svg' && isWrap(cfg)) return;
    if (kind === 'svg') download(new Blob([panelsSVG(design, cfg)], { type: 'image/svg+xml' }), `${stem}-panels.svg`);
    if (kind === 'json') download(new Blob([JSON.stringify({ config: cfg, design }, null, 2)], { type: 'application/json' }), `${stem}.json`);
    if (kind === 'png' && viewerRef.current) {
      fetch(viewerRef.current.snapshot())
        .then((r) => r.blob())
        .then((b) => download(b, `${stem}.png`));
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    ...(wide ? [] : [{ id: 'design' as Tab, label: 'Design' }]),
    { id: 'parts', label: 'Parts' },
    { id: 'tune', label: 'Tune' },
    { id: 'model', label: 'Model' },
  ];

  const results = design && result && (
    <>
      <Summary d={design} cfg={cfg} />
      <Temperatures d={design} cfg={cfg} />
      <AirflowTable d={design} cfg={cfg} />
      <SimPanel design={design} cfg={cfg} viewer={() => viewerRef.current} />
      <Checks d={design} />
      <Candidates result={result} selected={design.id} onSelect={setSelected} />
    </>
  );

  return (
    <div className={`app${wide ? ' wide' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true" className="logo">
            <rect x="5" y="3" width="15" height="26" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M24 7v18M28 10v12" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12.5" cy="11" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          <span className="name">caseblanket</span>
          <span className="tagline">a case cut to your parts</span>
        </div>
        <div className="actions">
          {!IS_ARTIFACT && (
            <button type="button" className="btn ghost" onClick={share}>
              Share
            </button>
          )}
          <div className="menu-wrap">
            <button type="button" className="btn" aria-expanded={exportOpen} aria-controls="export-menu" onClick={() => setExportOpen((o) => !o)} disabled={!design}>
              Export
            </button>
            {exportOpen && (
              <div className="menu" id="export-menu" role="menu">
                {IS_ARTIFACT ? (
                  <>
                    <button role="menuitem" type="button" onClick={copyJson}>
                      Copy design JSON
                    </button>
                    <p className="muted small">STL, SVG and image downloads work in the full app; this hosted preview blocks downloads.</p>
                  </>
                ) : (
                  <>
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setExportOpen(false);
                        setPrintOpen(true);
                      }}
                    >
                      3D-printable pieces <span>STL zip</span>
                    </button>
                    <button role="menuitem" type="button" onClick={() => doExport('stl')}>
                      Shell surface, one piece <span>STL</span>
                    </button>
                    <button role="menuitem" type="button" disabled={isWrap(cfg)} title={isWrap(cfg) ? 'Flat panels exist only for the straight box (Shell: Box)' : undefined} onClick={() => doExport('svg')}>
                      Flat panel drawings <span>{isWrap(cfg) ? 'box only' : 'SVG'}</span>
                    </button>
                    <button role="menuitem" type="button" onClick={() => doExport('png')}>
                      Picture of this view <span>PNG</span>
                    </button>
                    <button role="menuitem" type="button" onClick={() => doExport('json')}>
                      Full design data <span>JSON</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {!IS_ARTIFACT && (
          <button
            type="button"
            className="btn icon"
            aria-label={`Theme: ${theme}. Change theme`}
            title={`Theme: ${theme}`}
            onClick={() => setTheme(theme === 'system' ? (systemDark ? 'light' : 'dark') : theme === 'dark' ? 'light' : 'system')}
          >
            {theme === 'system' ? '◐' : theme === 'dark' ? '●' : '○'}
          </button>
          )}
        </div>
      </header>

      <main className="workbench">
        <section className="stage" aria-label="Case preview">
          <ViewerPanel
            design={design}
            cfg={cfg}
            dark={dark}
            solving={solving}
            progress={progress}
            shell={shell?.result ?? null}
            shellFor={shell?.for ?? null}
            shaping={shaping}
            onViewer={onViewer}
          />
        </section>

        <section className="controls" aria-label="Inputs">
          <nav className="tabs" role="tablist" aria-label="Panels">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`pane-${t.id}`} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="pane" role="tabpanel" id={`pane-${tab}`} aria-labelledby={`tab-${tab}`}>
            {error && <p className="error-text banner">{error}</p>}
            {tab === 'design' && (results ?? <p className="muted">Working out the first design…</p>)}
            {tab === 'parts' && <PartsPanel cfg={cfg} setCfg={setCfg} />}
            {tab === 'tune' && <TunePanel cfg={cfg} setCfg={setCfg} />}
            {tab === 'model' && <ModelPanel cfg={cfg} setCfg={setCfg} />}
            <div className="pane-foot">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setCfg(defaultConfig());
                  setToast('Back to the example build.');
                }}
              >
                Start over with the example build
              </button>
            </div>
          </div>
        </section>

        {wide && (
          <aside className="results" aria-label="Results">
            {error && <p className="error-text banner">{error}</p>}
            {results ?? <p className="muted">Working out the first design…</p>}
          </aside>
        )}
      </main>
      {printOpen && design && <PrintDialog design={design} cfg={cfg} onClose={() => setPrintOpen(false)} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
