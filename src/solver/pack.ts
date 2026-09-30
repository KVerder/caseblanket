import type { ItemDef, Variant } from './items';

/**
 * Beam search over placements. Every item is a set of footprint rectangles that
 * occupy one or both layers; rectangles in a shared layer may not overlap.
 * Placement candidates are corner points of already-placed rectangles
 * (including "the same spot in the other layer", which is how sandwiches form).
 */

export interface Placement {
  item: number;
  variant: number;
  u: number;
  v: number;
}

interface PRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  bits: number;
  tExt: number;
  item: number;
}

export interface PackNode {
  placements: Placement[];
  used: number;
  rects: PRect[];
  u1: number;
  v0: number;
  v1: number;
  /** Max rect height in layer A/M only, layer B only, and spanning. */
  tA: number;
  tB: number;
  tSpan: number;
  commitU1: number;
  commitV0: number;
  commitV1: number;
  area: number;
  cost: number;
  slot?: [number, number];
  finger?: [number, number];
}

export interface PackOptions {
  twoLayer: boolean;
  spine: number;
  wall: number;
  /** 1 = minimise thickness only, 0 = volume only. */
  alpha: number;
  beamWidth: number;
  /** Interior limits along u, v, t (0 = none). */
  limits: [number, number, number];
  /** Prune layouts whose in-plane riser path already exceeds this (0 = no riser). */
  riserLength: number;
  /** Two-layer families must actually use the back layer, or they duplicate the one-layer family. */
  requireBack?: boolean;
}

const EPS = 1e-6;

export function interiorThickness(n: Pick<PackNode, 'tA' | 'tB' | 'tSpan'>, twoLayer: boolean, spine: number): number {
  if (!twoLayer) return Math.max(n.tA, n.tSpan);
  const layered = n.tB > 0 ? n.tA + spine + n.tB : n.tA;
  return Math.max(layered, n.tSpan);
}

function nodeCost(n: PackNode, items: ItemDef[], opt: PackOptions): number {
  let remArea = 0;
  let remT = 0;
  for (let i = 0; i < items.length; i++) {
    if (n.used & (1 << i)) continue;
    remArea += items[i].minArea;
    remT = Math.max(remT, items[i].minT);
  }
  const U = n.u1;
  const V = n.v1 - n.v0;
  const layers = opt.twoLayer ? 2 : 1;
  const est = Math.max(U * V, (n.area + remArea) / layers);
  const scale = U * V > 0 ? Math.sqrt(est / (U * V)) : 1;
  const T = Math.max(interiorThickness(n, opt.twoLayer, opt.spine), remT);
  const ext = [U * scale + 2 * opt.wall, V * scale + 2 * opt.wall, T + 2 * opt.wall];
  const thick = Math.min(ext[0], ext[1], ext[2]);
  const vol = ext[0] * ext[1] * ext[2];
  // Never weight either term to exactly zero, so equally thin layouts still prefer the smaller one.
  const a = Math.min(0.97, Math.max(0.03, opt.alpha));
  return a * Math.log(thick) + (1 - a) * Math.log(vol);
}

