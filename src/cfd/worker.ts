/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { optimiseShaping, simulate } from './run';
import type { Shaping } from './scene';

type Req =
  | { id: number; kind: 'simulate'; design: Design; cfg: DesignConfig; shaping: Shaping }
  | { id: number; kind: 'optimise'; design: Design; cfg: DesignConfig };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.kind === 'simulate') {
      simulate(req.design, req.cfg, req.shaping, {
        cells: 20000,
        seconds: 2.2,
        every: 8,
        frame: (f) => post({ id: req.id, frame: f }, [f.vel.buffer, f.T.buffer]),
      });
    } else {
      const result = optimiseShaping(req.design, req.cfg, (done, total, label) => post({ id: req.id, progress: { done, total, label } }));
      post({ id: req.id, result });
    }
  } catch (err) {
    post({ id: req.id, error: String(err instanceof Error ? err.message : err) });
  }
};
