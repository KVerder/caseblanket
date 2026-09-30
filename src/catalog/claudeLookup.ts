import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { boardFromFormFactor, FANS, psuFromFormFactor } from '../model/presets';
import type { BoardFormFactor, CoolerKind, DesignConfig, PsuFormFactor, RadiatorSpec, SourceInfo } from '../model/types';
import type { CatalogKind } from './online';

/**
 * Optional lookup of a part's published dimensions with Claude + web search, run from the
 * browser with the user's own API key. Values are only kept when the reply cites pages that
 * the search actually returned; everything is marked unverified until the user checks it.
 */

export type LookupKind = Exclude<CatalogKind, 'cpu'>;

export const LOOKUP_MODEL = 'claude-opus-5-5';

type Field = { key: string; kind: 'number' | 'string' | 'boolean'; min?: number; max?: number; values?: string[]; describe: string };

const FIELDS: Record<LookupKind, Field[]> = {
  'video-card': [
    { key: 'cooling', kind: 'string', values: ['aio', 'air'], describe: '"aio" for a card with its own liquid loop and radiator, otherwise "air"' },
    { key: 'length_mm', kind: 'number', min: 100, max: 420, describe: 'card length, bracket to far end' },
    { key: 'height_mm', kind: 'number', min: 60, max: 220, describe: 'card height from the PCIe fingers edge to the top edge' },
    { key: 'thickness_mm', kind: 'number', min: 15, max: 100, describe: 'card thickness (slot width) including backplate and shroud/pump' },
    { key: 'board_power_w', kind: 'number', min: 30, max: 1200, describe: 'total board power / TGP in watts' },
    { key: 'has_card_fan', kind: 'boolean', describe: 'true if the card itself carries a fan (for AIO cards: a VRM/memory fan)' },
    { key: 'radiator_length_mm', kind: 'number', min: 100, max: 600, describe: 'radiator length' },
    { key: 'radiator_width_mm', kind: 'number', min: 80, max: 200, describe: 'radiator width' },
    { key: 'radiator_total_thickness_mm', kind: 'number', min: 20, max: 120, describe: 'radiator thickness with its fans fitted' },
    { key: 'radiator_fan_count', kind: 'number', min: 1, max: 4, describe: 'number of radiator fans' },
    { key: 'radiator_fan_size_mm', kind: 'number', min: 80, max: 140, describe: 'radiator fan frame size (120 or 140)' },
    { key: 'tube_length_mm', kind: 'number', min: 100, max: 1200, describe: 'hose length' },
  ],
  'cpu-cooler': [
    { key: 'kind', kind: 'string', values: ['air-downdraft', 'air-tower', 'aio'], describe: '"air-downdraft" for low-profile top-down coolers, "air-tower", or "aio"' },
    { key: 'height_mm', kind: 'number', min: 15, max: 200, describe: 'air cooler: total height with fan; AIO: pump block height' },
    { key: 'width_mm', kind: 'number', min: 30, max: 200, describe: 'air cooler footprint width' },
    { key: 'depth_mm', kind: 'number', min: 30, max: 200, describe: 'air cooler footprint depth' },
    { key: 'fan_size_mm', kind: 'number', min: 40, max: 140, describe: 'air cooler fan frame size' },
    { key: 'fan_thickness_mm', kind: 'number', min: 8, max: 40, describe: 'air cooler fan thickness' },
    { key: 'radiator_length_mm', kind: 'number', min: 100, max: 600, describe: 'AIO radiator length' },
    { key: 'radiator_width_mm', kind: 'number', min: 80, max: 200, describe: 'AIO radiator width' },
    { key: 'radiator_core_thickness_mm', kind: 'number', min: 15, max: 80, describe: 'AIO radiator thickness without fans' },
    { key: 'radiator_fan_count', kind: 'number', min: 1, max: 4, describe: 'AIO radiator fan count' },
    { key: 'radiator_fan_size_mm', kind: 'number', min: 80, max: 140, describe: 'AIO radiator fan size' },
    { key: 'tube_length_mm', kind: 'number', min: 100, max: 1200, describe: 'AIO hose length' },
  ],
  'power-supply': [
    { key: 'form_factor', kind: 'string', values: ['sfx', 'sfx-l', 'flex-atx', 'tfx', 'atx'], describe: 'form factor' },
    { key: 'length_mm', kind: 'number', min: 60, max: 250, describe: 'depth from the AC inlet face to the cable face' },
    { key: 'width_mm', kind: 'number', min: 30, max: 200, describe: 'width' },
    { key: 'height_mm', kind: 'number', min: 20, max: 120, describe: 'height' },
    { key: 'rated_w', kind: 'number', min: 100, max: 2500, describe: 'rated output in watts' },
    { key: 'efficiency_rating', kind: 'string', values: ['bronze', 'silver', 'gold', 'platinum', 'titanium'], describe: '80 PLUS rating' },
  ],
  motherboard: [
    { key: 'form_factor', kind: 'string', values: ['mini-itx', 'thin-mini-itx', 'mini-dtx', 'micro-atx', 'atx'], describe: 'form factor' },
  ],
};

