/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import { solve } from './solve';

interface Req {
  id: number;
  cfg: DesignConfig;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, cfg } = e.data;
  try {
    const result = solve(cfg, {
      onProgress: (done, total) => (self as DedicatedWorkerGlobalScope).postMessage({ id, progress: done / total }),
    });
    (self as DedicatedWorkerGlobalScope).postMessage({ id, result });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err instanceof Error ? err.message : err) });
  }
};
