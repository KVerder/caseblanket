import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { WorldMap } from './mapping';
import { shellGeometry } from './Viewer';

function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g.clone();
  const pos = ng.getAttribute('position');
  for (let i = 0; i < pos.count; i += 3) {
    // swap vertices 1 and 2 of every triangle to reverse the winding
    for (let k = 0; k < 3; k++) {
      const a = pos.getComponent(i + 1, k);
      pos.setComponent(i + 1, k, pos.getComponent(i + 2, k));
      pos.setComponent(i + 2, k, a);
    }
  }
  ng.deleteAttribute('normal');
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  return ng;
}

function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(ng.attributes)) if (name !== 'position') ng.deleteAttribute(name);
  return ng;
}

/**
 * Hollow shell as a closed solid (outer surface + inward-facing inner surface), in mm.
 * Vents and openings are not cut — the SVG panel drawings carry those.
 */
export function shellSTL(design: Design, cfg: DesignConfig): Blob {
  const map = new WorldMap(cfg.prefs.orientation, design.interior);
  const ext = map.size(design.exterior);
  const inn = map.size(design.interior);
  const chamfer = cfg.prefs.edgeStyle === 'chamfer';
  const outer = strip(shellGeometry(ext.x, ext.y, ext.z, cfg.prefs.edgeRadius, chamfer));
  const inner = strip(flipped(shellGeometry(inn.x, inn.y, inn.z, Math.max(0, cfg.prefs.edgeRadius - design.wall), chamfer)));
  const merged = mergeGeometries([outer, inner]);
  const data = new STLExporter().parse(new THREE.Mesh(merged), { binary: true }) as DataView;
  return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