export interface LookupSource {
  url: string;
  title: string;
}

export interface LookupResult {
  kind: LookupKind;
  name: string;
  values: Record<string, number | string | boolean | null>;
  sources: LookupSource[];
  notes: string;
  /** URLs Claude cited that the search had not returned — dropped. */
  droppedSources: string[];
}

const KIND_LABEL: Record<LookupKind, string> = {
  'video-card': 'graphics card',
  'cpu-cooler': 'CPU cooler',
  'power-supply': 'power supply',
  motherboard: 'motherboard',
};

function prompt(kind: LookupKind, part: string): string {
  const fields = FIELDS[kind].map((f) => `  "${f.key}": ${f.kind === 'number' ? 'number | null' : f.kind === 'boolean' ? 'true | false | null' : f.values!.map((v) => `"${v}"`).join(' | ') + ' | null'}   // ${f.describe}`);
  return [
    `Find the published physical specifications of this ${KIND_LABEL[kind]}: "${part}".`,
    '',
    'Search the web, preferring the manufacturer\'s own product or specification page. Report a value only if a page you found in this search states it; otherwise use null. Do not estimate or fill in typical values. Convert inches to millimetres.',
    '',
    'Reply with one JSON object and nothing else, in this shape:',
    '{',
    '  "name": string,   // the exact product name you found',
    ...fields.map((l) => l + ','),
    '  "sources": [{ "url": string, "title": string }],   // the pages the numbers came from',
    '  "notes": string   // one or two sentences: which variant you matched, anything ambiguous',
    '}',
  ].join('\n');
}

function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude did not return the dimensions in the expected format. Try again or type them in.');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/** Keep only values of the right type and within physical ranges. */
export function validate(kind: LookupKind, raw: Record<string, unknown>, searched: Set<string>): LookupResult {
  const values: LookupResult['values'] = {};
  for (const f of FIELDS[kind]) {
    const v = raw[f.key];
    if (f.kind === 'number') values[f.key] = typeof v === 'number' && Number.isFinite(v) && v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity) ? v : null;
    else if (f.kind === 'boolean') values[f.key] = typeof v === 'boolean' ? v : null;
    else values[f.key] = typeof v === 'string' && f.values!.includes(v.toLowerCase()) ? v.toLowerCase() : null;
  }
  const sources: LookupSource[] = [];
  const droppedSources: string[] = [];
  const list = Array.isArray(raw.sources) ? raw.sources : [];
  for (const s of list) {
    const url = typeof s === 'object' && s && typeof (s as LookupSource).url === 'string' ? (s as LookupSource).url : null;
    if (!url) continue;
    if (searched.has(normalizeUrl(url))) sources.push({ url, title: String((s as LookupSource).title ?? url) });
    else droppedSources.push(url);
  }
  return {
    kind,
    name: typeof raw.name === 'string' ? raw.name : '',
    values,
    sources,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    droppedSources,
  };
}

