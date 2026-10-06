import type { DesignConfig } from '../model/types';
import { funkify, type FunkResult } from '../solver/funkify';

export type FunkProgress = { done: number; total: number; label: string };

/** Runs Funkify in its own worker (it simulates in 3D, so it takes a while); main thread where workers fail. */
export class FunkClient {
  private worker: Worker | null = null;
  private seq = 0;

  run(cfg: DesignConfig, progress: (p: FunkProgress) => void): Promise<FunkResult> {
    this.cancel();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(new URL('../solver/funkWorker.ts', import.meta.url), { type: 'module' });
      } catch {
        setTimeout(() => {
          try {
            resolve(funkify(cfg, { picks: 4, progress: (done, total, label) => progress({ done, total, label }) }));
          } catch (e) {
            reject(e as Error);
          }
        }, 0);
        return;
      }
      this.worker = w;
      w.onmessage = (e) => {
        const m = e.data as { id: number; progress?: FunkProgress; result?: FunkResult; error?: string };
        if (m.id !== id) return;
        if (m.progress) return progress(m.progress);
        w.terminate();
        if (this.worker === w) this.worker = null;
        if (m.error) reject(new Error(m.error));
        else resolve(m.result!);
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        w.terminate();
        reject(new Error('worker-failed'));
      };
      w.postMessage({ id, cfg });
    });
  }

  cancel() {
    this.worker?.terminate();
    this.worker = null;
  }
}
