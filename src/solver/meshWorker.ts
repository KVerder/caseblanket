/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from './evaluate';
import { meshShell, ventMask } from './shrinkwrap';

interface Req {
  id: number;
  design: Design;
  cfg: DesignConfig;
  organic: number;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, design, cfg, organic } = e.data;
  try {
    const mesh = meshShell(design, cfg, organic);
    const vent = ventMask(design, mesh);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, mesh, vent }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, vent.buffer]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err instanceof Error ? err.message : err) });
  }
};