export async function lookupWithClaude(kind: LookupKind, part: string, apiKey: string): Promise<LookupResult> {
  const sdk = await import('@anthropic-ai/sdk');
  const Anthropic = sdk.default;
  // The key goes from this browser straight to api.anthropic.com; caseblanket has no server.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const messages: BetaMessageParam[] = [{ role: 'user', content: prompt(kind, part) }];
  const searched = new Set<string>();
  let final: BetaMessage | null = null;
  try {
    for (let turn = 0; turn < 4; turn++) {
      const response = await client.beta.messages
        .stream({
          model: LOOKUP_MODEL,
          max_tokens: 16000,
          output_config: { effort: 'medium' },
          // Server-side fallback: if a safety classifier declines, the API retries on its recommended model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
          messages,
        })
        .finalMessage();
      for (const block of response.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) searched.add(normalizeUrl(r.url));
        }
      }
      if (response.stop_reason === 'pause_turn') {
        // The server paused its search loop; hand the turn back unchanged to let it resume.
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      final = response;
      break;
    }
  } catch (e) {
    if (e instanceof sdk.AuthenticationError) throw new Error('The API key was rejected. Check it in the Anthropic Console.');
    if (e instanceof sdk.PermissionDeniedError) throw new Error('This API key is not allowed to use this model or web search. Enable web search for your organization in the Anthropic Console.');
    if (e instanceof sdk.RateLimitError) throw new Error('Rate limited by the API. Wait a minute and try again.');
    if (e instanceof sdk.APIConnectionError) throw new Error('Could not reach api.anthropic.com from this page.');
    if (e instanceof sdk.APIError) throw new Error(`The API returned an error (${e.status ?? 'no status'}): ${e.message}`);
    throw e;
  }
  if (!final) throw new Error('The search did not finish. Try a more specific part name.');
  if (final.stop_reason === 'refusal') throw new Error('Claude declined this lookup. Type the dimensions in from the spec sheet instead.');
  if (final.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a more specific part name.');
  const text = final.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return validate(kind, extractJson(text), searched);
}

// ------------------------------------------------------------------ applying a result

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function radiatorFrom(values: LookupResult['values'], current: RadiatorSpec | undefined, coreKey: string): RadiatorSpec | undefined {
  const len = num(values.radiator_length_mm);
  const wid = num(values.radiator_width_mm);
  if (len === null && wid === null && current === undefined) return undefined;
  const fanSize = num(values.radiator_fan_size_mm) ?? current?.fan.size ?? 120;
  const fanBase = fanSize >= 140 ? FANS.generic140 : FANS.generic120;
  const fanT = current?.fan.thickness ?? 25;
  const total = num(values.radiator_total_thickness_mm);
  const core = num(values[coreKey]) ?? (total !== null ? Math.max(15, total - fanT) : current?.coreThickness ?? 27);
  return {
    length: len ?? current?.length ?? 275,
    width: wid ?? current?.width ?? fanSize,
    coreThickness: core,
    fanCount: num(values.radiator_fan_count) ?? current?.fanCount ?? 2,
    fan: { ...fanBase, thickness: fanT },
    portClearance: current?.portClearance ?? 25,
  };
}

function sourceFor(r: LookupResult, missing: string[]): SourceInfo {
  return {
    provenance: 'unverified',
    url: r.sources[0]?.url,
    note: `Found by Claude with web search (${r.sources.length} source${r.sources.length === 1 ? '' : 's'}). ${r.notes}`.trim(),
    missing,
  };
}

