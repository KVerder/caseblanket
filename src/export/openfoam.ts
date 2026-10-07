import { VENT_STYLES } from '../model/presets';
import type { DesignConfig } from '../model/types';
import { ventZeta as panelZeta } from '../solver/flow';
import { perforation } from '../model/perforation';
import { buildScene, type SceneGeometry } from '../cfd/scene';
import { floorGapZeta, MMH2O_TO_PA } from '../solver/airflow';
import type { Design } from '../solver/evaluate';
import { axisOf, signOf, wallAxes, type Box, type Vec3 } from '../solver/geometry';
import { meshShell, shellField, ventMask, type ShellMesh } from '../solver/shrinkwrap';

/**
 * OpenFOAM case export (openfoam.com v2312 dictionaries, buoyantSimpleFoam, k-omega SST,
 * Boussinesq air). Geometry is in metres, world axes (y up).
 *
 *   domain          the air inside the case: the shell's inner surface is the boundary, a wall
 *                   where the panel is solid and open to still room air where it is vented
 *   vents           a porous layer just inside each vent (Idelchik's perforated-plate ζ, plus
 *                   the floor-gap loss for vents in the bottom panel: the desk is not meshed)
 *   parts           solid obstacles (boards, card body, end tanks) cut out of the mesh
 *   radiators, fins, PSU   porous cellZones (Darcy-Forchheimer, ζ/L along the flow axis, blocked across)
 *   fans            cyclic baffles with a fan pressure jump from the fan curve (Pmax at 0, 0 at free-air speed)
 *   heat            volumetric enthalpy sources in each heat source's cellZone
 *   partitions      wall baffles
 *   tilted parts    radiators and case fans tilted on a wedge frame are exported along their panel's
 *                   normal (an approximation; the app's own 3D simulation tilts them)
 *
 * Function objects write what the app compares against: volume flow through each fan, the
 * flow-weighted temperature entering it, the mean temperature in each heat source, and a passive
 * tracer released in the heat sources (recirculation: its concentration at each intake).
 *
 * Not run in the browser: run Allrun with OpenFOAM installed (or the CI job), then import the
 * postProcessing folder.
 */

export interface CaseFile {
  path: string;
  data: string;
}

const M = 0.001;
const fmt = (x: number) => (Math.abs(x) < 1e-12 ? '0' : Number(x.toPrecision(7)).toString());
const vec = (v: Vec3) => `(${v.map(fmt).join(' ')})`;

/** Solver (u, v, t) mm → world metres, y up (same mapping as the 3D view, uncentred). */
function worldOf(cfg: DesignConfig) {
  const tower = cfg.prefs.orientation === 'tower';
  return (p: Vec3): Vec3 => (tower ? [-p[2] * M, p[1] * M, p[0] * M] : [p[1] * M, p[2] * M, p[0] * M]);
}

/** Solver axis → world axis index. */
function worldAxis(cfg: DesignConfig, a: number): number {
  const tower = cfg.prefs.orientation === 'tower';
  return tower ? [2, 1, 0][a] : [2, 0, 1][a];
}

function worldBox(cfg: DesignConfig, b: Box): Box {
  const w = worldOf(cfg);
  const p = w(b.min);
  const q = w(b.max);
  return { min: [0, 1, 2].map((a) => Math.min(p[a], q[a])) as Vec3, max: [0, 1, 2].map((a) => Math.max(p[a], q[a])) as Vec3 };
}

const header = (cls: string, object: string, location?: string) =>
  `/*--------------------------------*- C++ -*----------------------------------*\\
  caseblanket export
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};${location ? `\n    location    "${location}";` : ''}
    object      ${object};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

`;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** ASCII STL of triangles (world metres), one named solid. */
function stl(name: string, tris: Vec3[][]): string {
  const out = [`solid ${name}`];
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    out.push(`  facet normal ${n.map((x) => fmt(x / l)).join(' ')}`, '    outer loop');
    for (const p of [a, b, c]) out.push(`      vertex ${p.map(fmt).join(' ')}`);
    out.push('    endloop', '  endfacet');
  }
  out.push(`endsolid ${name}`);
  return out.join('\n') + '\n';
}

