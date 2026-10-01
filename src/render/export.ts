import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DesignConfig } from '../model/types';
import type { Design } from '../solver/evaluate';
import { isWrap, meshShell, type ShellMesh } from '../solver/shrinkwrap';
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
  if (isWrap(cfg)) return organicSTL(design, cfg);
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

function meshToGeometry(m: ShellMesh, map: WorldMap, flip: boolean): THREE.BufferGeometry {
  const pos = new Float32Array(m.positions.length);
  for (let i = 0; i < pos.length; i += 3) {
    const p = map.point([m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    pos.set([p.x, p.y, p.z], i);
  }
  const idx = Uint32Array.from(m.indices);
  if (flip) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g.toNonIndexed();
}

/** Shrinkwrapped shell: outer surface plus the inward-facing surface one wall in. */
function organicSTL(design: Design, cfg: DesignConfig): Blob {
  const map = new WorldMap(cfg.prefs.orientation, design.interior);
  const outer = meshShell(design, cfg, cfg.prefs.organic, 0);
  const inner = meshShell(design, cfg, cfg.prefs.organic, -design.wall);
  const merged = mergeGeometries([meshToGeometry(outer, map, false), meshToGeometry(inner, map, true)]);
  const data = new STLExporter().parse(new THREE.Mesh(merged), { binary: true }) as DataView;
  return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
}
