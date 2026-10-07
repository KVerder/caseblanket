import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { solve } from '../src/solver/solve';
import { partPoint, tiltedShapes } from '../src/solver/tilt';
import { deadSpaceL, defaultCell, shellField, shellGrid, wrapMetrics } from '../src/solver/shrinkwrap';
import { printPieces, DEFAULT_PRINT } from '../src/print/printable';
import type { Design } from '../src/solver/evaluate';
import type { DesignConfig } from '../src/model/types';

const tiltedBest = (ds: Design[]) => ds.filter((d) => !d.invalid && d.parts.some((p) => p.tilt)).sort((a, b) => b.flow.worstMargin - a.flow.worstMargin)[0];

describe('shrinkwrap mode', () => {
  let cfg: DesignConfig;
  let mold: Design[];
  it('ranks layouts on the moulded size, and tilted parts lose the wedge’s turn', () => {
    cfg = defaultConfig();
    cfg.prefs.mold = true;
    const r = solve(cfg, { wrapMetrics: false });
    mold = r.space;
    expect(r.designs.every((d) => d.mold && d.mold.volumeL > 0)).toBe(true);
    // The moulded shell holds less than the box around the same layout.
    expect(r.designs.every((d) => d.mold!.volumeL < d.volumeL)).toBe(true);
    const t = tiltedBest(mold);
    const part = t.parts.find((p) => p.tilt)!;
    const g = t.recipe.net.groups.find((x) => x.id === part.id)!;
    expect(g.losses.some((l) => l.label === 'tilt turn')).toBe(false);
  }, 120000);

  it('follows a tilted part: the wedge out to the flat panel is outside the shell', () => {
    const t = tiltedBest(mold);
    const part = t.parts.find((p) => p.tilt)!;
    const F = shellField(t, cfg, 0);
    const wrap = { ...cfg, prefs: { ...cfg.prefs, mold: false, shell: 'wrap' as const, organic: 0 } };
    const W0 = shellField(t, wrap, 0);
    const sh = tiltedShapes(part);
    const [L, Wd, T] = part.tilt!.size;
    for (const x of [0, L]) for (const y of [0, Wd]) for (const z of [0, T]) expect(F(partPoint(part, [x, y, z]))).toBeLessThan(-t.wall);
    // Points well inside the wedge, clear of the part's own air gap and of every other part.
    const others = t.parts.filter((p) => p !== part);
    let n = 0;
    for (let i = 1; i < 10; i++)
      for (let k = 1; k < 10; k++) {
        const q = partPoint(part, [(L * i) / 10, Wd / 2, T + ((L * Math.sin((part.tilt!.deg * Math.PI) / 180)) * k) / 10]);
        if (sh.wedge(q) > -6 || sh.clearance(q) < 10) continue;
        if (others.some((o) => [0, 1, 2].every((a) => q[a] > o.clearance.min[a] - 10 && q[a] < o.clearance.max[a] + 10))) continue;
        n++;
        expect(F(q)).toBeGreaterThan(-t.wall);
        expect(W0(q)).toBeLessThan(0); // the plain shrinkwrap fills it
      }
    expect(n).toBeGreaterThan(3);
  }, 120000);

  it('leaves less dead space than the tightest shrinkwrap, and reports it', () => {
    const t = tiltedBest(mold);
    const wrap = { ...cfg, prefs: { ...cfg.prefs, mold: false, shell: 'wrap' as const, organic: 0 } };
    const cell = defaultCell(t);
    const dMold = deadSpaceL(t, cfg, shellGrid(t, cfg, 0, cell));
    const dWrap = deadSpaceL(t, wrap, shellGrid(t, wrap, 0, cell));
    expect(dMold).toBeLessThan(dWrap - 1);
    expect(wrapMetrics(t, cfg, 0).deadL).toBeGreaterThanOrEqual(0);
  }, 120000);

  it('a moulded tilted design prints without loose fragments', () => {
    const t = tiltedBest(mold);
    const pieces = printPieces(t, cfg, DEFAULT_PRINT);
    expect(pieces.reduce((s, p) => s + (p.dropped ?? 0), 0)).toBe(0);
  }, 300000);
});
