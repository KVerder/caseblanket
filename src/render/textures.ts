import * as THREE from 'three';

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
