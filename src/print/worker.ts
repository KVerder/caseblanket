/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { buildManifest, DEFAULT_SLICER, manifestCsv } from './analysis';
import { fitTestPieces, printPieces, printReadme, stlBinary, zip, type PrintOptions } from './printable';
import { mountPlan } from './mounts';

self.onmessage = (e: MessageEvent<{ design: Design; cfg: DesignConfig; opt: PrintOptions; planOnly?: boolean }>) => {
  const { design, cfg, opt, planOnly } = e.data;
  const post = (m: unknown, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);
  try {
    const plan = mountPlan(design, cfg);
    const pieces = printPieces(design, cfg, opt, (done, total) => post({ progress: { done, total } }), plan);
    const enc = new TextEncoder();
    const manifest = buildManifest(design, cfg, pieces, opt.filament ?? 'petg', opt.slicer ?? DEFAULT_SLICER, !!opt.liner);
    if (planOnly) {
      post({ manifest, pieces: pieces.length, plan });
      return;
    }
    const files = pieces.map((p) => ({ name: `${p.name}.stl`, data: stlBinary(p.mesh, cfg) }));
    const fits = fitTestPieces(design, cfg, plan);
    for (const f of fits) files.push({ name: `${f.name.startsWith('fit-') ? 'fit-test/' : ''}${f.name}.stl`, data: stlBinary(f.mesh, { ...cfg, prefs: { ...cfg.prefs, orientation: 'console' } }) });
    files.push({ name: 'README.txt', data: enc.encode(printReadme(design, opt, pieces, manifest, plan, fits, cfg.prefs.ventStyleId)) });
    files.push({ name: 'manifest.csv', data: enc.encode(manifestCsv(manifest)) });
    const out = zip(files);
    post({ zip: out, pieces: pieces.length, manifest, plan }, [out.buffer]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
