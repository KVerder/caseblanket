/// <reference lib="webworker" />
import type { DesignConfig } from '../model/types';
import type { Design } from './evaluate';
import { plateMeshes } from './partitions';
import { defaultCell, meshGrid, sampleGrid, shellGrid, ventMask } from './shrinkwrap';

interface Req {
  id: number;
  design: Design;
  cfg: DesignConfig;
  organic: number;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, design, cfg, organic } = e.data;
  try {
    const grid = shellGrid(design, cfg, organic, defaultCell(design));
    const mesh = meshGrid(grid);
    const vent = ventMask(design, mesh);
    // Partition plates trimmed to this shell.
    const plates = plateMeshes(design, cfg, sampleGrid(grid));
    const transfer: Transferable[] = [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, vent.buffer];
    for (const p of plates) transfer.push(p.positions.buffer, p.normals.buffer, p.indices.buffer);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, mesh, vent, plates }, transfer);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err instanceof Error ? err.message : err) });
  }
};
