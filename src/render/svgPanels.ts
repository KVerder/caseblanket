import type { DesignConfig, PanelName } from '../model/types';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Dir, type Rect } from '../solver/geometry';

export function panelName(d: Dir, orientation: DesignConfig['prefs']['orientation']): PanelName {
  const tower: PanelName[] = ['front', 'back', 'top', 'bottom', 'left', 'right'];
  const consoleNames: PanelName[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
  return (orientation === 'tower' ? tower : consoleNames)[d];
}

function holes(r: Rect, style: string, ox: number, oy: number, budget: { n: number }): string {
  const out: string[] = [];
  const pitch = style === 'fine' ? 3 : style === 'slots' ? 4 : 6;
  const rad = style === 'fine' ? 1.1 : 2.4;
  if (style === 'slots') {
    for (let y = r.y0 + 3; y <= r.y1 - 3 && budget.n > 0; y += pitch) {
      out.push(`<rect x="${(ox + r.x0 + 2).toFixed(2)}" y="${(oy + y - 0.9).toFixed(2)}" width="${Math.max(0, r.x1 - r.x0 - 4).toFixed(2)}" height="1.8" rx="0.9"/>`);
      budget.n--;
    }
    return out.join('');
  }
  let row = 0;
  for (let y = r.y0 + rad + 1; y <= r.y1 - rad - 1; y += pitch * 0.866, row++) {
    for (let x = r.x0 + rad + 1 + (row % 2 ? pitch / 2 : 0); x <= r.x1 - rad - 1; x += pitch) {
      if (budget.n-- <= 0) return out.join('');
      if (style === 'hex') {
        const pts: string[] = [];
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          pts.push(`${(ox + x + (rad + 0.2) * Math.cos(a)).toFixed(2)},${(oy + y + (rad + 0.2) * Math.sin(a)).toFixed(2)}`);
        }
        out.push(`<polygon points="${pts.join(' ')}"/>`);
      } else {
        out.push(`<circle cx="${(ox + x).toFixed(2)}" cy="${(oy + y).toFixed(2)}" r="${rad}"/>`);
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
      .map((v) => holes(toDrawing(v.rect), style, x, rowY, budget))
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
