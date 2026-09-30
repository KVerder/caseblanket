import * as THREE from 'three';

/** Tile size in mm that one texture repeat covers. */
export const VENT_TILE_MM = 12;

const cache = new Map<string, THREE.CanvasTexture>();

/** A tileable perforation pattern: dark holes on a transparent sheet. */
export function ventTexture(style: string): THREE.CanvasTexture {
  const hit = cache.get(style);
  if (hit) return hit;
  const px = 128;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, px, px);
  g.fillStyle = '#ffffff';
  const s = px / VENT_TILE_MM; // px per mm
  if (style === 'hex') {
    // Hexagonal holes on a 6 mm pitch, rows offset by half a pitch.
    const pitch = 6 * s;
    const r = 2.6 * s;
    for (let row = -1; row < 3; row++) {
      for (let col = -1; col < 3; col++) {
        const cx = col * pitch + (row % 2 ? pitch / 2 : 0);
        const cy = row * pitch;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          const x = cx + r * Math.cos(a);
          const y = cy + r * Math.sin(a);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.closePath();
        g.fill();
      }
    }
  } else if (style === 'slots') {
    const pitch = 4 * s;
    for (let row = 0; row < 3; row++) {
      const y = row * pitch + pitch / 2;
      g.beginPath();
      g.roundRect(1 * s, y - 0.9 * s, 10 * s, 1.8 * s, 0.9 * s);
      g.fill();
    }
  } else {
    const fine = style === 'fine';
    const pitch = (fine ? 3 : 6) * s;
    const r = (fine ? 1.1 : 2.4) * s;
    for (let row = -1; row < 6; row++) {
      for (let col = -1; col < 6; col++) {
        const cx = col * pitch + (row % 2 ? pitch / 2 : 0);
        const cy = row * pitch * 0.866;
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  cache.set(style, tex);
  return tex;
}

let groundTex: THREE.CanvasTexture | null = null;

/** Soft radial falloff used as a contact shadow under the case. */
export function shadowTexture(): THREE.CanvasTexture {
  if (groundTex) return groundTex;
  const px = 256;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  groundTex = new THREE.CanvasTexture(c);
  return groundTex;
}
