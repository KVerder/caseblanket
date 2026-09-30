import { useEffect, useId, useState, type ReactNode } from 'react';

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  flagged?: boolean;
  id?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  const [text, setText] = useState(fmt(props.value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(props.value));
  }, [props.value, focused]);
  const commit = (s: string) => {
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n)) return;
    const c = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n));
    if (c !== props.value) props.onChange(c);
  };
  return (
    <label className={`field num${props.flagged ? ' flagged' : ''}`} htmlFor={id} title={props.hint}>
      <span className="field-label">{props.label}</span>
      <span className="num-wrap">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit(text);
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (/^-?\d+([.,]\d+)?$/.test(e.target.value.trim())) commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
              const v = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, round(props.value + step)));
              props.onChange(v);
              setText(fmt(v));
            }
          }}
        />
        {props.unit && <span className="unit">{props.unit}</span>}
      </span>
    </label>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
function fmt(v: number): string {
  return Number.isFinite(v) ? String(round(v)) : '';
}

export function Slider(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  left?: string;
  right?: string;
  format?: (v: number) => string;
  id?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <div className="field slider">
      <div className="slider-head">
        <label htmlFor={id} className="field-label">
          {props.label}
        </label>
        <output htmlFor={id} className="slider-val">
          {props.format ? props.format(props.value) : props.value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${((props.value - props.min) / (props.max - props.min)) * 100}%` }}
      />
      {(props.left || props.right) && (
        <div className="slider-ends" aria-hidden="true">
          <span>{props.left}</span>
          <span>{props.right}</span>
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>(props: {
  label?: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`field seg-field${props.small ? ' small' : ''}`}>
      {props.label && <span className="field-label">{props.label}</span>}
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === props.value}
            title={o.title}
            className={o.value === props.value ? 'on' : ''}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; id?: string }) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <label className="field toggle" htmlFor={id} title={props.hint}>
      <input id={id} type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
      <span className="field-label">{props.label}</span>
    </label>
  );
}

export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  id?: string;
}) {
  const auto = useId();
  const id = props.id ?? auto;
  return (
    <label className="field select" htmlFor={id}>
      <span className="field-label">{props.label}</span>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Section(props: { title: string; aside?: ReactNode; children: ReactNode; open?: boolean; id?: string }) {
  return (
    <details className="section" open={props.open ?? true} id={props.id}>
      <summary>
        <span className="section-title">{props.title}</span>
        {props.aside && <span className="section-aside">{props.aside}</span>}
        <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="section-body">{props.children}</div>
    </details>
  );
}

export function Grid(props: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`grid g${props.cols ?? 2}`}>{props.children}</div>;
}