function boxTris(b: Box): Vec3[][] {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const v: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const q = (a: number, b2: number, c: number, d: number): Vec3[][] => [
    [v[a], v[b2], v[c]],
    [v[a], v[c], v[d]],
  ];
  return [...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(0, 4, 7, 3)];
}

function discTris(centre: Vec3, axis: number, r: number, seg = 24): Vec3[][] {
  const [ia, ib] = [0, 1, 2].filter((a) => a !== axis);
  const out: Vec3[][] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (2 * Math.PI * i) / seg;
    const a1 = (2 * Math.PI * (i + 1)) / seg;
    const p = (ang: number): Vec3 => {
      const q = [...centre] as Vec3;
      q[ia] += r * Math.cos(ang);
      q[ib] += r * Math.sin(ang);
      return q;
    };
    out.push([centre, p(a0), p(a1)]);
  }
  return out;
}

/** Depth of the porous layer that stands in for a vent's perforation, mm. */
const VENT_LAYER = 6;

/**
 * A point in the case's open air (for snappyHexMesh's locationInMesh): the interior grid point
 * farthest from every part, porous block and heat source, at least a wall inside the shell.
 */
function airPoint(design: Design, cfg: DesignConfig, g: SceneGeometry): Vec3 {
  // Inside the shrinkwrap too: the interior box includes hollows the wrap cuts away.
  const F = shellField(design, cfg, cfg.prefs.organic ?? 0);
  const boxes = [...g.solids, ...g.porous.map((p) => p.box), ...g.heat.map((h) => h.box), ...g.fans.map((f) => f.slab), ...design.parts.map((p) => p.clearance)];
  const dist = (p: Vec3, b: Box) => {
    let o = 0;
    let inside = true;
    for (let a = 0; a < 3; a++) {
      const d = Math.max(b.min[a] - p[a], 0, p[a] - b.max[a]);
      if (d > 0) inside = false;
      o += d * d;
    }
    return inside ? -1 : Math.sqrt(o);
  };
  let best: Vec3 = [design.interior[0] / 2, design.interior[1] / 2, design.interior[2] / 2];
  let bestD = -Infinity;
  const step = 6;
  for (let u = 4; u < design.interior[0] - 4; u += step)
    for (let v = 4; v < design.interior[1] - 4; v += step)
      for (let t = 4; t < design.interior[2] - 4; t += step) {
        const p: Vec3 = [u, v, t];
        let d = Math.min(u, v, t, design.interior[0] - u, design.interior[1] - v, design.interior[2] - t, -F(p) - design.wall);
        if (d <= 2) continue;
        for (const b of boxes) d = Math.min(d, dist(p, b));
        if (d > bestD) {
          bestD = d;
          best = p;
        }
      }
  return best;
}

export interface OpenFoamOptions {
  /** Base cell size, mm. */
  cellMm?: number;
  /** Solver iterations. */
  iterations?: number;
  /**
   * Snap the mesh to the shell surface. Off by default: snapping left collapsed sliver cells where
   * the shell wall meets a vent, and buoyantSimpleFoam diverged within three iterations even with
   * no fans, heat or gravity; the stair-stepped (castellated) mesh runs stably.
   */
  snap?: boolean;
}

