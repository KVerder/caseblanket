import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { DesignConfig } from '../model/types';
import type { Design, PlacedPart } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Vec3 } from '../solver/geometry';
import { routedPaths } from '../solver/hoses';
import { PARTITION_THICKNESS } from '../solver/chambers';
import type { ShellMesh } from '../solver/shrinkwrap';
import type { SimFrame } from '../cfd/run';
import type { Shaping } from '../cfd/scene';
import { FlowLayer } from './flowLayer';
import { WorldMap } from './mapping';
import {
  buildBoard,
  buildExtra,
  buildGpu,
  buildPsu,
  buildRadiator,
  buildRouted,
  clearanceGhost,
  PART_COLORS,
  PartBuilder,
  partCenter,
} from './parts';
import { shadowTexture, VENT_TILE_MM, ventTexture } from './textures';

export interface ViewOptions {
  shellOpacity: number;
  showAirflow: boolean;
  showDims: boolean;
  showClearances: boolean;
  showLabels: boolean;
  explode: number;
  /** Simulated airflow particles (once a simulation has run). */
  showFlow: boolean;
  slice: boolean;
  sliceAt: number;
}

export type ViewPreset = 'iso' | 'front' | 'top' | 'side' | 'back';

export const DEFAULT_VIEW: ViewOptions = {
  shellOpacity: 0.22,
  showAirflow: true,
  showDims: true,
  showClearances: false,
  showLabels: false,
  explode: 0,
  showFlow: true,
  slice: false,
  sliceAt: 0.5,
};

const VIEW_DIRS: Record<ViewPreset, THREE.Vector3> = {
  iso: new THREE.Vector3(1.1, 0.75, 1.5),
  front: new THREE.Vector3(0, 0.08, 1),
  back: new THREE.Vector3(0, 0.12, -1),
  side: new THREE.Vector3(1, 0.1, 0.02),
  top: new THREE.Vector3(0.001, 1, 0.02),
};

function makeLabel(text: string, cls: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

/** Chamfered box: convex hull of the 24 points you get by cutting every edge at 45°. */
function chamferedBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const a = w / 2;
  const b = h / 2;
  const e = d / 2;
  const k = Math.min(c, a, b, e) * 0.999;
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * a, sy * (b - k), sz * (e - k)));
        pts.push(new THREE.Vector3(sx * (a - k), sy * b, sz * (e - k)));
        pts.push(new THREE.Vector3(sx * (a - k), sy * (b - k), sz * e));
      }
  return new ConvexGeometry(pts);
}

export function shellGeometry(w: number, h: number, d: number, radius: number, chamfer: boolean): THREE.BufferGeometry {
  if (radius <= 0.05) return new THREE.BoxGeometry(w, h, d);
  return chamfer ? chamferedBox(w, h, d, radius) : new RoundedBoxGeometry(w, h, d, 6, radius);
}

export class CaseViewer {
  readonly renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private shell = new THREE.Group();
  private partsGroup = new THREE.Group();
  private airGroup = new THREE.Group();
  private dimGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  private ground: THREE.Mesh;
  private partHomes: { obj: THREE.Object3D; home: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  private shellMaterial: THREE.MeshPhysicalMaterial;
  private opts: ViewOptions = { ...DEFAULT_VIEW };
  private radius = 400;
  private needsRender = true;
  private raf = 0;
  private resizeObs: ResizeObserver;
  private lastTap = { t: 0, x: 0, y: 0 };
  /** Max ms between the two taps of a double-tap. */
  doubleTapWindow = 350;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t0: number } | null = null;
  private design: Design | null = null;
  readonly flow = new FlowLayer();
  private lastFrameTime = 0;
  private map: WorldMap | null = null;
  private cfg: DesignConfig | null = null;
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.DirectionalLight;
  private edgeMat = new THREE.LineBasicMaterial({ color: '#8b93a1', transparent: true, opacity: 0.5 });

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.className = 'viewer-canvas';
    this.renderer.domElement.setAttribute('aria-label', '3D preview of the case. Drag to rotate, pinch or scroll to zoom, two fingers or right-drag to pan, double-tap to reset.');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'viewer-labels';
    container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.1;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.controls.addEventListener('start', () => (this.anim = null));

