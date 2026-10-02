import { holeHalfExtents, perforation } from '../model/perforation';
import type { DesignConfig, PanelName } from '../model/types';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Dir, type Rect } from '../solver/geometry';

export function panelName(d: Dir, orientation: DesignConfig['prefs']['orientation']): PanelName {
  const tower: PanelName[] = ['front', 'back', 'top', 'bottom', 'left', 'right'];
  const consoleNames: PanelName[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
  return (orientation === 'tower' ? tower : consoleNames)[d];
}

/**
 * The perforation of one vent as drawn: whole holes of the style's pattern inside the vent with a
 * 1.5 mm border, at the same lattice as the printed pieces (wall coordinates). `toDrawing` maps
 * wall coordinates to the drawing (it may mirror x and flips y).
 */
function holes(r: Rect, style: string, place: (x: number, y: number) => [number, number], budget: { n: number }): string {
  const p = perforation(style);
  const [hx, hy] = holeHalfExtents(p);
  const out: string[] = [];
  const row0 = Math.ceil((r.y0 + 1.5 + hy) / p.rowPitch);
  const row1 = Math.floor((r.y1 - 1.5 - hy) / p.rowPitch);
  for (let row = row0; row <= row1; row++) {
    const off = row & 1 ? p.pitch / 2 : 0;
    const cy = row * p.rowPitch;
    for (let col = Math.ceil((r.x0 + 1.5 + hx - off) / p.pitch); ; col++) {
      const cx = col * p.pitch + off;
      if (cx + hx > r.x1 - 1.5) break;
      if (budget.n-- <= 0) return out.join('');
      const [X, Y] = place(cx, cy);
      if (p.kind === 'round') out.push(`<circle cx="${X.toFixed(2)}" cy="${Y.toFixed(2)}" r="${(p.size / 2).toFixed(2)}"/>`);
      else if (p.kind === 'slots') out.push(`<rect x="${(X - hx).toFixed(2)}" y="${(Y - hy).toFixed(2)}" width="${(2 * hx).toFixed(2)}" height="${(2 * hy).toFixed(2)}" rx="${hy.toFixed(2)}"/>`);
      else {
        // Flats facing along the row (vertical edges at ±size/2): vertices at 30° + k·60°.
        const R = p.size / 2 / 0.8660254;
        const pts: string[] = [];
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          pts.push(`${(X + R * Math.cos(a)).toFixed(2)},${(Y + R * Math.sin(a)).toFixed(2)}`);
        }
        out.push(`<polygon points="${pts.join(' ')}"/>`);
      }
    }
  }
  return out.join('');
}

/**
 * Flat drawings of all six panels at 1:1 in mm: outline, perforated regions and I/O cut-outs.
 * Panels are drawn as seen from outside the case; bends and fillets are not unfolded,
 * so treat the outline as the flat face and add bend allowances for sheet metal.
 */
export function panelsSVG(design: Design, cfg: DesignConfig): string {
  const w = design.wall;
  const gap = 30;
  const style = cfg.prefs.ventStyleId;
  const budget = { n: 60000 };
  let x = gap;
  let rowY = gap + 14;
  let rowH = 0;
  const maxRowW = 1400;
  const blocks: string[] = [];
  let totalW = 0;
  for (const d of [0, 1, 2, 3, 4, 5] as Dir[]) {
    const [xa, ya] = wallAxes(axisOf(d));
    const pw = design.exterior[xa];
    const ph = design.exterior[ya];
    if (x + pw > maxRowW && x > gap) {
      x = gap;
      rowY += rowH + gap + 18;
      rowH = 0;
    }
    // Drawn as seen from outside: x mirrored on walls facing the negative axis, SVG y points down.
    const mirror = signOf(d) < 0;
    const toDrawing = (r: Rect): Rect => {
      const x0 = w + r.x0;
      const x1 = w + r.x1;
      const y0 = w + r.y0;
      const y1 = w + r.y1;
      return { x0: mirror ? pw - x1 : x0, x1: mirror ? pw - x0 : x1, y0: ph - y1, y1: ph - y0 };
    };
    const vents = design.vents.filter((v) => v.wall === d);
    const cut = vents
      .filter((v) => v.kind === 'io' || v.kind === 'bracket')
      .map((v) => {
        const r = toDrawing(v.rect);
        return `<rect x="${(x + r.x0).toFixed(2)}" y="${(rowY + r.y0).toFixed(2)}" width="${(r.x1 - r.x0).toFixed(2)}" height="${(r.y1 - r.y0).toFixed(2)}"/>`;
      })
      .join('');
    const perf = vents
      .filter((v) => v.kind !== 'io' && v.kind !== 'bracket')
      .map((v) => holes(v.rect, style, (cx, cy) => [x + (mirror ? pw - (w + cx) : w + cx), rowY + ph - (w + cy)], budget))
      .join('');
    const name = panelName(d, cfg.prefs.orientation);
    blocks.push(
      `<g><text x="${x}" y="${rowY - 5}" class="t">${name.toUpperCase()} — ${pw.toFixed(1)} × ${ph.toFixed(1)} mm</text>` +
        `<rect x="${x}" y="${rowY}" width="${pw.toFixed(2)}" height="${ph.toFixed(2)}" rx="${Math.min(cfg.prefs.edgeRadius, 20)}" class="o"/>` +
        `<g class="c">${cut}</g><g class="h">${perf}</g></g>`,
    );
    x += pw + gap;
    totalW = Math.max(totalW, x);
    rowH = Math.max(rowH, ph);
  }
  const totalH = rowY + rowH + gap;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}mm" height="${totalH}mm" viewBox="0 0 ${totalW} ${totalH}">
<style>.o{fill:none;stroke:#000;stroke-width:0.3}.c rect{fill:none;stroke:#c00;stroke-width:0.3}.h *{fill:none;stroke:#00c;stroke-width:0.15}.t{font:6px sans-serif;fill:#333}</style>
<!-- caseblanket panel drawings, 1 unit = 1 mm. Black: panel outline. Red: cut-outs. Blue: perforation. -->
${blocks.join('\n')}
</svg>`;
}