function candidatePoints(n: PackNode, w: number, h: number, rear: boolean): [number, number][] {
  const pts: [number, number][] = [];
  const push = (u: number, v: number) => {
    if (u < -EPS) return;
    if (rear && Math.abs(u) > EPS) return;
    pts.push([Math.max(0, u), v]);
  };
  if (n.rects.length === 0) {
    push(0, 0);
    return pts;
  }
  for (const r of n.rects) {
    push(r.u1, r.v0);
    push(r.u1, r.v1 - h);
    push(r.u0, r.v1);
    push(r.u1 - w, r.v1);
    push(r.u0, r.v0 - h);
    push(r.u1 - w, r.v0 - h);
    push(r.u0, r.v0);
    push(r.u1 - w, r.v0);
    push(r.u0, r.v1 - h);
    push(0, r.v1);
    push(0, r.v0 - h);
    push(0, r.v0);
    push(n.u1 - w, r.v1);
    push(r.u1, n.v1 - h);
    push(r.u1, n.v0);
  }
  push(0, n.v1);
  push(0, n.v0 - h);
  push(n.u1 - w, n.v0 - h);
  push(n.u1 - w, n.v1);
  // de-duplicate
  const seen = new Set<string>();
  return pts.filter(([u, v]) => {
    const k = `${u.toFixed(2)},${v.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function tryPlace(n: PackNode, itemIdx: number, variant: Variant, variantIdx: number, u: number, v: number, opt: PackOptions): PackNode | null {
  const newRects: PRect[] = [];
  for (const p of variant.parts) {
    const r: PRect = {
      u0: u + p.du,
      v0: v + p.dv,
      u1: u + p.du + p.o.ext[0],
      v1: v + p.dv + p.o.ext[1],
      bits: variant.bits,
      tExt: p.o.ext[2],
      item: itemIdx,
    };
    for (const q of n.rects) {
      if ((q.bits & r.bits) === 0) continue;
      if (r.u0 < q.u1 - EPS && q.u0 < r.u1 - EPS && r.v0 < q.v1 - EPS && q.v0 < r.v1 - EPS) return null;
    }
    newRects.push(r);
  }
  let u1 = n.u1;
  let v0 = n.v0;
  let v1 = n.v1;
  let tA = n.tA;
  let tB = n.tB;
  let tSpan = n.tSpan;
  let area = n.area;
  for (const r of newRects) {
    u1 = Math.max(u1, r.u1);
    v0 = Math.min(v0, r.v0);
    v1 = Math.max(v1, r.v1);
    if (r.bits === 3) tSpan = Math.max(tSpan, r.tExt);
    else if (r.bits === 1) tA = Math.max(tA, r.tExt);
    else tB = Math.max(tB, r.tExt);
  }
  // Union area of the variant's own rects is approximated by the bounding box when they overlap.
  area += variant.parts.length === 1 ? variant.w * variant.h : variant.parts.reduce((s, p) => s + p.o.ext[0] * p.o.ext[1], 0) * 0.85;
  if (n.rects.length === 0) {
    v0 = Math.min(...newRects.map((r) => r.v0));
    v1 = Math.max(...newRects.map((r) => r.v1));
  }

  // Walls that fan faces are already committed to may not move.
  if (!Number.isNaN(n.commitU1) && u1 > n.commitU1 + EPS) return null;
  if (!Number.isNaN(n.commitV0) && v0 < n.commitV0 - EPS) return null;
  if (!Number.isNaN(n.commitV1) && v1 > n.commitV1 + EPS) return null;
  let commitU1 = n.commitU1;
  let commitV0 = n.commitV0;
  let commitV1 = n.commitV1;
  for (const c of variant.commits) {
    // Each committed face belongs to one of the variant's parts; check that part's rect edge.
    for (let k = 0; k < variant.parts.length; k++) {
      const p = variant.parts[k];
      if (p.face !== c || !p.faceRequired) continue;
      const r = newRects[k];
      if (c === 0) {
        if (r.u1 < u1 - EPS) return null;
        commitU1 = u1;
      } else if (c === 1) {
        if (r.u0 > EPS) return null;
      } else if (c === 2) {
        if (r.v1 < v1 - EPS) return null;
        commitV1 = v1;
      } else if (c === 3) {
        if (r.v0 > v0 + EPS) return null;
        commitV0 = v0;
      }
    }
  }

  let slot = n.slot;
  let finger = n.finger;
  if (variant.riserSlot) slot = [u + variant.riserSlot[0], v + variant.riserSlot[1]];
  if (variant.riserFinger) finger = [u + variant.riserFinger[0], v + variant.riserFinger[1]];
  if (opt.riserLength > 0 && slot && finger) {
    if (Math.abs(slot[0] - finger[0]) + Math.abs(slot[1] - finger[1]) + 30 > opt.riserLength) return null;
  }

  const [lu, lv, lt] = opt.limits;
  if (lu > 0 && u1 + 2 * opt.wall > lu + EPS) return null;
  if (lv > 0 && v1 - v0 + 2 * opt.wall > lv + EPS) return null;
  const child: PackNode = {
    placements: [...n.placements, { item: itemIdx, variant: variantIdx, u, v }],
    used: n.used | (1 << itemIdx),
    rects: [...n.rects, ...newRects],
    u1,
    v0,
    v1,
    tA,
    tB,
    tSpan,
    commitU1,
    commitV0,
    commitV1,
    area,
    cost: 0,
    slot,
    finger,
  };
  if (lt > 0 && interiorThickness(child, opt.twoLayer, opt.spine) + 2 * opt.wall > lt + EPS) return null;
  return child;
}

function nodeKey(n: PackNode): string {
  return n.placements
    .map((p) => `${p.item}:${p.variant}:${p.u.toFixed(1)}:${(p.v - n.v0).toFixed(1)}`)
    .sort()
    .join('|');
}

export function pack(items: ItemDef[], opt: PackOptions): PackNode[] {
  let beam: PackNode[] = [
    {
      placements: [],
      used: 0,
      rects: [],
      u1: 0,
      v0: 0,
      v1: 0,
      tA: 0,
      tB: 0,
      tSpan: 0,
      commitU1: NaN,
      commitV0: NaN,
      commitV1: NaN,
      area: 0,
      cost: 0,
    },
  ];
  const full = (1 << items.length) - 1;
  for (let step = 0; step < items.length; step++) {
    let pool: PackNode[] = [];
    let threshold = Infinity;
    const seen = new Set<string>();
    const trim = () => {
      pool.sort((a, b) => a.cost - b.cost);
      pool = pool.slice(0, opt.beamWidth);
      threshold = pool.length >= opt.beamWidth ? pool[pool.length - 1].cost : Infinity;
    };
    for (const node of beam) {
      for (let i = 0; i < items.length; i++) {
        if (node.used & (1 << i)) continue;
        // The first item placed is always item 0 (the board/board group), anchoring the layout.
        if (step === 0 && i !== 0) continue;
        const item = items[i];
        for (let vi = 0; vi < item.variants.length; vi++) {
          const variant = item.variants[vi];
          for (const [u, v] of candidatePoints(node, variant.w, variant.h, variant.rearAnchor)) {
            const child = tryPlace(node, i, variant, vi, u, v, opt);
            if (!child) continue;
            if (opt.requireBack && step === items.length - 1 && child.tB <= 0) continue;
            child.cost = nodeCost(child, items, opt);
            if (child.cost >= threshold) continue;
            const key = nodeKey(child);
            if (seen.has(key)) continue;
            seen.add(key);
            pool.push(child);
            if (pool.length > opt.beamWidth * 4) trim();
          }
        }
      }
    }
    trim();
    beam = pool;
    if (beam.length === 0) return [];
  }
  return beam.filter((n) => n.used === full);
}
