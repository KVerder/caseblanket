import type { FanSpec } from '../model/types';

/**
 * Case noise estimate.
 *
 * Every source is a sound power level Lw (dB re 1 pW, A-weighted). Fans come from their datasheet
 * rating, read as sound pressure at 1 m (manufacturers rarely state sound power; estimate), so
 * Lw = SPL₁ₘ + 8 dB for a source radiating into a half-space (a case on a desk: SPL = Lw − 20·log10(r) − 8
 * at r = 1 m). Speed follows the fan laws: airflow ∝ N, pressure ∝ N², sound power +50·log10(N/N₀).
 * Installation adds penalties (estimates): a grille or panel close to the blades raises broadband
 * noise in proportion to how much of the fan face it blocks, and adds a tone at the blade-pass
 * frequency. Air leaving or entering a vent fast adds broadband vent noise. Sources add
 * incoherently.
 */

export const HEMISPHERE_DB = 8;

/** Datasheet-style noise and speed data of a fan (all estimates unless a fan says otherwise). */
export interface FanAcoustics {
  rpmMax: number;
  rpmMin: number;
  /** Noise at rpmMax, dB(A), read as SPL at 1 m. */
  dbaMax: number;
  blades: number;
}

/** Typical values by fan size when a fan has none of its own (estimates). */
export function fanAcoustics(fan: FanSpec): FanAcoustics {
  if (fan.acoustics) return fan.acoustics;
  if (fan.size <= 50) return { rpmMax: 6000, rpmMin: 2000, dbaMax: 35, blades: 7 };
  if (fan.size <= 100) return { rpmMax: 2500, rpmMin: 600, dbaMax: 30, blades: 7 };
  if (fan.size <= 125) return { rpmMax: 2000, rpmMin: 450, dbaMax: 30, blades: 7 };
  return { rpmMax: 1500, rpmMin: 350, dbaMax: 28, blades: 7 };
}

export interface NoiseSource {
  id: string;
  label: string;
  /** Sound power, dB(A). */
  lw: number;
  /** Blade-pass frequency, Hz, for fans. */
  bpfHz?: number;
  /** Penalties included in lw, dB. */
  penaltyDb?: number;
  tonal?: boolean;
}

export const sumDb = (levels: number[]) => (levels.length ? 10 * Math.log10(levels.reduce((s, l) => s + 10 ** (l / 10), 0)) : -Infinity);
export const splAt1m = (lw: number) => lw - HEMISPHERE_DB;

/** Sound power of `count` identical fans at speed fraction s (of rpmMax). */
export function fanLw(fan: FanSpec, count: number, s: number): number {
  const a = fanAcoustics(fan);
  return a.dbaMax + HEMISPHERE_DB + 50 * Math.log10(Math.max(1e-3, s)) + 10 * Math.log10(Math.max(1, count));
}

/**
 * Installation penalty for a grille or panel `gap` mm from a fan's face (estimate): broadband
 * up to +6 dB × the share of the face it blocks, falling to 0 at a quarter of the fan diameter; a
 * tone at the blade-pass frequency when the obstruction is within an eighth of the diameter.
 */
export function obstructionPenalty(fan: FanSpec, gapMm: number, blockedShare: number) {
  const reach = fan.size / 4;
  const broadband = 6 * Math.max(0, Math.min(1, blockedShare)) * Math.max(0, 1 - gapMm / reach);
  const tonal = gapMm < fan.size / 8 && blockedShare > 0.2;
  return { db: broadband + (tonal ? 2 : 0), tonal };
}

/** Broadband noise of air through a vent (estimate): 30 dB(A) for 100 cm² at 5 m/s, +60·log10 of speed, +10·log10 of area. */
export function ventLw(areaM2: number, flowM3s: number): number {
  if (areaM2 <= 0 || flowM3s <= 0) return -Infinity;
  const v = flowM3s / areaM2;
  return 30 + 60 * Math.log10(v / 5) + 10 * Math.log10(areaM2 / 0.01);
}

export const bpf = (fan: FanSpec, s: number) => (fanAcoustics(fan).blades * fanAcoustics(fan).rpmMax * s) / 60;
