/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { buildManifest, DEFAULT_SLICER, manifestCsv } from './analysis';
import { printPieces, printReadme, stlBinary, zip, type PrintOptions } from './printable';

self.onmessage = (e: MessageEvent<{ design: Design; cfg: DesignConfig; opt: PrintOptions; planOnly?: boolean }>) => {
  const { design, cfg, opt, planOnly } = e.data;
  const post = (m: unknown, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);
  try {
    const pieces = printPieces(design, cfg, opt, (done, total) => post({ progress: { done, total } }));
    const enc = new TextEncoder();
    const manifest = buildManifest(design, cfg, pieces, opt.filament ?? 'petg', opt.slicer ?? DEFAULT_SLICER, !!opt.liner);
    if (planOnly) {
      post({ manifest, pieces: pieces.length });
      return;
    }
    const files = pieces.map((p) => ({ name: `${p.name}.stl`, data: stlBinary(p.mesh, cfg) }));
    files.push({ name: 'README.txt', data: enc.encode(printReadme(design, opt, pieces, manifest)) });
    files.push({ name: 'manifest.csv', data: enc.encode(manifestCsv(manifest)) });
    const out = zip(files);
    post({ zip: out, pieces: pieces.length, manifest }, [out.buffer]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
