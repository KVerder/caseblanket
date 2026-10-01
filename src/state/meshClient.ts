import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { meshShell, ventMask, type ShellMesh } from '../solver/shrinkwrap';

export interface ShellResult {
  mesh: ShellMesh;
  vent: Float32Array;
}

/** Meshes organic shells off the main thread; a new request cancels the running one. */
export class MeshClient {
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private pending: { id: number; resolve: (r: ShellResult) => void; reject: (e: Error) => void } | null = null;

  private create(): Worker | null {
    if (this.failed) return null;
    try {
      const w = new Worker(new URL('../solver/meshWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, mesh, vent, error } = e.data as { id: number; mesh?: ShellMesh; vent?: Float32Array; error?: string };
        if (!this.pending || this.pending.id !== id) return;
        const p = this.pending;
        this.pending = null;
        if (error) p.reject(new Error(error));
        else p.resolve({ mesh: mesh!, vent: vent! });
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        this.failed = true;
        w.terminate();
        this.worker = null;
        this.pending?.reject(new Error('worker-failed'));
        this.pending = null;
      };
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  run(design: Design, cfg: DesignConfig, organic: number): Promise<ShellResult> {
    const id = ++this.seq;
    if (this.pending) {
      this.pending.reject(new Error('superseded'));
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
    }
    this.worker ??= this.create();
    if (!this.worker) {
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (id !== this.seq) return reject(new Error('superseded'));
          const mesh = meshShell(design, cfg, organic);
          resolve({ mesh, vent: ventMask(design, mesh) });
        }, 0),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        resolve,
        reject: (e) => (e.message === 'worker-failed' ? this.run(design, cfg, organic).then(resolve, reject) : reject(e)),
      };
      this.worker!.postMessage({ id, design, cfg, organic });
    });
  }

  dispose() {
    this.worker?.terminate();
  }
}
