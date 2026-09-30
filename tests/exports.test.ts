import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model/presets';
import { panelsSVG } from '../src/render/svgPanels';
import { shellSTL } from '../src/render/export';
import { decodeShare, encodeShare } from '../src/state/config';
import { solve } from '../src/solver/solve';

describe('exports', () => {
  const cfg = defaultConfig();
  const d = solve(cfg, { beamWidth: 12 }).designs[0];

  it('draws six panels at 1:1 in millimetres', () => {
    const svg = panelsSVG(d, cfg);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg.match(/class="o"/g)).toHaveLength(6);
    expect(svg).toContain('BACK');
    expect(svg).toMatch(/width="[\d.]+mm"/);
  });

  it('writes a binary STL of the hollow shell', async () => {
    const blob = shellSTL(d, cfg);
    const buf = new DataView(await blob.arrayBuffer());
    const triangles = buf.getUint32(80, true);
    expect(triangles).toBeGreaterThan(24);
    expect(buf.byteLength).toBe(84 + triangles * 50);
  });

  it('round-trips a share link', () => {
    const c = defaultConfig();
    c.parts.gpu.length = 301;
    c.prefs.edgeRadius = 17;
    const back = decodeShare('#' + encodeShare(c))!;
    expect(back.parts.gpu.length).toBe(301);
    expect(back.prefs.edgeRadius).toBe(17);
  });
});
