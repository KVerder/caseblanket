/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import { funkify } from './funkify';

self.onmessage = (e: MessageEvent<{ id: number; cfg: DesignConfig }>) => {
  const { id, cfg } = e.data;
  const post = (m: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(m);
  try {
    const result = funkify(cfg, { picks: 4, progress: (done, total, label) => post({ id, progress: { done, total, label } }) });
    post({ id, result });
  } catch (err) {
    post({ id, error: String(err instanceof Error ? err.message : err) });
  }
};
