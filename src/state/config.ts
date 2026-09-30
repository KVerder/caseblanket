import { defaultConfig } from '../model/presets';
import type { DesignConfig } from '../model/types';

const STORAGE_KEY = 'caseblanket:config:v1';

/** Deep-merge a stored/shared config over the defaults so older saves keep working. */
function mergeDefaults<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object' || Array.isArray(base)) {
    return (over === undefined ? base : (over as T)) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? mergeDefaults(out[k], v) : v;
  }
  return out as T;
}

export function normalizeConfig(raw: unknown): DesignConfig {
  return mergeDefaults(defaultConfig(), raw);
}

export function loadStoredConfig(): DesignConfig | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? normalizeConfig(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

export function storeConfig(cfg: DesignConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable: nothing to do */
  }
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '==='.slice((b.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeShare(cfg: DesignConfig): string {
  return 'c=' + toBase64Url(JSON.stringify(cfg));
}

export function decodeShare(hash: string): DesignConfig | null {
  const m = hash.replace(/^#/, '').match(/(?:^|&)c=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    return normalizeConfig(JSON.parse(fromBase64Url(m[1])));
  } catch {
    return null;
  }
}

export function initialConfig(): DesignConfig {
  if (typeof location !== 'undefined') {
    const shared = decodeShare(location.hash);
    if (shared) return shared;
  }
  return loadStoredConfig() ?? defaultConfig();
}

/** Immutable update via a mutating recipe on a deep copy. */
export function produce<T>(value: T, recipe: (draft: T) => void): T {
  const copy = structuredClone(value);
  recipe(copy);
  return copy;
}

export const IS_ARTIFACT = import.meta.env.VITE_TARGET === 'artifact';