    const hemi = (this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a3f47, 1.6));
    const key = (this.key = new THREE.DirectionalLight(0xffffff, 2.2));
    key.position.set(600, 900, 700);
    const rim = new THREE.DirectionalLight(0xcfe3ff, 0.9);
    rim.position.set(-700, 300, -600);
    this.scene.add(hemi, key, rim);

    this.shellMaterial = new THREE.MeshPhysicalMaterial({
      color: '#2b2d31',
      metalness: 0.55,
      roughness: 0.42,
      clearcoat: 0.3,
      transparent: true,
      opacity: this.opts.shellOpacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Perforations for shrinkwrapped shells: a per-vertex vent mask (1 = mesh, 2 = solid cut-out)
    // drawn as a triplanar hole pattern in world millimetres.
    this.shellMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float vent;\nvarying float vVent;\nvarying vec3 vWP;\nvarying vec3 vWN;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvVent = vent;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * normal);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vVent;\nvarying vec3 vWP;\nvarying vec3 vWN;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if (vVent > 0.5) {
            vec3 an = abs(vWN);
            vec2 uv = (an.x > an.y && an.x > an.z) ? vWP.yz : ((an.y > an.z) ? vWP.xz : vWP.xy);
            float hole = 1.0;
            if (vVent < 1.5) {
              vec2 q = uv / 6.0;
              q.x += mod(floor(q.y), 2.0) * 0.5;
              vec2 f = fract(q) - 0.5;
              hole = 1.0 - smoothstep(0.34, 0.42, length(f));
            }
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), hole * 0.93);
            diffuseColor.a = mix(diffuseColor.a, 1.0, hole * 0.6);
          }`,
        );
    };
    this.shellMaterial.customProgramCacheKey = () => 'caseblanket-shell-v1';

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.root.add(this.partsGroup, this.ghostGroup, this.shell, this.airGroup, this.dimGroup, this.labelGroup, this.flow.group, this.flow.shapingGroup);
    this.scene.add(this.root);

    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('dblclick', this.onDblClick);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
  }

  private onDblClick = () => this.setView('iso');

  /** Double-tap to reset on touch screens (dblclick is unreliable on touch). */
  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    const near = Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30;
    if (now - this.lastTap.t < this.doubleTapWindow && near) {
      this.setView('iso');
      this.lastTap.t = 0;
    } else {
      this.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  };

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, e);
      this.controls.target.lerpVectors(this.anim.fromT, this.anim.toT, e);
      if (k >= 1) this.anim = null;
      this.needsRender = true;
    }
    this.controls.update();
    const now = performance.now();
    const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = now;
    if (this.flow.active) {
      this.flow.update(dt);
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  setTheme(dark: boolean) {
    this.scene.background = null;
    (this.ground.material as THREE.MeshBasicMaterial).opacity = dark ? 0.9 : 0.55;
    // Dark stage: more fill light and brighter edges so a graphite shell still reads.
    this.hemi.intensity = dark ? 2.6 : 1.6;
    this.key.intensity = dark ? 2.8 : 2.2;
    this.renderer.toneMappingExposure = dark ? 1.25 : 1.05;
    this.edgeMat.color.set(dark ? '#aeb6c2' : '#7d8593');
    this.dimGroup.traverse((o) => {
      if (o instanceof THREE.Line) (o.material as THREE.LineBasicMaterial).color.set(dark ? '#9aa3b2' : '#5b6472');
    });
    this.needsRender = true;
  }

  setView(preset: ViewPreset, animate = true) {
    const dir = VIEW_DIRS[preset].clone().normalize();
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspectFit = Math.min(1, this.camera.aspect);
    // Small stages lose room to the toolbars, so stand further back there.
    const margin = this.container.clientHeight < 520 ? 1.4 : 1.15;
    const dist = (this.radius / Math.sin(fov / 2)) * (margin / Math.max(0.55, aspectFit));
    const to = dir.multiplyScalar(dist);
    const toT = new THREE.Vector3(0, 0, 0);
    this.flushDamping();
    if (animate) {
      this.anim = { from: this.camera.position.clone(), to, fromT: this.controls.target.clone(), toT, t0: performance.now() };
    } else {
      this.camera.position.copy(to);
      this.controls.target.copy(toT);
    }
    this.needsRender = true;
  }

  /** Drop any inertia left from the last gesture so it cannot drift an animated view change. */
  private flushDamping() {
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  zoom(factor: number) {
    this.flushDamping();
    const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    this.anim = {
      from: this.camera.position.clone(),
      to: this.controls.target.clone().add(offset),
      fromT: this.controls.target.clone(),
      toT: this.controls.target.clone(),
      t0: performance.now(),
    };
  }

  setOptions(o: Partial<ViewOptions>) {
    this.opts = { ...this.opts, ...o };
    this.shellMaterial.opacity = this.opts.shellOpacity;
    this.shellMaterial.visible = this.opts.shellOpacity > 0.01;
    this.shellMaterial.depthWrite = this.opts.shellOpacity > 0.95;
    this.shell.children.forEach((c) => {
      if (c.userData.vent) c.visible = this.opts.shellOpacity > 0.01 && !this.shell.children.some((x) => x.userData.organic);
      if (c.userData.edges) ((c as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = 0.25 + 0.5 * (1 - this.opts.shellOpacity);
    });
    this.airGroup.visible = this.opts.showAirflow;
    this.dimGroup.visible = this.opts.showDims;
    this.ghostGroup.visible = this.opts.showClearances;
    this.labelGroup.visible = this.opts.showLabels;
    this.flow.setVisible(this.opts.showFlow);
    this.flow.setSlice(this.opts.slice, this.opts.sliceAt);
    this.applyExplode();
    this.needsRender = true;
  }

  private applyExplode() {
    const k = this.opts.explode;
    for (const p of this.partHomes) p.obj.position.copy(p.home).addScaledVector(p.dir, k);
    this.labelGroup.children.forEach((l) => {
      const ref = l.userData.follow as THREE.Object3D | undefined;
      if (ref) l.position.copy(l.userData.base).add(ref.position);
    });
  }

  /** Remove children and free their GPU resources (shared geometries/materials are kept). */
  private clear(group: THREE.Group) {
    for (const c of [...group.children]) {
      group.remove(c);
      c.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        const mesh = o as THREE.Mesh;
        // ArrowHelper shares its geometries between instances, so leave those alone.
        if (mesh.geometry && !mesh.geometry.userData.shared && !(o.parent instanceof THREE.ArrowHelper)) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const m of mats) {
          if (m.userData.shared || m === this.shellMaterial || m === this.edgeMat) continue;
          (m as THREE.MeshBasicMaterial).alphaMap?.dispose();
          m.dispose();
        }
      });
    }
  }

  setDesign(design: Design, cfg: DesignConfig, fit: boolean, organicPending = false) {
    this.design = design;
    this.cfg = cfg;
    this.flow.clear();
    for (const g of [this.shell, this.partsGroup, this.airGroup, this.dimGroup, this.ghostGroup, this.labelGroup]) this.clear(g);
    this.partHomes = [];
    const map = new WorldMap(cfg.prefs.orientation, design.interior);
    const ext = map.size(design.exterior);
    const wall = design.wall;

    // ---- shell
    this.shellMaterial.color.set(cfg.prefs.finish);
    const geo = shellGeometry(ext.x, ext.y, ext.z, cfg.prefs.edgeRadius, cfg.prefs.edgeStyle === 'chamfer');
    const shellMesh = new THREE.Mesh(geo, this.shellMaterial);
    shellMesh.renderOrder = 2;
    shellMesh.userData.boxShell = true;
    this.shell.add(shellMesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), this.edgeMat);
    edges.userData.edges = true;
    edges.userData.boxShell = true;
    this.shell.add(edges);

    // ---- vents
    const ventStyle = cfg.prefs.ventStyleId;
    const tex = ventTexture(ventStyle);
    for (const v of design.vents) {
      const a = axisOf(v.wall);
      const [xa, ya] = wallAxes(a);
      const pos = signOf(v.wall) > 0 ? design.interior[a] + wall + 0.35 : -wall - 0.35;
      const c: Vec3 = [0, 0, 0];
      c[a] = pos;
      c[xa] = (v.rect.x0 + v.rect.x1) / 2;
      c[ya] = (v.rect.y0 + v.rect.y1) / 2;
      const center = map.point(c);
      const ux = map.dir((xa * 2) as 0 | 2 | 4);
      const uy = map.dir((ya * 2) as 0 | 2 | 4);
      const n = map.dir(v.wall);
      let w = v.rect.x1 - v.rect.x0;
      let h = v.rect.y1 - v.rect.y0;
      let bx = ux;
      let by = uy;
      if (new THREE.Vector3().crossVectors(ux, uy).dot(n) < 0) {
        bx = uy;
        by = ux;
        [w, h] = [h, w];
      }
      const plane = new THREE.PlaneGeometry(w, h);
      let material: THREE.Material;
      if (v.kind === 'io' || v.kind === 'bracket') {
        material = new THREE.MeshBasicMaterial({ color: '#0c0d10', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
      } else {
        const t = tex.clone();
        t.needsUpdate = true;
        t.repeat.set(w / VENT_TILE_MM, h / VENT_TILE_MM);
        material = new THREE.MeshBasicMaterial({
          color: v.kind === 'passive' ? '#15171b' : '#07080a',
          alphaMap: t,
          transparent: true,
          opacity: v.kind === 'passive' ? 0.75 : 0.95,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
      }
      const mesh = new THREE.Mesh(plane, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(bx, by, new THREE.Vector3().crossVectors(bx, by));
      mesh.matrix.setPosition(center);
      mesh.userData.vent = true;
      mesh.userData.boxShell = true;
      mesh.renderOrder = 3;
      this.shell.add(mesh);

      // Airflow arrows on fan-driven vents.
      if (v.flow && v.kind !== 'passive') {
        const group = design.flow.groups.find((g) => g.id === v.groupId || (v.groupId === 'gpu' && g.id === 'gpu-card') || (v.groupId === 'cpu' && g.id === 'cpu'));
        const cfm = group?.cfm ?? 20;
        const len = 28 + Math.min(90, cfm * 1.1);
        const warm = v.flow === 'out' ? Math.min(1, (group?.exitRiseC ?? 5) / Math.max(1, cfg.prefs.targetRiseC)) : 0;
        const color = v.flow === 'in' ? new THREE.Color('#3b82f6') : new THREE.Color('#f59e0b').lerp(new THREE.Color('#ef4444'), warm);
        const dir = v.flow === 'in' ? n.clone().negate() : n.clone();
        const origin = v.flow === 'in' ? center.clone().addScaledVector(n, len + 6) : center.clone().addScaledVector(n, 6);
        const arrow = new THREE.ArrowHelper(dir, origin, len, color, Math.min(22, len * 0.35), Math.min(14, len * 0.22));
        (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
        this.airGroup.add(arrow);
      }
    }

    // ---- parts
    const extraGap = design.profile.extraGap;
    const centerOfCase = new THREE.Vector3();
    for (const part of design.parts) {
      const g = new THREE.Group();
      const b = new PartBuilder(map, g);
      if (part.kind === 'board') buildBoard(b, part, cfg, extraGap);
      else if (part.kind === 'gpu') buildGpu(b, part, cfg);
      else if (part.kind === 'psu') buildPsu(b, part, cfg);
      else if (part.kind === 'rad-cpu' || part.kind === 'rad-gpu') buildRadiator(b, part);
      else buildExtra(b, part);
      g.userData.partId = part.id;
      this.partsGroup.add(g);
      const pc = partCenter(map, part);
      const dir = pc.clone().sub(centerOfCase);
      // Explode mostly along the thickness axis, a little in-plane.
      const tAxis = map.axis(2).index;
      const d2 = new THREE.Vector3(dir.x * 0.35, dir.y * 0.35, dir.z * 0.35);
      d2.setComponent(tAxis, dir.getComponent(tAxis) * 1.6 + Math.sign(dir.getComponent(tAxis) || 1) * 40);
      this.partHomes.push({ obj: g, home: new THREE.Vector3(), dir: d2 });
      this.ghostGroup.add(clearanceGhost(map, part, PART_COLORS[part.kind] ?? '#999'));
      const label = makeLabel(part.label, 'part-label');
      label.position.copy(pc);
      label.userData.base = pc.clone();
      label.userData.follow = g;
      this.labelGroup.add(label);
    }

    // ---- AIO hoses and the GPU power cable
    const tubes = new THREE.Group();
    buildRouted(tubes, map, routedPaths(design, cfg));
    this.partsGroup.add(tubes);

    // ---- internal partitions (air chambers): full plates for the box; setShell trims them to a wrap.
    this.plates = null;
    if (design.chamber) {
      const plates = new THREE.Group();
      const plateMat = this.plateMaterial;
      for (const cut of design.chamber.cuts) {
        const min = [...cut.region.min] as Vec3;
        const max = [...cut.region.max] as Vec3;
        min[cut.axis] = cut.at - PARTITION_THICKNESS / 2;
        max[cut.axis] = cut.at + PARTITION_THICKNESS / 2;
        const b = map.box({ min, max });
        const size = b.getSize(new THREE.Vector3());
        const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), plateMat);
        b.getCenter(m.position);
        m.renderOrder = 1;
        plates.add(m);
      }
      this.partsGroup.add(plates);
      this.partHomes.push({ obj: plates, home: new THREE.Vector3(), dir: new THREE.Vector3() });
      this.plates = plates;
    }
    this.partHomes.push({ obj: tubes, home: new THREE.Vector3(), dir: new THREE.Vector3() });

    // Spine / mid-plate for two-layer designs
    if (design.spine) {
      const [s0, s1] = design.spine;
      const box = map.box({ min: [0, 0, s0], max: [design.interior[0], design.interior[1], s1] });
      const size = box.getSize(new THREE.Vector3());
      const spine = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), this.shellMaterial);
      box.getCenter(spine.position);
      this.shell.add(spine);
    }

    // ---- dimensions and ground
    this.map = map;
    this.layoutAround(new THREE.Box3(ext.clone().multiplyScalar(-0.5), ext.clone().multiplyScalar(0.5)), design.feet);

    this.radius = Math.max(ext.x, ext.y, ext.z) * 0.62 + 40;
    this.controls.minDistance = this.radius * 0.35;
    this.controls.maxDistance = this.radius * 12;
    this.setOptions({});
    // An organic shell is on its way: don't flash the straight box meanwhile.
    if (organicPending) for (const c of this.shell.children) if (c.userData.boxShell) c.visible = false;
    if (fit) this.setView('iso', false);
    this.needsRender = true;
  }

  /** Dimension lines, ground and feet around an outer bounding box (world space). */
  private layoutAround(b: THREE.Box3, feet: number, positions?: Float32Array) {
    this.clear(this.dimGroup);
    for (const c of [...this.shell.children]) if (c.userData.foot) this.shell.remove(c);
    const ext = b.getSize(new THREE.Vector3());
    const ctr = b.getCenter(new THREE.Vector3());
    this.dimGroup.position.copy(ctr);
    this.buildDims(ext, feet);
    if (feet > 0) {
      const footMat = new THREE.MeshStandardMaterial({ color: '#1b1c1f', roughness: 0.9 });
      for (const [x, z] of this.footSpots(b, ctr, ext, positions)) {
        const f = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, feet, 20), footMat);
        f.position.set(x, b.min.y - feet / 2, z);
        f.userData.foot = true;
        this.shell.add(f);
      }
    }
    const r = Math.hypot(ext.x, ext.z) * 0.85;
    this.ground.scale.set(r * 1.6, r * 1.6, 1);
    this.ground.position.set(ctr.x, b.min.y - feet - 0.5, ctr.z);
  }

  /**
   * Foot positions: inset corners of the box, or for a wrapped shell the extreme corners of the
   * flat patch it actually stands on (vertices within 1.5 mm of its lowest point), pulled inward.
   */
  private footSpots(b: THREE.Box3, ctr: THREE.Vector3, ext: THREE.Vector3, positions?: Float32Array): [number, number][] {
    const corners: [number, number][] = [];
    if (!positions) {
      const fx = Math.max(0, ext.x / 2 - 25);
      const fz = Math.max(0, ext.z / 2 - 25);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push([ctr.x + sx * fx, ctr.z + sz * fz]);
      return corners;
    }
    const pts: [number, number][] = [];
    for (let i = 0; i < positions.length; i += 3) if (positions[i + 1] < b.min.y + 1.5) pts.push([positions[i], positions[i + 2]]);
    if (pts.length < 3) return this.footSpots(b, ctr, ext);
    const cx = pts.reduce((s2, p) => s2 + p[0], 0) / pts.length;
    const cz = pts.reduce((s2, p) => s2 + p[1], 0) / pts.length;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        let best = pts[0];
        for (const p of pts) if (sx * p[0] + sz * p[1] > sx * best[0] + sz * best[1]) best = p;
        const dx = cx - best[0];
        const dz = cz - best[1];
        const l = Math.hypot(dx, dz) || 1;
        const k = Math.min(18, l);
        corners.push([best[0] + (dx / l) * k, best[1] + (dz / l) * k]);
      }
    return corners;
  }

  /**
   * Replace the straight box with a shrinkwrapped shell (or go back to the box with null).
   * Vents become a per-vertex mask that the shell shader perforates.
   */
  private plates: THREE.Group | null = null;
  private plateMaterial = new THREE.MeshStandardMaterial({ color: '#b87333', roughness: 0.55, metalness: 0.2, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });

  /** Solver-space mesh → world-space geometry (positions and normals). */
  private worldGeometry(mesh: ShellMesh): THREE.BufferGeometry {
    const map = this.map!;
    const pos = new Float32Array(mesh.positions.length);
    const nrm = new Float32Array(mesh.normals.length);
    const p = new THREE.Vector3();
    const o = map.point([0, 0, 0]);
    for (let i = 0; i < pos.length; i += 3) {
      p.copy(map.point([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]));
      pos.set([p.x, p.y, p.z], i);
      p.copy(map.point([mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]])).sub(o);
      nrm.set([p.x, p.y, p.z], i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    return geo;
  }

  setShell(result: { mesh: ShellMesh; vent: Float32Array; plates?: ShellMesh[] } | null) {
    const design = this.design;
    const map = this.map;
    if (!design || !map) return;
    for (const c of [...this.shell.children]) {
      if (c.userData.organic) {
        this.shell.remove(c);
        (c as THREE.Mesh).geometry.dispose();
      }
    }
    const boxed = !result;
    for (const c of this.shell.children) if (c.userData.boxShell) c.visible = boxed && (!c.userData.vent || this.opts.shellOpacity > 0.01);
    if (!result) {
      const ext = map.size(design.exterior);
      this.layoutAround(new THREE.Box3(ext.clone().multiplyScalar(-0.5), ext.clone().multiplyScalar(0.5)), design.feet);
      this.needsRender = true;
      return;
    }
    const { mesh, vent } = result;
    if (this.plates && result.plates?.length) {
      for (const c of [...this.plates.children]) {
        this.plates.remove(c);
        (c as THREE.Mesh).geometry.dispose();
      }
      for (const pm of result.plates) {
        const m = new THREE.Mesh(this.worldGeometry(pm), this.plateMaterial);
        m.renderOrder = 1;
        this.plates.add(m);
      }
    }
    const pos = new Float32Array(mesh.positions.length);
    const nrm = new Float32Array(mesh.normals.length);
    const p = new THREE.Vector3();
    const o = map.point([0, 0, 0]);
    for (let i = 0; i < pos.length; i += 3) {
      p.copy(map.point([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]));
      pos.set([p.x, p.y, p.z], i);
      p.copy(map.point([mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]])).sub(o);
      nrm.set([p.x, p.y, p.z], i);
    }
    // Both world mappings are proper rotations, so triangle winding carries over unchanged.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('vent', new THREE.BufferAttribute(vent, 1));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const shell = new THREE.Mesh(geo, this.shellMaterial);
    shell.renderOrder = 2;
    shell.userData.organic = true;
    this.shell.add(shell);
    this.layoutAround(map.box(mesh.bbox), design.feet, pos);
    this.needsRender = true;
  }

  private buildDims(ext: THREE.Vector3, feetH: number) {
    const hx = ext.x / 2;
    const hy = ext.y / 2;
    const hz = ext.z / 2;
    const off = 22;
    const lineMat = new THREE.LineBasicMaterial({ color: '#8b93a1' });
    const seg = (a: THREE.Vector3, b: THREE.Vector3, tick: THREE.Vector3, text: string, cls: string) => {
      const pts = [a, b, a.clone().add(tick), a.clone().sub(tick), b.clone().add(tick), b.clone().sub(tick)];
      const geo = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]]);
      geo.setIndex([0, 1, 2, 3, 4, 5]);
      this.dimGroup.add(new THREE.LineSegments(geo, lineMat));
      const label = makeLabel(text, `dim-label ${cls}`);
      label.position.copy(a.clone().add(b).multiplyScalar(0.5));
      this.dimGroup.add(label);
    };
    const fmt = (v: number) => `${Math.round(v)} mm`;
    const y0 = -hy - feetH - off;
    seg(new THREE.Vector3(-hx, y0, hz + off), new THREE.Vector3(hx, y0, hz + off), new THREE.Vector3(0, 6, 0), fmt(ext.x), 'dim-w');
    seg(new THREE.Vector3(hx + off, -hy - feetH, hz + off), new THREE.Vector3(hx + off, hy, hz + off), new THREE.Vector3(6, 0, 0), fmt(ext.y + feetH), 'dim-h');
    seg(new THREE.Vector3(hx + off, y0, -hz), new THREE.Vector3(hx + off, y0, hz), new THREE.Vector3(0, 6, 0), fmt(ext.z), 'dim-d');
  }

  /** Airflow simulation: show a new frame of the flow field. */
  setFlowFrame(f: SimFrame) {
    if (!this.map) return;
    this.flow.setFrame(f, this.map);
    this.needsRender = true;
  }

  setFlowVisible(v: boolean) {
    this.flow.setVisible(v);
    this.needsRender = true;
  }

  setSlice(on: boolean, frac?: number) {
    this.flow.setSlice(on, frac);
    this.needsRender = true;
  }

  /** Draw (or remove) louvres and ducts chosen by the airflow optimiser. */
  setShaping(shaping: Shaping | null) {
    if (!this.design || !this.map || !this.cfg) return;
    this.flow.setShaping(this.design, this.cfg, shaping, this.map);
    this.needsRender = true;
  }

  /** PNG snapshot of the current view. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Camera state, used by the end-to-end gesture tests. */
  cameraState() {
    return { distance: this.camera.position.distanceTo(this.controls.target), position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  get currentDesign() {
    return this.design;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('dblclick', this.onDblClick);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

export type { PlacedPart };