export function applyLookup(cfg: DesignConfig, r: LookupResult): DesignConfig {
  const next = structuredClone(cfg);
  const v = r.values;
  const name = r.name || undefined;
  if (r.kind === 'video-card') {
    const g = next.parts.gpu;
    const missing: string[] = [];
    const set = (key: string, field: 'length' | 'height' | 'thickness' | 'boardPowerW', label: string) => {
      const x = num(v[key]);
      if (x === null) missing.push(label);
      else g[field] = x;
    };
    set('length_mm', 'length', 'length');
    set('height_mm', 'height', 'height');
    set('thickness_mm', 'thickness', 'thickness');
    set('board_power_w', 'boardPowerW', 'board power');
    if (v.cooling === 'aio' || v.cooling === 'air') g.cooling = v.cooling;
    if (typeof v.has_card_fan === 'boolean') g.cardFan = v.has_card_fan;
    if (g.cooling === 'aio') {
      g.radiator = radiatorFrom(v, g.radiator, 'radiator_core_thickness_mm');
      if (v.radiator_length_mm === null) missing.push('radiator');
      const t = num(v.tube_length_mm);
      if (t === null) missing.push('tube length');
      else g.tubeLength = t;
    }
    g.name = name ?? g.name;
    g.source = sourceFor(r, missing);
  } else if (r.kind === 'cpu-cooler') {
    const c = next.parts.cooler;
    const missing: string[] = [];
    if (typeof v.kind === 'string') c.kind = v.kind as CoolerKind;
    const h = num(v.height_mm);
    if (h === null) missing.push(c.kind === 'aio' ? 'pump height' : 'height');
    else c.height = h;
    if (c.kind !== 'aio') {
      const w = num(v.width_mm);
      const d = num(v.depth_mm);
      if (w === null || d === null) missing.push('footprint');
      if (w !== null) c.width = w;
      if (d !== null) c.depth = d;
      const fs = num(v.fan_size_mm);
      const ft = num(v.fan_thickness_mm);
      if (fs !== null) c.fan = { ...c.fan, size: fs };
      if (ft !== null) c.fan = { ...c.fan, thickness: ft };
      c.radiator = undefined;
    } else {
      c.radiator = radiatorFrom(v, c.radiator, 'radiator_core_thickness_mm');
      if (v.radiator_length_mm === null) missing.push('radiator dimensions');
      const t = num(v.tube_length_mm);
      if (t === null) missing.push('tube length');
      else c.tubeLength = t;
    }
    c.name = name ?? c.name;
    c.source = sourceFor(r, missing);
  } else if (r.kind === 'power-supply') {
    const ff = typeof v.form_factor === 'string' ? (v.form_factor as Exclude<PsuFormFactor, 'custom'>) : null;
    const rated = num(v.rated_w) ?? next.parts.psu.ratedW;
    const base = ff ? psuFromFormFactor(ff, rated) : { ...next.parts.psu, ratedW: rated };
    const p = { ...base, name: name ?? base.name };
    const l = num(v.length_mm);
    const w = num(v.width_mm);
    const h = num(v.height_mm);
    if (l !== null) p.length = l;
    if (w !== null) p.width = w;
    if (h !== null) p.height = h;
    const eff: Record<string, number> = { bronze: 0.87, silver: 0.89, gold: 0.91, platinum: 0.93, titanium: 0.95 };
    if (typeof v.efficiency_rating === 'string') p.efficiency = eff[v.efficiency_rating] ?? p.efficiency;
    p.source = sourceFor(r, l === null ? ['length'] : []);
    next.parts.psu = p;
  } else {
    const ff = typeof v.form_factor === 'string' ? (v.form_factor as Exclude<BoardFormFactor, 'custom'>) : null;
    if (ff) next.parts.board = { ...boardFromFormFactor(ff, name), heatW: next.parts.board.heatW };
    next.parts.board.source = sourceFor(r, ['component height']);
  }
  return next;
}

export function describeValue(key: string, v: number | string | boolean | null): string {
  if (v === null) return 'not found';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return key.endsWith('_mm') ? `${v} mm` : key.endsWith('_w') ? `${v} W` : String(v);
  return v;
}
