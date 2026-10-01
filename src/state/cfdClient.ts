import type { CfdThermal } from '../cfd/components';
import type { SimFrame, ShapingResult } from '../cfd/run';
import type { Shaping } from '../cfd/scene';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';

type Handlers = {
  frame?: (f: SimFrame) => void;
  progress?: (p: { done: number; total: number; label: string }) => void;
  result?: (r: ShapingResult) => void;
  checks?: (c: { id: string; thermal: CfdThermal }[]) => void;
  error?: (e: string) => void;
};

/**
 * Airflow simulations in a worker. One job at a time: starting a new one stops the old one
 * by restarting the worker, so a long simulation never blocks a newer request.
 */
export class CfdClient {
  private worker: Worker | null = null;
  private seq = 0;
  private handlers: Handlers = {};
  busy = false;

  private start(msg: Record<string, unknown>, h: Handlers) {
    this.stop();
    const id = ++this.seq;
    this.handlers = h;
    try {
      this.worker = new Worker(new URL('../cfd/worker.ts', import.meta.url), { type: 'module' });
    } catch {
      h.error?.('This browser cannot run the simulation in the background.');
      return;
    }
    this.busy = true;
    this.worker.onmessage = (e) => {
      const d = e.data as {
        id: number;
        frame?: SimFrame;
        progress?: { done: number; total: number; label: string };
        result?: ShapingResult;
        checks?: { id: string; thermal: CfdThermal }[];
        error?: string;
      };
      if (d.id !== id) return;
      if (d.frame) {
        this.handlers.frame?.(d.frame);
        if (d.frame.done) this.busy = false;
      }
      if (d.progress) this.handlers.progress?.(d.progress);
      if (d.checks) {
        this.busy = false;
        this.handlers.checks?.(d.checks);
      }
      if (d.result) {
        this.busy = false;
        this.handlers.result?.(d.result);
      }
      if (d.error) {
        this.busy = false;
        this.handlers.error?.(d.error);
      }
    };
    this.worker.onerror = (ev) => {
      ev.preventDefault();
      this.busy = false;
      this.handlers.error?.('The simulation stopped with an error.');
    };
    this.worker.postMessage({ id, ...msg });
  }

  simulate(design: Design, cfg: DesignConfig, shaping: Shaping, h: Handlers) {
    this.start({ kind: 'simulate', design, cfg, shaping }, h);
  }

  optimise(design: Design, cfg: DesignConfig, h: Handlers) {
    this.start({ kind: 'optimise', design, cfg }, h);
  }

  /** Short 3D runs of several designs; reports each one's component temperatures. */
  check(designs: Design[], cfg: DesignConfig, h: Handlers) {
    this.start({ kind: 'check', designs, cfg }, h);
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
}
