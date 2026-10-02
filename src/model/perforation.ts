/**
 * Perforation patterns: one definition for the 3D view, the panel drawings and the printed
 * pieces, so what you see is what prints. Each pattern's open area matches its vent style's
 * open ratio (the airflow model's number), with webs of at least 2 mm so FDM prints them
 * reliably (about five 0.42 mm lines).
 *
 *   hex     hexagonal holes, 10 mm across flats on a 12 mm pitch      open ≈ 0.69
 *   fine    round holes Ø4 on a 6 mm triangular pitch                open ≈ 0.40
 *   round   round holes Ø6 on an 8 mm triangular pitch               open ≈ 0.51
 *   slots   3 × 16 mm slots, 5.5 mm rows, 4 mm bridges, rows offset   open ≈ 0.42
 */

export type PatternKind = 'hex' | 'round' | 'slots';

export interface Perforation {
  kind: PatternKind;
  /** Centre-to-centre pitch along a row, mm. */
  pitch: number;
  /** Row spacing, mm. */
  rowPitch: number;
  /** Hole size: hex across flats or round diameter; slot width, mm. */
  size: number;
  /** Slots: length (end to end) and the bridge between slots in a row, mm. */
  length?: number;
  /** Smallest web between holes, mm. */
  web: number;
}

export const PERFORATIONS: Record<string, Perforation> = {
  hex: { kind: 'hex', pitch: 12, rowPitch: 12 * 0.866, size: 10, web: 2 },
  fine: { kind: 'round', pitch: 6, rowPitch: 6 * 0.866, size: 4, web: 2 },
  round: { kind: 'round', pitch: 8, rowPitch: 8 * 0.866, size: 6, web: 2 },
  slots: { kind: 'slots', pitch: 20, rowPitch: 5.5, size: 3, length: 16, web: 2.5 },
};

export function perforation(styleId: string): Perforation {
  return PERFORATIONS[styleId] ?? PERFORATIONS.round;
}

/** Open area share of a pattern (for checks against the vent style's open ratio). */
export function openShare(p: Perforation): number {
  if (p.kind === 'hex') return (Math.sqrt(3) / 2) * p.size * p.size / (p.pitch * p.rowPitch);
  if (p.kind === 'round') return (Math.PI * (p.size / 2) ** 2) / (p.pitch * p.rowPitch);
  const L = p.length!;
  const area = p.size * (L - p.size) + Math.PI * (p.size / 2) ** 2;
  return area / (p.pitch * p.rowPitch);
}

/** Half extents of one hole along the row (x) and across it (y), mm. */
export function holeHalfExtents(p: Perforation): [number, number] {
  if (p.kind === 'round') return [p.size / 2, p.size / 2];
  if (p.kind === 'hex') return [p.size / 2, p.size / 2 / 0.8660254];
  return [p.length! / 2, p.size / 2];
}

/**
 * Signed distance (mm) from (x, y) to the nearest hole of the pattern (negative inside a hole),
 * and that hole's centre. Rows run along x; odd rows are offset by half a pitch.
 */
export function holeAt(p: Perforation, x: number, y: number): { d: number; cx: number; cy: number } {
  const ri = Math.round(y / p.rowPitch);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let row = ri - 1; row <= ri + 1; row++) {
    const off = row & 1 ? p.pitch / 2 : 0;
    const cy = row * p.rowPitch;
    const ci = Math.round((x - off) / p.pitch);
    for (let col = ci - 1; col <= ci + 1; col++) {
      const cx = col * p.pitch + off;
      const dx = x - cx;
      const dy = y - cy;
      let d: number;
      if (p.kind === 'round') d = Math.hypot(dx, dy) - p.size / 2;
      else if (p.kind === 'hex') {
        // Honeycomb: flats facing along the row (±x), so every neighbour is pitch − size away.
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        const r = p.size / 2;
        d = Math.max(ax - r, ax * 0.5 + ay * 0.8660254 - r);
      } else {
        // Stadium along x: half-length of the straight part, radius = width / 2.
        const r = p.size / 2;
        const h = p.length! / 2 - r;
        const qx = Math.max(Math.abs(dx) - h, 0);
        d = Math.hypot(qx, dy) - r;
      }
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
    }
  }
  return { d: best, cx: bx, cy: by };
}

export const holeDistance = (p: Perforation, x: number, y: number) => holeAt(p, x, y).d;

/**
 * The same pattern as GLSL, for the 3D view's shaders (same numbers, same lattice):
 *   float cbHole(vec2 q, out vec2 centre)   signed distance to the nearest hole, and its centre
 *   const vec2 cbHalf                        half extents of a hole (along the row, across)
 */
export function holeGlsl(p: Perforation): string {
  const f = (v: number) => v.toFixed(4);
  const shape =
    p.kind === 'round'
      ? `length(d) - ${f(p.size / 2)}`
      : p.kind === 'hex'
        ? `max(abs(d.x) - ${f(p.size / 2)}, abs(d.x) * 0.5 + abs(d.y) * 0.8660254 - ${f(p.size / 2)})`
        : `length(vec2(max(abs(d.x) - ${f(p.length! / 2 - p.size / 2)}, 0.0), d.y)) - ${f(p.size / 2)}`;
  const [hx, hy] = holeHalfExtents(p);
  return `
const vec2 cbHalf = vec2(${f(hx)}, ${f(hy)});
float cbHole(vec2 q, out vec2 centre) {
  float best = 1e9;
  centre = vec2(0.0);
  float ri = floor(q.y / ${f(p.rowPitch)} + 0.5);
  for (int k = -1; k <= 1; k++) {
    float row = ri + float(k);
    float off = mod(row, 2.0) * ${f(p.pitch / 2)};
    float ci = floor((q.x - off) / ${f(p.pitch)} + 0.5);
    for (int m = -1; m <= 1; m++) {
      vec2 c = vec2((ci + float(m)) * ${f(p.pitch)} + off, row * ${f(p.rowPitch)});
      vec2 d = q - c;
      float h = ${shape};
      if (h < best) { best = h; centre = c; }
    }
  }
  return best;
}`;
}