/** Everything needed to run the design in OpenFOAM. */
export function openfoamCase(design: Design, cfg: DesignConfig, shell?: ShellMesh, opts: OpenFoamOptions = {}): CaseFile[] {
  const files: CaseFile[] = [];
  const add = (path: string, data: string) => files.push({ path, data });
  const w = worldOf(cfg);
  // A fine grid: the scene widens thin features (fan slabs) to at least one cell.
  const scene = buildScene(design, cfg, undefined, { cells: 150000 });
  const g = scene.geometry as SceneGeometry;
  const vs = VENT_STYLES.find((v) => v.id === cfg.prefs.ventStyleId) ?? VENT_STYLES[0];
  const ambientK = cfg.prefs.ambientC + 273.15;
  const cell = (opts.cellMm ?? 8) * M;
  const iterations = opts.iterations ?? 2000;

  // ---------------------------------------------------------------- geometry
  // The air inside the case: the shell's inner surface (one wall in from the outside).
  void shell;
  const mesh = meshShell(design, cfg, cfg.prefs.organic ?? 0, -design.wall);
  const vent = ventMask(design, mesh);
  const wallTris: Vec3[][] = [];
  const ventTris: Vec3[][] = [];
  const P = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    const tri = ids.map((i) => w([P[3 * i], P[3 * i + 1], P[3 * i + 2]])) as Vec3[];
    (ids.every((i) => vent[i] === 1) ? ventTris : wallTris).push(tri);
  }
  add('constant/triSurface/shellWall.stl', stl('shellWall', wallTris));
  add('constant/triSurface/shellVents.stl', stl('shellVents', ventTris.length ? ventTris : []));
  add('constant/triSurface/obstacles.stl', stl('obstacles', g.solids.flatMap((b) => boxTris(worldBox(cfg, b)))));
  const plates = (g.partitions ?? []).map((cut) => {
    const min = [...cut.region.min] as Vec3;
    const max = [...cut.region.max] as Vec3;
    min[cut.axis] = max[cut.axis] = cut.at;
    const b = worldBox(cfg, { min, max });
    const a = worldAxis(cfg, cut.axis);
    const [ia, ib] = [0, 1, 2].filter((x) => x !== a);
    const c = (x: number, y: number): Vec3 => {
      const p = [...b.min] as Vec3;
      p[ia] = x;
      p[ib] = y;
      return p;
    };
    return [
      [c(b.min[ia], b.min[ib]), c(b.max[ia], b.min[ib]), c(b.max[ia], b.max[ib])],
      [c(b.min[ia], b.min[ib]), c(b.max[ia], b.max[ib]), c(b.min[ia], b.max[ib])],
    ] as Vec3[][];
  });
  if (plates.length) add('constant/triSurface/partitions.stl', stl('partitions', plates.flat()));
  const fans = g.fans.map((f, i) => {
    const name = `fan${i}_${safe(f.group)}`;
    const centre = w(f.center);
    const a = worldAxis(cfg, f.axis);
    add(`constant/triSurface/${name}.stl`, stl(name, discTris(centre, a, f.radius * M)));
    // World sign of the blow direction.
    const unit: Vec3 = [0, 0, 0];
    unit[f.axis] = f.sign;
    const wd = w(unit);
    const blow = Math.sign(wd[a]) || 1;
    const areaM2 = Math.PI * (f.radius * M) ** 2;
    // Each disk is one fan: its own rated free-air flow over its own area.
    const umax = f.spec.maxAirflowM3h / 3600 / areaM2;
    const pmax = f.spec.maxPressureMmH2O * MMH2O_TO_PA;
    const speed = design.flow.groups.find((x) => x.id === f.group)?.speed ?? 1;
    return { name, group: f.group, axis: a, blow, umax: umax * speed, pmax: pmax * speed * speed, centre };
  });

  // Background block: the case's bounds plus a margin; snappyHexMesh keeps the inside.
  const allPts: Vec3[] = [];
  for (let i = 0; i < P.length; i += 3) allPts.push(w([P[i], P[i + 1], P[i + 2]]));
  const lo = [0, 1, 2].map((a) => Math.min(...allPts.map((p) => p[a])) - 0.012) as Vec3;
  const hi = [0, 1, 2].map((a) => Math.max(...allPts.map((p) => p[a])) + 0.012) as Vec3;
  const n = [0, 1, 2].map((a) => Math.max(4, Math.ceil((hi[a] - lo[a]) / cell)));
  const inRoom = w(airPoint(design, cfg, g));

  // Vent layers: each vent's perforation as a porous slab just inside it.
  const ventZones = design.vents
    .filter((v) => v.kind !== 'io' && v.kind !== 'bracket')
    .map((v, i) => {
      const a = axisOf(v.wall);
      const [xa, ya] = wallAxes(a);
      const at = signOf(v.wall) > 0 ? design.interior[a] : 0;
      const b: Box = { min: [0, 0, 0], max: [0, 0, 0] };
      b.min[a] = signOf(v.wall) > 0 ? at - VENT_LAYER : at - design.wall;
      b.max[a] = signOf(v.wall) > 0 ? at + design.wall : at + VENT_LAYER;
      b.min[xa] = v.rect.x0;
      b.max[xa] = v.rect.x1;
      b.min[ya] = v.rect.y0;
      b.max[ya] = v.rect.y1;
      // The domain stops at the shell, so the desk under bottom vents is the floor-gap loss in the layer.
      const w = v.rect.x1 - v.rect.x0;
      const l = v.rect.y1 - v.rect.y0;
      const floor = v.wall === design.bottomWall ? floorGapZeta(w * l, 2 * (w + l), design.feet, 2 * (design.interior[xa] + design.interior[ya] + 4 * design.wall)) : 0;
      return { name: `vent${i}_${v.kind.replace(/[^a-z]/g, '')}`, wb: worldBox(cfg, b), axis: worldAxis(cfg, a), floor };
    });

  // ---------------------------------------------------------------- system
  add(
    'system/blockMeshDict',
    header('dictionary', 'blockMeshDict', 'system') +
      `scale 1;

vertices
(
    ${vec([lo[0], lo[1], lo[2]])}
    ${vec([hi[0], lo[1], lo[2]])}
    ${vec([hi[0], hi[1], lo[2]])}
    ${vec([lo[0], hi[1], lo[2]])}
    ${vec([lo[0], lo[1], hi[2]])}
    ${vec([hi[0], lo[1], hi[2]])}
    ${vec([hi[0], hi[1], hi[2]])}
    ${vec([lo[0], hi[1], hi[2]])}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${n.join(' ')}) simpleGrading (1 1 1)
);

boundary
(
    outside
    {
        type patch;
        faces
        (
            (0 3 2 1)
            (4 5 6 7)
            (0 1 5 4)
            (2 3 7 6)
            (1 2 6 5)
            (0 4 7 3)
        );
    }
);
`,
  );

  const surfNames = ['shellWall', 'shellVents', 'obstacles', ...(plates.length ? ['partitions'] : []), ...fans.map((f) => f.name)];
  add(
    'system/surfaceFeatureExtractDict',
    header('dictionary', 'surfaceFeatureExtractDict', 'system') +
      surfNames
        .filter((s) => !s.startsWith('fan'))
        .map(
          (s) => `${s}.stl
{
    extractionMethod    extractFromSurface;
    includedAngle       150;
    writeObj            no;
}
`,
        )
        .join('\n'),
  );

  const bafflesSurf = (name: string, level: number) => `        ${name}
        {
            level (${level} ${level});
            faceZone ${name}Zone;
            faceType internal;
        }`;
  add(
    'system/snappyHexMeshDict',
    header('dictionary', 'snappyHexMeshDict', 'system') +
      `castellatedMesh true;
snap            ${opts.snap ? 'true' : 'false'};
addLayers       false;

geometry
{
${surfNames.map((s) => `    ${s}.stl { type triSurfaceMesh; name ${s}; }`).join('\n')}
}

castellatedMeshControls
{
    maxLocalCells       2000000;
    maxGlobalCells      8000000;
    minRefinementCells  0;
    nCellsBetweenLevels 2;
    features
    (
${surfNames
  .filter((s) => !s.startsWith('fan'))
  .map((s) => `        { file "${s}.eMesh"; level 1; }`)
  .join('\n')}
    );
    refinementSurfaces
    {
        shellWall { level (1 1); patchInfo { type wall; } }
        shellVents { level (1 1); patchInfo { type patch; } }
        obstacles { level (1 1); patchInfo { type wall; } }
${plates.length ? bafflesSurf('partitions', 1) : ''}
${fans.map((f) => bafflesSurf(f.name, 1)).join('\n')}
    }
    resolveFeatureAngle 30;
    refinementRegions {}
    locationInMesh ${vec(inRoom)};
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch 3;
    tolerance 2.0;
    nSolveIter 30;
    nRelaxIter 5;
    nFeatureSnapIter 10;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}

addLayersControls
{
    relativeSizes true;
    layers {}
    expansionRatio 1.0;
    finalLayerThickness 0.3;
    minThickness 0.1;
    nGrow 0;
    featureAngle 60;
    nRelaxIter 3;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
}

meshQualityControls
{
    // OpenFOAM's standard meshQualityDict values, inline so the case runs on any installation.
    maxNonOrtho 65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-15;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
    relaxed { maxNonOrtho 75; }
}

mergeTolerance 1e-6;
`,
  );

  // cellZones for vents, porous blocks and heat sources. OpenFOAM keeps a cell in one cellZone
  // only, so every zone is its box minus all zones before it (vents, then porous blocks, then
  // heat). A heat source that is a porous block (fins, PSU, GPU shroud, radiator core) heats that
  // block's own zone; only the rest (the board) get zones of their own. Overlapping zones used to
  // leave a heat source with no cells (a division by zero in OpenFOAM) or silently fewer.
  const porous = g.porous.map((p, i) => ({ ...p, name: `porous${i}_${safe(p.label)}`, wb: worldBox(cfg, p.box), waxes: p.along.map((a) => worldAxis(cfg, a)) }));
  const overlap = (a: Box, b: Box) => {
    let inter = 1;
    let va = 1;
    let vb = 1;
    for (let k = 0; k < 3; k++) {
      inter *= Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
      va *= a.max[k] - a.min[k];
      vb *= b.max[k] - b.min[k];
    }
    return inter / Math.max(1e-12, Math.min(va, vb));
  };
  const heat = g.heat.map((h) => {
    const host = porous.find((p) => overlap(p.box, h.box) > 0.8);
    const name = `heat_${safe(h.id)}`;
    return { ...h, name, zone: host ? host.name : name, own: !host, wb: worldBox(cfg, h.box) };
  });
  const topo = [
    ...ventZones.map((v) => ({ name: v.name, box: v.wb })),
    ...porous.map((p) => ({ name: p.name, box: p.wb })),
    ...heat.filter((h) => h.own).map((h) => ({ name: h.name, box: h.wb })),
  ];
  add(
    'system/topoSetDict',
    header('dictionary', 'topoSetDict', 'system') +
      `actions
(
${topo
  .map(
    (t, i) => `    {
        name    ${t.name};
        type    cellSet;
        action  new;
        source  boxToCell;
        box     ${vec(t.box.min)} ${vec(t.box.max)};
    }
${topo
  .slice(0, i)
  .map(
    (e) => `    {
        name    ${t.name};
        type    cellSet;
        action  subtract;
        source  cellToCell;
        set     ${e.name};
    }`,
  )
  .join('\n')}
    {
        name    ${t.name};
        type    cellZoneSet;
        action  new;
        source  setToCellZone;
        set     ${t.name};
    }`,
  )
  .join('\n')}
);
`,
  );

  const plate = panelZeta(vs.openRatio, perforation(vs.id), cfg.prefs.wallThickness, !!cfg.prefs.flow?.roundedHoles);
  const ventZeta = plate + (cfg.prefs.dustFilters ? cfg.advanced.dustFilterLossK : 0);
  // Starting turbulence: ~1 m/s at 5 % intensity over a 10 mm length scale.
  const k0 = 3.75e-3;
  const om0 = 11;
  const wallFields = `patchFields
                {
                    U       { type noSlip; }
                    p_rgh   { type fixedFluxPressure; value uniform 1e5; }
                    p       { type calculated; value uniform 1e5; }
                    T       { type zeroGradient; }
                    s       { type zeroGradient; }
                    k       { type kqRWallFunction; value uniform ${k0}; }
                    omega   { type omegaWallFunction; value uniform ${om0}; }
                    nut     { type nutkWallFunction; value uniform 0; }
                    alphat  { type compressible::alphatWallFunction; value uniform 0; }
                }`;
  const wallPair = (name: string) => `    ${name}
    {
        type        faceZone;
        zoneName    ${name}Zone;
        patches
        {
            master
            {
                name ${name}_a;
                type wall;
                ${wallFields}
            }
            slave
            {
                name ${name}_b;
                type wall;
                ${wallFields}
            }
        }
    }`;
  add(
    'system/createBafflesDict',
    header('dictionary', 'createBafflesDict', 'system') +
      `internalFacesOnly true;

baffles
{
${plates.length ? wallPair('partitions') : ''}
${fans
  .map(
    (f) => `    ${f.name}
    {
        // Fan curve: pressure jump ${fmt(f.pmax)} Pa at rest, 0 at ${fmt(f.umax)} m/s through the disk.
        type        faceZone;
        zoneName    ${f.name}Zone;
        patches
        {
            master
            {
                name            ${f.name}_a;
                type            cyclic;
                neighbourPatch  ${f.name}_b;
                patchFields
                {
                    p_rgh
                    {
                        type        fan;
                        patchType   cyclic;
                        jumpTable   table ((0 ${fmt(f.blow * f.pmax)}) (${fmt(Math.max(f.umax, 1e-3))} 0));
                        value       uniform 1e5;
                    }
                }
            }
            slave
            {
                name            ${f.name}_b;
                type            cyclic;
                neighbourPatch  ${f.name}_a;
                patchFields
                {
                    p_rgh
                    {
                        type        fan;
                        patchType   cyclic;
                        value       uniform 1e5;
                    }
                }
            }
        }
    }`,
  )
  .join('\n')}
}
`,
  );

  // Functions the app imports.
  const fanFns = fans
    .map(
      (f) => `    flow_${f.name}
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   50;
        log             false;
        writeFields     false;
        regionType      patch;
        name            ${f.name}_a;
        operation       sum;
        fields          (phi);
    }
    tin_${f.name}
    {
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   50;
        log             false;
        writeFields     false;
        regionType      patch;
        name            ${f.name}_a;
        operation       weightedAverage;
        weightField     phi;
        fields          (T s);
    }`,
    )
    .join('\n');
  const heatFns = heat
    .map(
      (h) => `    tzone_${h.name}
    {
        type            volFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   50;
        log             false;
        writeFields     false;
        regionType      cellZone;
        name            ${h.zone};
        operation       volAverage;
        fields          (T s);
    }`,
    )
    .join('\n');
  add(
    'system/controlDict',
    header('dictionary', 'controlDict', 'system') +
      `application     buoyantSimpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         ${iterations};
deltaT          1;
writeControl    timeStep;
writeInterval   ${Math.max(50, Math.round(iterations / 4))};
purgeWrite      2;
writeFormat     ascii;
writePrecision  7;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{
    // Recirculation tracer: released in every heat source, carried with the air (see fvOptions).
    s
    {
        type            scalarTransport;
        libs            (solverFunctionObjects);
        field           s;
        D               2e-5;
        fvOptions
        {
${heat
  .map(
    (h) => `            src_${h.name}
            {
                type            scalarSemiImplicitSource;
                volumeMode      absolute;
                selectionMode   cellZone;
                cellZone        ${h.zone};
                injectionRateSuSp
                {
                    s           (1 0);
                }
            }`,
  )
  .join('\n')}
        }
    }
${fanFns}
${heatFns}
}
`,
  );

  add(
    'system/fvSchemes',
    header('dictionary', 'fvSchemes', 'system') +
      `ddtSchemes      { default steadyState; }
gradSchemes     { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes
{
    default             none;
    div(phi,U)          bounded Gauss linearUpwind grad(U);
    div(phi,h)          bounded Gauss upwind;
    div(phi,K)          bounded Gauss upwind;
    div(phi,k)          bounded Gauss upwind;
    div(phi,omega)      bounded Gauss upwind;
    div(phi,s)          bounded Gauss upwind;
    div(((rho*nuEff)*dev2(T(grad(U)))))  Gauss linear;
}
laplacianSchemes    { default Gauss linear limited corrected 0.33; }
interpolationSchemes { default linear; }
snGradSchemes       { default limited corrected 0.33; }
wallDist            { method meshWave; }
`,
  );
  add(
    'system/fvSolution',
    header('dictionary', 'fvSolution', 'system') +
      `solvers
{
    p_rgh
    {
        solver          GAMG;
        smoother        DIC;
        tolerance       1e-7;
        relTol          0.01;
    }
    "(U|h|k|omega|s)"
    {
        solver          PBiCGStab;
        preconditioner  DILU;
        tolerance       1e-7;
        relTol          0.1;
    }
}

SIMPLE
{
    // Predictor on: from still air the momentum matrix is nearly empty, and without it the first
    // pressure correction alone sets the velocity.
    momentumPredictor   yes;
    nNonOrthogonalCorrectors 1;
    pRefCell            0;
    pRefValue           1e5;
    residualControl
    {
        p_rgh   1e-3;
        U       1e-4;
        h       1e-5;
        "(k|omega)" 1e-4;
    }
}

relaxationFactors
{
    fields      { rho 1.0; p_rgh 0.7; }
    equations   { U 0.3; h 0.3; "(k|omega)" 0.5; s 0.5; }
}
`,
  );
  add('system/decomposeParDict', header('dictionary', 'decomposeParDict', 'system') + 'numberOfSubdomains 4;\nmethod scotch;\n');

  // ---------------------------------------------------------------- constant
  add('constant/g', header('uniformDimensionedVectorField', 'g', 'constant') + 'dimensions [0 1 -2 0 0 0 0];\nvalue (0 -9.81 0);\n');
  add(
    'constant/thermophysicalProperties',
    header('dictionary', 'thermophysicalProperties', 'constant') +
      `thermoType
{
    type            heRhoThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState Boussinesq;
    specie          specie;
    energy          sensibleEnthalpy;
}

mixture
{
    specie          { molWeight 28.96; }
    equationOfState { rho0 1.2; T0 ${fmt(ambientK)}; beta ${fmt(1 / ambientK)}; }
    thermodynamics  { Cp 1005; Hf 0; }
    transport       { mu 1.8e-05; Pr 0.71; }
}
`,
  );
  add('constant/turbulenceProperties', header('dictionary', 'turbulenceProperties', 'constant') + 'simulationType RAS;\nRAS\n{\n    RASModel kOmegaSST;\n    turbulence on;\n    printCoeffs on;\n}\n');
  add(
    'constant/fvOptions',
    header('dictionary', 'fvOptions', 'constant') +
      [
        ...ventZones.map((v) => {
          // Perforated panel: Δp = ζ·½ρU² over the layer, along the vent's normal only.
          const f = [0, 1, 2].map((a) => (a === v.axis ? (ventZeta + v.floor) / (VENT_LAYER * M) : 0));
          return `${v.name}
{
    type            explicitPorositySource;
    explicitPorositySourceCoeffs
    {
        selectionMode   cellZone;
        cellZone        ${v.name};
        type            DarcyForchheimer;
        d   (0 0 0);
        f   ${vec(f as Vec3)};
        coordinateSystem
        {
            origin  (0 0 0);
            e1      (1 0 0);
            e2      (0 1 0);
        }
    }
}
`;
        }),
        ...porous.map((p) => {
          // Darcy-Forchheimer: S = −(μ d + ½ ρ |U| f) U per unit volume, so f = ζ / L along the flow
          // axis (L = block thickness, m) and a large value across it (fins and cores channel the air).
          const along = p.zeta / Math.max(1e-3, p.thickness * M);
          const f = [0, 1, 2].map((a) => (p.waxes.includes(a) ? along : 1e5));
          return `${p.name}
{
    type            explicitPorositySource;
    explicitPorositySourceCoeffs
    {
        selectionMode   cellZone;
        cellZone        ${p.name};
        type            DarcyForchheimer;
        d   (0 0 0);
        f   ${vec(f as Vec3)};
        coordinateSystem
        {
            origin  (0 0 0);
            e1      (1 0 0);
            e2      (0 1 0);
        }
    }
}
`;
        }),
        ...heat.map(
          (h) => `${h.name}_power
{
    // ${h.label}: ${fmt(h.watts)} W
    type            scalarSemiImplicitSource;
    volumeMode      absolute;
    selectionMode   cellZone;
    cellZone        ${h.zone};
    injectionRateSuSp
    {
        h           (${fmt(h.watts)} 0);
    }
}
`,
        ),
      ].join('\n'),
  );

  // ---------------------------------------------------------------- 0/
  const wallPatches = ['shellWall', '"obstacles.*"', ...(plates.length ? ['"partitions_.*"'] : [])];
  const cyc = fans.map((f) => `"${f.name}_.*"`);
  const field = (cls: string, name: string, dims: string, internal: string, room: string, wall: string, cyclic = 'type cyclic;') =>
    header(cls, name, '0') +
    `dimensions      ${dims};
internalField   ${internal};

boundaryField
{
    "(outside|shellVents)" { ${room} }
${wallPatches.map((p) => `    ${p} { ${wall} }`).join('\n')}
${cyc.map((p) => `    ${p} { ${cyclic} }`).join('\n')}
}
`;
  add('0/U', field('volVectorField', 'U', '[0 1 -1 0 0 0 0]', 'uniform (0 0 0)', 'type pressureInletOutletVelocity; value uniform (0 0 0);', 'type noSlip;'));
  add('0/p_rgh', field('volScalarField', 'p_rgh', '[1 -1 -2 0 0 0 0]', 'uniform 1e5', 'type prghTotalPressure; p0 uniform 1e5; value uniform 1e5;', 'type fixedFluxPressure; value uniform 1e5;', 'type cyclic;'));
  add('0/p', field('volScalarField', 'p', '[1 -1 -2 0 0 0 0]', 'uniform 1e5', 'type calculated; value uniform 1e5;', 'type calculated; value uniform 1e5;'));
  add('0/T', field('volScalarField', 'T', '[0 0 0 1 0 0 0]', `uniform ${fmt(ambientK)}`, `type inletOutlet; inletValue uniform ${fmt(ambientK)}; value uniform ${fmt(ambientK)};`, 'type zeroGradient;'));
  add('0/s', field('volScalarField', 's', '[0 0 0 0 0 0 0]', 'uniform 0', 'type inletOutlet; inletValue uniform 0; value uniform 0;', 'type zeroGradient;'));
  add('0/k', field('volScalarField', 'k', '[0 2 -2 0 0 0 0]', `uniform ${k0}`, `type inletOutlet; inletValue uniform ${k0}; value uniform ${k0};`, `type kqRWallFunction; value uniform ${k0};`));
  add('0/omega', field('volScalarField', 'omega', '[0 0 -1 0 0 0 0]', `uniform ${om0}`, `type inletOutlet; inletValue uniform ${om0}; value uniform ${om0};`, `type omegaWallFunction; value uniform ${om0};`));
  add('0/nut', field('volScalarField', 'nut', '[0 2 -1 0 0 0 0]', 'uniform 0', 'type calculated; value uniform 0;', 'type nutkWallFunction; value uniform 0;'));
  add('0/alphat', field('volScalarField', 'alphat', '[1 -1 -1 0 0 0 0]', 'uniform 0', 'type calculated; value uniform 0;', 'type compressible::alphatWallFunction; value uniform 0;'));

  add(
    'Allrun',
    `#!/bin/sh
# caseblanket → OpenFOAM (openfoam.com v2312 or newer). Run inside an OpenFOAM environment.
cd "\${0%/*}" || exit
. \${WM_PROJECT_DIR:?}/bin/tools/RunFunctions
runApplication blockMesh
runApplication surfaceFeatureExtract
runApplication snappyHexMesh -overwrite
runApplication topoSet
runApplication createBaffles -overwrite
runApplication checkMesh
runApplication buoyantSimpleFoam
`,
  );
  add(
    'README.txt',
    `caseblanket OpenFOAM case — ${design.id}

Run:      ./Allrun          (OpenFOAM v2312+, openfoam.com)
Import:   in caseblanket, Results → Reference results → choose this case's postProcessing folder.

What is modelled: the air inside the case, bounded by the shell's inner surface (walls, and openings
to still room air where it is vented, each with a porous layer of ζ = ${fmt(ventZeta)}), parts as
obstacles, radiators/fins/PSU as porous zones, ${fans.length}
fan disks as fan-curve pressure jumps (at the app's solved fan speeds), ${heat.length} heat sources,
buoyancy (Boussinesq), k-omega SST. Room air outside the case is not meshed, so exhaust that curls
back into an intake outside the case is not modelled here (the in-app simulation covers it).
Base cells ${fmt(cell * 1000)} mm, one refinement level at surfaces. The mesh is ${opts.snap ? 'snapped to the shell' : 'stair-stepped (castellated, not snapped: snapping left sliver cells that made the solver diverge)'}.

Outputs (postProcessing/): flow_<fan> (mass flow, kg/s), tin_<fan> (flow-weighted T and tracer s
entering each fan), tzone_<heat source> (mean T and s in each heat source).
Recirculation at an intake = s there ÷ the mean s of the heat sources.

The case was generated, not run, by caseblanket: check the mesh (checkMesh) before trusting results.
`,
  );
  return files;
}
