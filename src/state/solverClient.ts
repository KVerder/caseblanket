import type { DesignConfig } from '../model/types';
import { solve, type SolveResult } from '../solver/solve';

type Listener = { resolve: (r: SolveResult) => void; reject: (e: Error) => void; progress?: (p: number) => void };

/**
 * Runs the solver in a Web Worker so sliders stay responsive; falls back to the
 * main thread where workers are unavailable. A new request cancels a running one
 * by restarting the worker, so only the latest configuration is ever solved.
 */
export class SolverClient {
  private worker: Worker | null = null;
  private workerFailed = false;
  private seq = 0;
  private pending = new Map<number, Listener>();

  private createWorker(): Worker | null {
    if (this.workerFailed) return null;
    try {
      const w = new Worker(new URL('../solver/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, result, error, progress } = e.data as { id: number; result?: SolveResult; error?: string; progress?: number };
        const l = this.pending.get(id);
        if (!l) return;
        if (progress !== undefined) {
          l.progress?.(progress);
          return;
        }
        this.pending.delete(id);
        if (error) l.reject(new Error(error));
        else l.resolve(result!);
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        this.workerFailed = true;
        w.terminate();
        if (this.worker === w) this.worker = null;
        // Re-run whatever was waiting on the main thread.
        for (const [id, l] of this.pending) {
          this.pending.delete(id);
          l.reject(new Error('worker-failed'));
        }
      };
      return w;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  run(cfg: DesignConfig, progress?: (p: number) => void): Promise<SolveResult> {
    const id = ++this.seq;
    if (this.pending.size > 0) {
      for (const [, l] of this.pending) l.reject(new Error('superseded'));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    }
    if (!this.worker) this.worker = this.createWorker();
    if (!this.worker) {
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (id !== this.seq) return reject(new Error('superseded'));
          try {
            resolve(solve(cfg));
          } catch (e) {
            reject(e as Error);
          }
        }, 0),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject: (e) => (e.message === 'worker-failed' ? this.run(cfg, progress).then(resolve, reject) : reject(e)),
        progress,
      });
      this.worker!.postMessage({ id, cfg });
    });
  }

  dispose() {
    this.worker?.terminate();
  }
}
