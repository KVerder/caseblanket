/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { printPieces, printReadme, stlBinary, zip, type PrintOptions } from './printable';

self.onmessage = (e: MessageEvent<{ design: Design; cfg: DesignConfig; opt: PrintOptions }>) => {
  const { design, cfg, opt } = e.data;
  const post = (m: unknown, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);
  try {
    const pieces = printPieces(design, cfg, opt, (done, total) => post({ progress: { done, total } }));
    const enc = new TextEncoder();
    const files = pieces.map((p) => ({ name: `${p.name}.stl`, data: stlBinary(p.mesh, cfg) }));
    files.push({ name: 'README.txt', data: enc.encode(printReadme(design, opt, pieces)) });
    const out = zip(files);
    post({ zip: out, pieces: pieces.length }, [out.buffer]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
