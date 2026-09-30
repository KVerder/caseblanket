import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyBoardRow,
  applyCoolerRow,
  applyGpuRow,
  applyPsuRow,
  DATASET_HOME,
  loadCatalog,
  rowDetail,
  rowTitle,
  searchRows,
  type CatalogKind,
  type CatalogRow,
} from '../catalog/online';
import { applyLookup, describeValue, lookupWithClaude, type LookupKind, type LookupResult } from '../catalog/claudeLookup';
import type { DesignConfig } from '../model/types';
import { IS_ARTIFACT, produce } from '../state/config';

const KEY_STORE = 'caseblanket:anthropic-key';

function readKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}

/** Optional: ask Claude (with web search) for the dimensions the catalogue lacks. */
function ClaudeLookup(props: { kind: LookupKind; initial: string; cfg: DesignConfig; onApply: (c: DesignConfig) => void }) {
  const [part, setPart] = useState(props.initial);
  const [key, setKey] = useState(readKey);
  const [remember, setRemember] = useState(() => readKey() !== '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<LookupResult | null>(null);
  useEffect(() => setPart((p) => p || props.initial), [props.initial]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      if (remember) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch {
      /* storage blocked: key stays in memory only */
    }
    try {
      setRes(await lookupWithClaude(props.kind, part, key.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="ai-lookup">
      <summary>Not listed, or dimensions missing? Look it up with Claude</summary>
      <div className="ai-body">
        <p className="muted small">
          Claude searches the web for the published spec sheet and returns only numbers it found there, with the pages. Your Anthropic API key
          goes from this browser straight to api.anthropic.com and each lookup is billed to it.
        </p>
        <label className="field text" htmlFor="ai-part">
          <span className="field-label">Exact part name</span>
          <input id="ai-part" value={part} onChange={(e) => setPart(e.target.value)} placeholder="e.g. MSI RTX 5080 16G SUPRIM LIQUID SOC" />
        </label>
        <label className="field text" htmlFor="ai-key">
          <span className="field-label">Anthropic API key</span>
          <input id="ai-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" />
        </label>
        <label className="field toggle" htmlFor="ai-remember">
          <input id="ai-remember" type="checkbox" role="switch" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="switch" aria-hidden="true" />
          <span className="field-label">Remember the key on this device</span>
        </label>
        <button type="button" className="btn" disabled={busy || !key.trim() || part.trim().length < 3} onClick={run}>
          {busy ? 'Searching… (can take a minute)' : 'Look up dimensions'}
        </button>
        {err && <p className="error-text">{err}</p>}
        {res && (
          <div className="ai-result">
            <p>
              <strong>{res.name || part}</strong>
            </p>
            <dl className="ai-values">
              {Object.entries(res.values).map(([k, v]) => (
                <div key={k} className={v === null ? 'none' : ''}>
                  <dt>{k.replace(/_mm$|_w$/, '').replace(/_/g, ' ')}</dt>
                  <dd>{describeValue(k, v)}</dd>
                </div>
              ))}
            </dl>
            {res.notes && <p className="muted small">{res.notes}</p>}
            {res.sources.length > 0 ? (
              <ul className="ai-sources">
                {res.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="error-text small">No source page from the search backs these numbers. Don't use them without checking.</p>
            )}
            {res.droppedSources.length > 0 && <p className="muted small">Ignored {res.droppedSources.length} cited link(s) the search never returned.</p>}
            <button type="button" className="btn" onClick={() => props.onApply(applyLookup(props.cfg, res))}>
              Use these values
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

const TITLES: Record<CatalogKind, string> = {
  'video-card': 'Find a graphics card',
  'cpu-cooler': 'Find a CPU cooler',
  'power-supply': 'Find a power supply',
  motherboard: 'Find a motherboard',
  cpu: 'Find a CPU',
};

const PLACEHOLDER: Record<CatalogKind, string> = {
  'video-card': 'e.g. suprim liquid 5080',
  'cpu-cooler': 'e.g. liquid freezer 240',
  'power-supply': 'e.g. sf750',
  motherboard: 'e.g. b650i',
  cpu: 'e.g. 9800x3d',
};

export function CatalogDialog(props: { kind: CatalogKind; cfg: DesignConfig; setCfg: (c: DesignConfig) => void; onClose: () => void }) {
  const { kind } = props;
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    loadCatalog(kind)
      .then((r) => alive && setRows(r))
      .catch((e) =>
        alive &&
        setError(
          IS_ARTIFACT
            ? 'This hosted preview cannot reach the online catalogue. Run the full app (see the README) or type the dimensions in.'
            : `Could not load the catalogue (${e instanceof Error ? e.message : e}). Check your connection, or type the dimensions in.`,
        ),
      );
    return () => {
      alive = false;
    };
  }, [kind]);

  const hits = useMemo(() => (rows ? searchRows(kind, rows, q) : []), [rows, q, kind]);

  const apply = (r: CatalogRow) => {
    const next = produce(props.cfg, (d) => {
      if (kind === 'video-card') {
        const { spec, unknown } = applyGpuRow(d.parts.gpu, r);
        d.parts.gpu = { ...spec, source: { ...spec.source, missing: unknown } };
      } else if (kind === 'cpu-cooler') {
        const { spec, unknown } = applyCoolerRow(d.parts.cooler, r);
        d.parts.cooler = { ...spec, source: { ...spec.source, missing: unknown } };
      } else if (kind === 'power-supply') {
        const { spec, unknown } = applyPsuRow(d.parts.psu, r);
        d.parts.psu = { ...spec, source: { ...spec.source, missing: unknown } };
      } else if (kind === 'motherboard') {
        const { spec, unknown } = applyBoardRow(d.parts.board, r);
        d.parts.board = { ...spec, source: { ...spec.source, missing: unknown } };
      } else if (kind === 'cpu' && typeof r.tdp === 'number') {
        d.parts.cooler.cpuPowerW = r.tdp;
      }
    });
    props.setCfg(next);
    close();
  };

  const close = () => {
    dialog.current?.close();
    props.onClose();
  };

  return (
    <dialog ref={dialog} className="catalog" onCancel={close} aria-labelledby="catalog-title">
      <div className="catalog-head">
        <h3 id="catalog-title">{TITLES[kind]}</h3>
        <button type="button" className="btn icon" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
      <input
        id="catalog-query"
        className="catalog-search"
        type="search"
        autoFocus
        placeholder={PLACEHOLDER[kind]}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search the catalogue"
      />
      <div className="catalog-body" aria-live="polite">
        {error && <p className="error-text">{error}</p>}
        {!error && !rows && <p className="muted">Loading the catalogue…</p>}
        {rows && q.trim() === '' && <p className="muted">{rows.length.toLocaleString()} parts loaded. Type part of a model name.</p>}
        {rows && q.trim() !== '' && hits.length === 0 && <p className="muted">No match. Try fewer words.</p>}
        <ul className="catalog-list">
          {hits.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <button type="button" onClick={() => apply(r)}>
                <span className="c-name">{rowTitle(kind, r)}</span>
                <span className="c-detail">{rowDetail(kind, r)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {!IS_ARTIFACT && kind !== 'cpu' && (
        <ClaudeLookup
          kind={kind}
          initial={q}
          cfg={props.cfg}
          onApply={(c) => {
            props.setCfg(c);
            close();
          }}
        />
      )}
      <p className="catalog-foot">
        Data: <a href={DATASET_HOME} target="_blank" rel="noreferrer">pc-part-dataset</a> (PCPartPicker listings, July 2025). It has GPU length,
        form factors, AIO radiator size and CPU TDP only — the rest keeps its previous value and is flagged for you to check.
      </p>
    </dialog>
  );
}
