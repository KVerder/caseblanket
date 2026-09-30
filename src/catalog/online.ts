import { boardFromFormFactor, genericRadiator, psuFromFormFactor } from '../model/presets';
import type { BoardFormFactor, CpuCoolerSpec, GpuSpec, MotherboardSpec, PsuFormFactor, PsuSpec } from '../model/types';

/**
 * Runtime lookup in docyx/pc-part-dataset (MIT, a PCPartPicker scrape, last updated July 2025).
 * It only knows some dimensions (GPU length, PSU and board form factor, AIO radiator size,
 * CPU TDP); the UI flags every field it could not fill so the user checks it.
 */
export const DATASET_URL = 'https://raw.githubusercontent.com/docyx/pc-part-dataset/main/data/json';
export const DATASET_HOME = 'https://github.com/docyx/pc-part-dataset';

export type CatalogKind = 'video-card' | 'cpu-cooler' | 'power-supply' | 'motherboard' | 'cpu';

export interface CatalogRow {
  name: string;
  [k: string]: unknown;
}

const cache = new Map<CatalogKind, Promise<CatalogRow[]>>();

export function loadCatalog(kind: CatalogKind): Promise<CatalogRow[]> {
  let p = cache.get(kind);
  if (!p) {
    p = fetch(`${DATASET_URL}/${kind}.json`).then((r) => {
      if (!r.ok) throw new Error(`Catalogue returned HTTP ${r.status}`);
      return r.json() as Promise<CatalogRow[]>;
    });
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return p;
}

export function rowTitle(kind: CatalogKind, r: CatalogRow): string {
  if (kind === 'video-card') return `${r.name}${r.chipset && !String(r.name).includes(String(r.chipset)) ? ` — ${r.chipset}` : ''}`;
  return r.name;
}

export function rowDetail(kind: CatalogKind, r: CatalogRow): string {
  switch (kind) {
    case 'video-card':
      return r.length ? `${r.length} mm long` : 'length unknown';
    case 'cpu-cooler':
      return r.size ? `${r.size} mm radiator (AIO)` : 'air cooler — height not in catalogue';
    case 'power-supply':
      return `${r.type ?? '?'} · ${r.wattage ?? '?'} W · ${r.efficiency ?? 'no rating'}`;
    case 'motherboard':
      return `${r.form_factor ?? '?'} · ${r.socket ?? ''}`;
    case 'cpu':
      return r.tdp ? `${r.tdp} W TDP` : 'TDP unknown';
  }
}

/** Search words in any order, case-insensitive; best (shortest) matches first. */
export function searchRows(kind: CatalogKind, rows: CatalogRow[], query: string, limit = 40): CatalogRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: CatalogRow[] = [];
  for (const r of rows) {
    const hay = `${r.name} ${kind === 'video-card' ? r.chipset ?? '' : ''}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) hits.push(r);
  }
  hits.sort((a, b) => String(a.name).length - String(b.name).length);
  return hits.slice(0, limit);
}

const CATALOG_SOURCE = (name: string, note: string) => ({ provenance: 'catalog' as const, url: DATASET_HOME, note: `${name}: ${note}` });

/**
 * Reference board power for common chips (NVIDIA/AMD reference specs as commonly published —
 * estimates; partner cards often draw more).
 */
const CHIP_POWER: [RegExp, number][] = [
  [/5090/, 575],
  [/5080/, 360],
  [/5070 ti/i, 300],
  [/5070/, 250],
  [/5060 ti/i, 180],
  [/4090/, 450],
  [/4080/, 320],
  [/4070 ti/i, 285],
  [/4070/, 200],
  [/3090 ti/i, 450],
  [/3090/, 350],
  [/3080/, 320],
  [/9070 xt/i, 304],
  [/9070/, 220],
  [/7900 xtx/i, 355],
  [/7900 xt/i, 315],
  [/6950 xt/i, 335],
  [/6900 xt/i, 300],
  [/6800 xt/i, 300],
];

const AIO_WORDS = /liquid|waterforce|\blc\b|hybrid|sea ?hawk|kingpin|k\|ngp\|n/i;

export function applyGpuRow(current: GpuSpec, r: CatalogRow): { spec: GpuSpec; unknown: string[] } {
  const chip = String(r.chipset ?? r.name);
  const power = CHIP_POWER.find(([re]) => re.test(chip))?.[1];
  const aio = AIO_WORDS.test(String(r.name));
  const unknown = ['height', 'thickness', 'tube length', 'radiator'];
  if (!power) unknown.push('board power');
  const spec: GpuSpec = {
    ...current,
    name: `${r.name}${String(r.name).includes(chip) ? '' : ` (${chip})`}`,
    length: typeof r.length === 'number' ? r.length : current.length,
    boardPowerW: power ?? current.boardPowerW,
    cooling: aio ? 'aio' : current.cooling === 'aio' && !aio ? 'air' : current.cooling,
    radiator: aio ? current.radiator ?? genericRadiator(360) : current.radiator,
    source: CATALOG_SOURCE(String(r.name), 'length from the catalogue; other dimensions kept from the previous card — check them.'),
  };
  if (!aio) spec.cardFan = true;
  return { spec, unknown };
}

export function applyCoolerRow(current: CpuCoolerSpec, r: CatalogRow): { spec: CpuCoolerSpec; unknown: string[] } {
  const size = typeof r.size === 'number' ? r.size : null;
  if (size) {
    return {
      spec: {
        ...current,
        name: r.name,
        kind: 'aio',
        height: current.kind === 'aio' ? current.height : 50,
        width: 75,
        depth: 75,
        radiator: genericRadiator(size),
        tubeLength: current.tubeLength ?? 400,
        source: CATALOG_SOURCE(r.name, `${size} mm radiator from the catalogue; radiator outline, pump height and tube length are generic.`),
      },
      unknown: ['pump height', 'radiator dimensions', 'tube length'],
    };
  }
  return {
    spec: {
      ...current,
      name: r.name,
      kind: current.kind === 'aio' ? 'air-downdraft' : current.kind,
      radiator: undefined,
      source: CATALOG_SOURCE(r.name, 'catalogue has no height or footprint for air coolers — enter them from the spec sheet.'),
    },
    unknown: ['height', 'footprint', 'cooler type'],
  };
}

const PSU_FF: Record<string, Exclude<PsuFormFactor, 'custom'>> = { ATX: 'atx', SFX: 'sfx', 'Flex ATX': 'flex-atx', TFX: 'tfx' };
const EFF: Record<string, number> = { plus: 0.85, bronze: 0.87, silver: 0.89, gold: 0.91, platinum: 0.93, titanium: 0.95 };

export function applyPsuRow(current: PsuSpec, r: CatalogRow): { spec: PsuSpec; unknown: string[] } {
  const ff = PSU_FF[String(r.type)];
  const watt = typeof r.wattage === 'number' ? r.wattage : current.ratedW;
  const base = ff ? psuFromFormFactor(ff, watt, r.name) : { ...current, name: r.name, ratedW: watt };
  // "SFX" in the catalogue also covers SFX-L; a model name usually says so.
  const sfxl = /sfx-?l\b/i.test(r.name);
  const spec: PsuSpec = sfxl ? { ...psuFromFormFactor('sfx-l', watt, r.name) } : base;
  spec.efficiency = EFF[String(r.efficiency ?? '').toLowerCase()] ?? 0.88;
  spec.source = CATALOG_SOURCE(r.name, `${r.type ?? 'unknown'} form factor from the catalogue; outline is the form-factor standard.`);
  const unknown = ff ? [] : ['form factor / dimensions'];
  if (ff === 'atx') unknown.push('length (ATX units range 140–200 mm)');
  return { spec, unknown };
}

const BOARD_FF: Record<string, Exclude<BoardFormFactor, 'custom'>> = {
  'Mini ITX': 'mini-itx',
  'Thin Mini ITX': 'thin-mini-itx',
  'Mini DTX': 'mini-dtx',
  'Micro ATX': 'micro-atx',
  ATX: 'atx',
};

export function applyBoardRow(current: MotherboardSpec, r: CatalogRow): { spec: MotherboardSpec; unknown: string[] } {
  const ff = BOARD_FF[String(r.form_factor)];
  if (!ff) {
    return {
      spec: { ...current, name: r.name, source: CATALOG_SOURCE(r.name, `form factor "${r.form_factor}" is not supported — using the previous outline.`) },
      unknown: ['outline'],
    };
  }
  const spec = boardFromFormFactor(ff, r.name);
  spec.source = CATALOG_SOURCE(r.name, `${r.form_factor} from the catalogue; outline from the standard, heights typical.`);
  return { spec, unknown: ['component height', 'socket position'] };
}
