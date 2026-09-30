import { describe, expect, it } from 'vitest';
import { allFrames, crossDir, localToWorld, orient, rectArea, rectSubtract, sideToWorld, type Box, type Dir } from '../src/solver/geometry';

describe('geometry', () => {
  it('crosses unit directions right-handedly', () => {
    expect(crossDir(0, 2)).toBe(4); // u × v = t
    expect(crossDir(2, 4)).toBe(0); // v × t = u
    expect(crossDir(4, 0)).toBe(2); // t × u = v
    expect(crossDir(0, 4)).toBe(3); // u × t = −v
  });

  it('enumerates the 24 proper rotations', () => {
    const frames = allFrames();
    expect(frames).toHaveLength(24);
    expect(new Set(frames.map((f) => f.d.join(''))).size).toBe(24);
    for (const f of frames) expect(crossDir(f.d[0], f.d[1])).toBe(f.d[2]);
  });

  it('adds clearances on the right world side', () => {
    const frame = { d: [2, 5, crossDir(2, 5)] as [Dir, Dir, Dir] }; // e1 → +v, e2 → −t
    const o = orient([100, 50, 20], frame, [
      { side: 0, depth: 10 }, // +e1 → +v
      { side: 2, depth: 4 }, // +e2 → −t
    ]);
    expect(o.body).toEqual([20, 100, 50]);
    expect(o.ext).toEqual([20, 110, 54]);
    expect(o.off).toEqual([0, 0, 4]);
    expect(sideToWorld(frame, 2)).toBe(5);
  });

  it('maps local points into the body box', () => {
    const frame = { d: [1, 2, crossDir(1, 2)] as [Dir, Dir, Dir] }; // e1 → −u
    const body: Box = { min: [10, 20, 30], max: [110, 70, 50] };
    expect(localToWorld(frame, body, [0, 0, 0])).toEqual([110, 20, 50]);
    expect(localToWorld(frame, body, [100, 50, 20])).toEqual([10, 70, 30]);
  });

  it('subtracts rectangles into disjoint pieces', () => {
    const a = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const pieces = rectSubtract(a, { x0: 20, y0: 30, x1: 60, y1: 70 });
    expect(pieces.reduce((s, r) => s + rectArea(r), 0)).toBe(100 * 100 - 40 * 40);
    expect(rectSubtract(a, { x0: 200, y0: 0, x1: 300, y1: 10 })).toEqual([a]);
  });
});
