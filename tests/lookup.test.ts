import { describe, expect, it } from 'vitest';
import { applyLookup, validate } from '../src/catalog/claudeLookup';
import { applyGpuRow, searchRows } from '../src/catalog/online';
import { defaultConfig } from '../src/model/presets';

describe('Claude lookup validation', () => {
  const searched = new Set(['msi.com/graphics-card/example/specification']);

  it('keeps in-range values and only sources the search returned', () => {
    const r = validate(
      'video-card',
      {
        name: 'Example Liquid',
        cooling: 'AIO',
        length_mm: 280,
        height_mm: 9999, // nonsense, must be dropped
        thickness_mm: '51', // wrong type, must be dropped
        board_power_w: 360,
        has_card_fan: true,
        radiator_length_mm: 394,
        sources: [
          { url: 'https://www.msi.com/Graphics-Card/Example/Specification/', title: 'Spec' },
          { url: 'https://made-up.example/page', title: 'Invented' },
        ],
        notes: 'matched the SOC variant',
      },
      searched,
    );
    expect(r.values.length_mm).toBe(280);
    expect(r.values.height_mm).toBeNull();
    expect(r.values.thickness_mm).toBeNull();
    expect(r.values.cooling).toBe('aio');
    expect(r.sources.map((s) => s.title)).toEqual(['Spec']);
    expect(r.droppedSources).toEqual(['https://made-up.example/page']);
  });

  it('applies found values and flags the missing ones', () => {
    const r = validate('video-card', { name: 'X', cooling: 'aio', length_mm: 300, board_power_w: 450, sources: [] }, searched);
    const cfg = applyLookup(defaultConfig(), r);
    expect(cfg.parts.gpu.length).toBe(300);
    expect(cfg.parts.gpu.boardPowerW).toBe(450);
    expect(cfg.parts.gpu.height).toBe(defaultConfig().parts.gpu.height);
    expect(cfg.parts.gpu.source.provenance).toBe('unverified');
    expect(cfg.parts.gpu.source.missing).toEqual(expect.arrayContaining(['height', 'thickness', 'tube length']));
  });
});

describe('online catalogue helpers', () => {
  const rows = [
    { name: 'MSI SUPRIM LIQUID SOC', chipset: 'GeForce RTX 5080', length: 280 },
    { name: 'MSI SUPRIM SOC', chipset: 'GeForce RTX 5080', length: 338 },
    { name: 'Gigabyte WINDFORCE OC SFF', chipset: 'GeForce RTX 5070', length: 261 },
  ];

  it('matches all words in any order', () => {
    expect(searchRows('video-card', rows, 'liquid 5080').map((r) => r.name)).toEqual(['MSI SUPRIM LIQUID SOC']);
    expect(searchRows('video-card', rows, 'suprim').length).toBe(2);
  });

  it('recognises AIO cards and flags what the catalogue lacks', () => {
    const { spec, unknown } = applyGpuRow(defaultConfig().parts.gpu, rows[0]);
    expect(spec.cooling).toBe('aio');
    expect(spec.length).toBe(280);
    expect(spec.boardPowerW).toBe(360);
    expect(unknown).toContain('height');
  });
});
