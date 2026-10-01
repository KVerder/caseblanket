/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { optimiseShaping, simulate, simulateSteady } from './run';
import type { CfdThermal } from './components';
import { NO_SHAPING, type Shaping } from './scene';

type Req =
  | { id: number; kind: 'simulate'; design: Design; cfg: DesignConfig; shaping: Shaping }
  | { id: number; kind: 'optimise'; design: Design; cfg: DesignConfig }
  | { id: number; kind: 'check'; designs: Design[]; cfg: DesignConfig };

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
    } else if (req.kind === 'check') {
      // Short runs of several designs, to compare the 3D sim with the airflow model.
      const out: { id: string; thermal: CfdThermal }[] = [];
      req.designs.forEach((d, i) => {
        post({ id: req.id, progress: { done: i, total: req.designs.length, label: d.id } });
        // Until the temperatures settle: a poorly ventilated case keeps heating for several seconds.
        const r = simulateSteady(d, req.cfg, NO_SHAPING, { cells: 9000, minSeconds: 1.4, maxSeconds: 8 });
        out.push({ id: d.id, thermal: r.thermal });
      });
      post({ id: req.id, checks: out });
    } else {
      const result = optimiseShaping(req.design, req.cfg, (done, total, label) => post({ id: req.id, progress: { done, total, label } }));
      post({ id: req.id, result });
    }
  } catch (err) {
    post({ id: req.id, error: String(err instanceof Error ? err.message : err) });
  }
};
