import * as THREE from 'three';
import type { Orientation } from '../model/types';
import { axisOf, signOf, type Axis, type Box, type Dir, type Vec3 } from '../solver/geometry';

/**
 * Solver (u, v, t) → three.js world (x, y, z), both right-handed.
 * tower:   x = −t, y = v, z = u   (thickness is the width, stands on its v− edge)
 * console: x = v,  y = t, z = u   (thickness is the height)
 * u = 0 (rear I/O wall) is at −z, so the front faces the default camera.
 */
export class WorldMap {
  readonly center: Vec3;
  constructor(
    readonly orientation: Orientation,
    readonly interior: Vec3,
  ) {
    this.center = [interior[0] / 2, interior[1] / 2, interior[2] / 2];
  }

  /** World axis index and sign for a solver axis. */
  axis(a: Axis): { index: 0 | 1 | 2; sign: 1 | -1 } {
    if (this.orientation === 'tower') {
      return a === 0 ? { index: 2, sign: 1 } : a === 1 ? { index: 1, sign: 1 } : { index: 0, sign: -1 };
    }
    return a === 0 ? { index: 2, sign: 1 } : a === 1 ? { index: 0, sign: 1 } : { index: 1, sign: 1 };
  }

  point(p: Vec3): THREE.Vector3 {
    const out = [0, 0, 0];
    for (let a = 0 as Axis; a < 3; a = (a + 1) as Axis) {
      const { index, sign } = this.axis(a);
      out[index] = sign * (p[a] - this.center[a]);
    }
    return new THREE.Vector3(out[0], out[1], out[2]);
  }

  /** World-space size (x, y, z) of a solver-space size vector. */
  size(s: Vec3): THREE.Vector3 {
    const out = [0, 0, 0];
    for (let a = 0 as Axis; a < 3; a = (a + 1) as Axis) out[this.axis(a).index] = s[a];
    return new THREE.Vector3(out[0], out[1], out[2]);
  }

  box(b: Box): THREE.Box3 {
    return new THREE.Box3().setFromPoints([this.point(b.min), this.point(b.max)]);
  }

  dir(d: Dir): THREE.Vector3 {
    const { index, sign } = this.axis(axisOf(d));
    const v = new THREE.Vector3();
    v.setComponent(index, sign * signOf(d));
    return v;
  }
}
