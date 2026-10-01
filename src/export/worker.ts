/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { zip } from '../print/printable';
import { openfoamCase } from './openfoam';

self.onmessage = (e: MessageEvent<{ design: Design; cfg: DesignConfig }>) => {
  const post = (m: unknown, t: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, t);
  try {
    const enc = new TextEncoder();
    const files = openfoamCase(e.data.design, e.data.cfg).map((f) => ({ name: `caseblanket-openfoam/${f.path}`, data: enc.encode(f.data) }));
    const out = zip(files);
    post({ zip: out }, [out.buffer]);
  } catch (err) {
    post({ error: String(err instanceof Error ? err.message : err) });
  }
};
