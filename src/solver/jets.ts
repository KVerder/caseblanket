import { dirVec, type Dir, type Vec3 } from './geometry';
import { partAxis, partLocal, partPoint } from './tilt';
import type { PlacedPart } from './evaluate';

/**
 * Where each fan's discharge goes inside the case.
 *
 * The zone network mixes every zone perfectly: a radiator blowing its warm exhaust straight onto
 * the back of the board 20 mm away and one blowing into open space give the board the same air.
 * Here each discharge is traced as a jet: rays from points across the fan disc (or the PSU's end
 * grille), straight along the blow direction, to the first part they meet. What reaches a part is
 * the jet's excess temperature over the zone, decayed with distance (jetDecay), averaged over the
 * rays; the network then gives that part (or the fan that breathes there) its local air, and lets
 * a jet caught by an exhaust fan's intake leave without mixing (a short circuit).
 *
 * Rays leaving the interior or travelling past 6 diameters count as mixed into the zone.
 */

export interface JetSource {
  /** Airflow group that blows (radiator, case fan, PSU). */
  group: string;
  part: PlacedPart;
  origins: Vec3[];
  dir: Vec3;
  /** Jet diameter, mm. */
  D: number;
}

export interface JetHit {
  from: string;
  /** Part the jet lands on. */
  part: string;
  /** Share of the jet's excess temperature that reaches the part, 0…1. */
  share: number;
  /** Mean distance to the part along the jet, mm. */
  distance: number;
}

/**
 * Excess temperature still in a fan's jet after x = s·D, as a share of its exit excess (estimate,
 * from round free-jet behaviour: a potential core of about one diameter, then a centreline excess
 * falling about as D/x; an axial fan's swirling jet spreads faster, so the core is kept short).
 */
export function jetDecay(s: number): number {
  if (s > 6) return 0;
  return s <= 1 ? 1 : 1 / s;
}

function insidePart(part: PlacedPart, p: Vec3): boolean {
  if (part.tilt) {
    const q = partLocal(part, p);
    const s = part.tilt.size;
    return q[0] >= 0 && q[0] <= s[0] && q[1] >= 0 && q[1] <= s[1] && q[2] >= 0 && q[2] <= s[2];
  }
  const b = part.body;
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

/** Points across a disc of radius r about (cx, cy) in a part's local face plane z, mapped to world. */
function discPoints(part: PlacedPart, cx: number, cy: number, r: number, z: number): Vec3[] {
  const out: Vec3[] = [];
  const n = 5;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const dx = ((i + 0.5) / n) * 2 - 1;
      const dy = ((j + 0.5) / n) * 2 - 1;
      if (dx * dx + dy * dy > 1) continue;
      out.push(partPoint(part, [cx + dx * r, cy + dy * r, z]));
    }
  return out;
}

/**
 * The jet a radiator or case fan blows into the case when it is an intake: from its inner face
 * (local z = 0; +e3 points at its vented panel) away from the panel, one disc per fan.
 */
export function fanJet(part: PlacedPart): JetSource | null {
  const fan = part.fan;
  if (!fan) return null;
  const [L, W] = part.tilt?.size ?? part.size;
  const n = part.kind === 'case-fan' ? 1 : (part.fanCount ?? 1);
  const start = (L - n * fan.size) / 2;
  const r = Math.min(fan.size, W) / 2;
  const origins = Array.from({ length: n }, (_, i) => discPoints(part, start + fan.size * (i + 0.5), W / 2, r * 0.9, 0)).flat();
  const e3 = partAxis(part, 2);
  const l = Math.hypot(e3[0], e3[1], e3[2]);
  return { group: part.id, part, origins, dir: [-e3[0] / l, -e3[1] / l, -e3[2] / l], D: fan.size };
}

/** The PSU's exhaust out of its AC end when that end is inside the case. */
export function psuJet(part: PlacedPart, acDir: Dir): JetSource {
  const [, W, T] = part.size;
  // The AC end is the part's local x = 0 face (acDir is opposite its e1).
  const origins: Vec3[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) origins.push(partPoint(part, [0, (W * (i + 0.5)) / 5, (T * (j + 0.5)) / 5]));
  return { group: 'psu', part, origins, dir: dirVec(acDir), D: Math.sqrt(W * T) };
}

/** Trace jets across the interior to the parts they land on. */
export function traceJets(sources: JetSource[], parts: PlacedPart[], interior: Vec3): JetHit[] {
  const out: JetHit[] = [];
  const STEP = 4;
  for (const src of sources) {
    const acc = new Map<string, { share: number; dist: number; n: number }>();
    const others = parts.filter((p) => p.id !== src.part.id);
    for (const o of src.origins) {
      // Start a step off the face so the source part itself is behind the ray.
      for (let x = STEP; x <= 6 * src.D; x += STEP) {
        const p: Vec3 = [o[0] + src.dir[0] * x, o[1] + src.dir[1] * x, o[2] + src.dir[2] * x];
        if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] > interior[0] || p[1] > interior[1] || p[2] > interior[2]) break;
        const hit = others.find((q) => insidePart(q, p));
        if (!hit) continue;
        const a = acc.get(hit.id) ?? { share: 0, dist: 0, n: 0 };
        a.share += jetDecay(x / src.D) / src.origins.length;
        a.dist += x;
        a.n++;
        acc.set(hit.id, a);
        break;
      }
    }
    for (const [part, a] of acc) if (a.share > 0.01) out.push({ from: src.group, part, share: Math.min(1, a.share), distance: a.dist / a.n });
  }
  return out;
}
