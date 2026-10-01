import type {
  AdvancedModel,
  BoardFormFactor,
  CpuCoolerSpec,
  DesignConfig,
  FanSpec,
  GpuSpec,
  MotherboardSpec,
  Preferences,
  PsuFormFactor,
  PsuSpec,
  RadiatorSpec,
  SourceInfo,
  VentStyle,
} from './types';

const STANDARD: SourceInfo = { provenance: 'standard' };
const ESTIMATE: SourceInfo = { provenance: 'estimate' };
const unverified = (url: string, note?: string): SourceInfo => ({ provenance: 'unverified', url, note });

// ---------------------------------------------------------------- fans

export const FANS = {
  a12x25: {
    size: 120,
    thickness: 25,
    maxAirflowM3h: 102.1,
    maxPressureMmH2O: 2.34,
  },
  a12x15: {
    size: 120,
    thickness: 15,
    maxAirflowM3h: 94.2,
    maxPressureMmH2O: 1.53,
  },
  a9x14: { size: 92, thickness: 14, maxAirflowM3h: 50.5, maxPressureMmH2O: 2.0 },
  generic120: { size: 120, thickness: 25, maxAirflowM3h: 100, maxPressureMmH2O: 2.5 },
  generic140: { size: 140, thickness: 25, maxAirflowM3h: 140, maxPressureMmH2O: 1.8 },
  psu92: { size: 92, thickness: 25, maxAirflowM3h: 60, maxPressureMmH2O: 2.5 },
  psu120: { size: 120, thickness: 25, maxAirflowM3h: 95, maxPressureMmH2O: 2.0 },
  psu40: { size: 40, thickness: 20, maxAirflowM3h: 15, maxPressureMmH2O: 6 },
  gpuVrm: { size: 90, thickness: 15, maxAirflowM3h: 45, maxPressureMmH2O: 2.0 },
  gpuAir: { size: 100, thickness: 20, maxAirflowM3h: 200, maxPressureMmH2O: 3.0 },
} satisfies Record<string, FanSpec>;

export const FAN_NOTES: Record<string, string> = {
  a12x25: 'Noctua NF-A12x25 PWM rating (from a search summary of noctua.at, not verified on the page)',
  a12x15: 'Noctua NF-A12x15 PWM rating (from a search summary, not verified)',
  a9x14: 'Airflow per Noctua NH-L9a-AM5 search summary; pressure is an estimate',
};

export const SLIM_RAD_FAN: FanSpec = FANS.a12x15;

// ---------------------------------------------------------------- radiators

export function genericRadiator(sizeMm: number, coreThickness = 27, fan: FanSpec = FANS.generic120): RadiatorSpec {
  const fanSize = sizeMm % 140 === 0 ? 140 : 120;
  const fanCount = Math.max(1, Math.round(sizeMm / fanSize));
  const f = fanSize === 140 ? { ...FANS.generic140, thickness: fan.thickness } : fan;
  return {
    length: fanCount * fanSize + 35,
    width: fanSize,
    coreThickness,
    fanCount,
    fan: f,
    portClearance: 25,
  };
}

// ---------------------------------------------------------------- motherboards

interface BoardFF {
  label: string;
  edge: number;
  depth: number;
  componentHeight: number;
}

export const BOARD_FORM_FACTORS: Record<Exclude<BoardFormFactor, 'custom'>, BoardFF> = {
  'mini-itx': { label: 'Mini-ITX', edge: 170, depth: 170, componentHeight: 40 },
  'thin-mini-itx': { label: 'Thin Mini-ITX', edge: 170, depth: 170, componentHeight: 22 },
  'mini-dtx': { label: 'Mini-DTX', edge: 203, depth: 170, componentHeight: 40 },
  'micro-atx': { label: 'Micro-ATX', edge: 244, depth: 244, componentHeight: 40 },
  atx: { label: 'ATX', edge: 305, depth: 244, componentHeight: 40 },
};

export function boardFromFormFactor(ff: Exclude<BoardFormFactor, 'custom'>, name?: string): MotherboardSpec {
  const f = BOARD_FORM_FACTORS[ff];
  return {
    name: name ?? `${f.label} board`,
    formFactor: ff,
    edge: f.edge,
    depth: f.depth,
    componentHeight: f.componentHeight,
    underside: 7,
    pcbThickness: 1.6,
    socketStack: 7,
    // Socket and slot positions are typical, not from a spec: the top x16 slot sits ~156 mm
    // below the I/O-end edge on ITX/mATX/ATX alike, the socket sits in the upper half.
    socketU: Math.round(f.depth * 0.55),
    socketV: Math.round(f.edge - 75),
    slotV: Math.max(12, f.edge - 156),
    heatW: ff === 'atx' ? 35 : ff === 'micro-atx' ? 30 : 25,
    source: { provenance: 'standard', note: 'Board outline is the form-factor standard; heights, socket and slot positions are typical values.' },
  };
}

// ---------------------------------------------------------------- CPU coolers

export const COOLERS: CpuCoolerSpec[] = [
  {
    name: 'Thermalright AXP120-X67',
    kind: 'air-downdraft',
    height: 67,
    width: 120,
    depth: 123.5,
    fan: FANS.a12x15,
    cpuPowerW: 105,
    source: unverified('https://www.tomshardware.com/reviews/thermalright-axp120-x67', '67 mm height, 123.5×120 mm footprint, 120×15 mm fan'),
  },
  {
    name: 'Noctua NH-L12S',
    kind: 'air-downdraft',
    height: 70,
    width: 128,
    depth: 146,
    fan: FANS.a12x15,
    cpuPowerW: 95,
    source: unverified('https://www.noctua.at/en/products/nh-l12s/specifications', '70 mm with the fan under the fins (default); 128×146 mm'),
  },
  {
    name: 'Noctua NH-L9a-AM5',
    kind: 'air-downdraft',
    height: 37,
    width: 114,
    depth: 92,
    fan: FANS.a9x14,
    cpuPowerW: 65,
    source: unverified('https://www.noctua.at/en/products/nh-l9a-am5/specifications', '37 mm with fan, 114×92 mm'),
  },
  {
    name: 'Generic tower cooler (155 mm)',
    kind: 'air-tower',
    height: 155,
    width: 125,
    depth: 110,
    fan: FANS.generic120,
    cpuPowerW: 150,
    source: ESTIMATE,
  },
  {
    name: 'ARCTIC Liquid Freezer III Pro 240',
    kind: 'aio',
    height: 55,
    width: 80,
    depth: 80,
    fan: FANS.generic120,
    radiator: { length: 277, width: 120, coreThickness: 38, fanCount: 2, fan: FANS.generic120, portClearance: 25 },
    tubeLength: 450,
    cpuPowerW: 150,
    source: unverified(
      'https://www.arctic.de/media/3f/c1/fb/1744190700/Spec_Sheet_Liquid_Freezer_III_Pro_240_EN.pdf',
      'Radiator 277×120×38 mm, tubes 450 mm (search summary). Pump height is an estimate.',
    ),
  },
  {
    name: 'Generic 240 AIO (27 mm rad)',
    kind: 'aio',
    height: 50,
    width: 75,
    depth: 75,
    fan: FANS.generic120,
    radiator: genericRadiator(240),
    tubeLength: 400,
    cpuPowerW: 150,
    source: ESTIMATE,
  },
  {
    name: 'Generic 120 AIO (27 mm rad)',
    kind: 'aio',
    height: 50,
    width: 75,
    depth: 75,
    fan: FANS.generic120,
    radiator: genericRadiator(120),
    tubeLength: 350,
    cpuPowerW: 105,
    source: ESTIMATE,
  },
];

// ---------------------------------------------------------------- GPUs

const MSI_4090_LX = 'https://www.msi.com/Graphics-Card/GeForce-RTX-4090-SUPRIM-LIQUID-X-24G/Specification';

export const GPUS: GpuSpec[] = [
  {
    name: 'MSI RTX 5080 SUPRIM LIQUID SOC',
    cooling: 'aio',
    length: 280,
    height: 148,
    thickness: 51,
    boardPowerW: 360,
    radiatorHeatShare: 0.85,
    cardFan: true,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: { length: 394, width: 121, coreThickness: 30, fanCount: 3, fan: FANS.generic120, portClearance: 25 },
    tubeLength: 450,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(
      'https://us.msi.com/Graphics-Card/GeForce-RTX-5080-16G-SUPRIM-LIQUID-SOC/Specification',
      'Card 280×148×51 mm, radiator 394×121×55 mm incl. fans, tubes 450 mm (search summary).',
    ),
  },
  {
    name: 'MSI RTX 5090 SUPRIM LIQUID SOC',
    cooling: 'aio',
    length: 280,
    height: 148,
    thickness: 51,
    boardPowerW: 575,
    radiatorHeatShare: 0.85,
    cardFan: true,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: { length: 394, width: 121, coreThickness: 30, fanCount: 3, fan: FANS.generic120, portClearance: 25 },
    tubeLength: 450,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(
      'https://www.msi.com/Graphics-Card/GeForce-RTX-5090-32G-SUPRIM-LIQUID-SOC/Specification',
      'Card 280×148×51 mm, radiator 394×121×55 mm incl. fans, tubes 450 mm (search summary).',
    ),
  },
  {
    name: 'GIGABYTE AORUS RTX 5090 XTREME WATERFORCE',
    cooling: 'aio',
    length: 246,
    height: 146,
    thickness: 36,
    boardPowerW: 575,
    radiatorHeatShare: 0.95,
    cardFan: false,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: genericRadiator(360),
    tubeLength: 460,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(
      'https://www.gigabyte.com/Graphics-Card/GV-N5090AORUSX-W-32GD/sp',
      'Card 245×146×36 mm, 460 mm tubes (search summary). Radiator dimensions are a generic 360 estimate; no card fan assumed.',
    ),
  },
  {
    name: 'GIGABYTE AORUS RTX 5080 XTREME WATERFORCE',
    cooling: 'aio',
    length: 220,
    height: 130,
    thickness: 40,
    boardPowerW: 360,
    radiatorHeatShare: 0.95,
    cardFan: false,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: genericRadiator(360),
    tubeLength: 460,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(
      'https://www.gigabyte.com/Graphics-Card/GV-N5080AORUSX-W-16GD',
      'Card 220×130×40 mm (search summary). Radiator and tube values are generic estimates.',
    ),
  },
  {
    name: 'ASUS ROG Astral LC RTX 5090',
    cooling: 'aio',
    length: 288.5,
    height: 153.7,
    thickness: 48,
    boardPowerW: 575,
    radiatorHeatShare: 0.85,
    cardFan: true,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: { length: 400, width: 120, coreThickness: 38, fanCount: 3, fan: FANS.generic120, portClearance: 25 },
    tubeLength: 500,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(
      'https://rog.asus.com/graphics-cards/graphics-cards/rog-astral/rog-astral-lc-rtx5090-o32g-gaming/spec/',
      'Card 288.46×153.7×48 mm, radiator 400×120×65 mm incl. fans (search summary). Tube length and card fan are estimates.',
    ),
  },
  {
    name: 'MSI RTX 4090 SUPRIM LIQUID X',
    cooling: 'aio',
    length: 280,
    height: 140,
    thickness: 43,
    boardPowerW: 450,
    radiatorHeatShare: 0.85,
    cardFan: true,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: { length: 274, width: 121, coreThickness: 30, fanCount: 2, fan: FANS.generic120, portClearance: 25 },
    tubeLength: 470,
    tubeExit: 'end',
    tubeClearance: 35,
    source: unverified(MSI_4090_LX, 'Card 280×140×43 mm, radiator + fan 274×121×55 mm, tubes 470 mm (search summary).'),
  },
  {
    name: 'Generic AIO GPU, 240 radiator',
    cooling: 'aio',
    length: 260,
    height: 130,
    thickness: 40,
    boardPowerW: 320,
    radiatorHeatShare: 0.85,
    cardFan: true,
    cardFanSpec: FANS.gpuVrm,
    connectorClearance: 35,
    radiator: genericRadiator(240),
    tubeLength: 450,
    tubeExit: 'end',
    tubeClearance: 35,
    source: ESTIMATE,
  },
  {
    name: 'Generic air-cooled GPU, 2.5 slot',
    cooling: 'air',
    length: 300,
    height: 125,
    thickness: 52,
    boardPowerW: 300,
    radiatorHeatShare: 0,
    cardFan: true,
    cardFanSpec: FANS.gpuAir,
    connectorClearance: 35,
    tubeExit: 'end',
    tubeClearance: 0,
    source: ESTIMATE,
  },
];

// ---------------------------------------------------------------- PSUs

interface PsuFF {
  label: string;
  length: number;
  width: number;
  height: number;
  fanOn: 'face' | 'end';
  fan: FanSpec;
}

export const PSU_FORM_FACTORS: Record<Exclude<PsuFormFactor, 'custom'>, PsuFF> = {
  sfx: { label: 'SFX', length: 100, width: 125, height: 63.5, fanOn: 'face', fan: FANS.psu92 },
  'sfx-l': { label: 'SFX-L', length: 130, width: 125, height: 63.5, fanOn: 'face', fan: FANS.psu120 },
  'flex-atx': { label: 'Flex ATX', length: 150, width: 81.5, height: 40.5, fanOn: 'end', fan: FANS.psu40 },
  tfx: { label: 'TFX', length: 175, width: 85, height: 65, fanOn: 'face', fan: FANS.psu92 },
  atx: { label: 'ATX', length: 140, width: 150, height: 86, fanOn: 'face', fan: FANS.psu120 },
};

export function psuFromFormFactor(ff: Exclude<PsuFormFactor, 'custom'>, ratedW = 850, name?: string): PsuSpec {
  const f = PSU_FORM_FACTORS[ff];
  return {
    name: name ?? `${f.label} ${ratedW} W`,
    formFactor: ff,
    length: f.length,
    width: f.width,
    height: f.height,
    fanOn: f.fanOn,
    fan: f.fan,
    ratedW,
    efficiency: 0.9,
    cableClearance: 30,
    source: { ...STANDARD, note: 'Outline from the form-factor standard; ATX length varies by model (140–200 mm).' },
  };
}

// ---------------------------------------------------------------- materials & vents

export interface Material {
  id: string;
  label: string;
  densityGcm3: number;
  defaultWall: number;
}

export const MATERIALS: Material[] = [
  { id: 'al5052', label: 'Aluminium 5052', densityGcm3: 2.68, defaultWall: 1.5 },
  { id: 'steel', label: 'Steel (SPCC)', densityGcm3: 7.85, defaultWall: 1.0 },
  { id: 'petg', label: '3D print — PETG', densityGcm3: 1.27, defaultWall: 2.4 },
  { id: 'acrylic', label: 'Acrylic', densityGcm3: 1.19, defaultWall: 3.0 },
  { id: 'plywood', label: 'Birch plywood', densityGcm3: 0.68, defaultWall: 4.0 },
];

export const VENT_STYLES: VentStyle[] = [
  { id: 'hex', label: 'Hex mesh (~70% open)', openRatio: 0.7 },
  { id: 'fine', label: 'Fine mesh (~60% open)', openRatio: 0.6 },
  { id: 'round', label: 'Round perforation (~50% open)', openRatio: 0.5 },
  { id: 'slots', label: 'Slots (~40% open)', openRatio: 0.4 },
];

export const FINISHES = [
  { id: '#2b2d31', label: 'Graphite' },
  { id: '#c9ccd1', label: 'Silver' },
  { id: '#e9e6df', label: 'Chalk' },
  { id: '#3b4a3f', label: 'Moss' },
  { id: '#5b2f2f', label: 'Oxblood' },
  { id: '#23395b', label: 'Navy' },
];

// ---------------------------------------------------------------- defaults

export const DEFAULT_PREFS: Preferences = {
  airflowPriority: 0.35,
  thinnessPriority: 0.6,
  minAirflowAdequacy: 0.8,
  edgeStyle: 'round',
  edgeRadius: 6,
  wallThickness: 1.5,
  materialId: 'al5052',
  ventStyleId: 'hex',
  dustFilters: false,
  passiveVentCoverage: 0.3,
  ventPanels: { front: true, back: true, left: true, right: true, top: true, bottom: true },
  radDirection: 'auto',
  allowSlimFans: true,
  orientation: 'tower',
  topologies: { flat: true, sandwich: true, direct: true, 'direct-stack': true },
  riserLength: 200,
  gpuMount: 'any',
  psuInletAtBack: false,
  tolerance: 2,
  maxWidth: 0,
  maxHeight: 0,
  maxDepth: 0,
  ambientC: 25,
  targetRiseC: 12,
  feetHeight: 8,
  spineThickness: 2,
  finish: '#2b2d31',
};

export const DEFAULT_ADVANCED: AdvancedModel = {
  coolerFanGap: 5,
  cardFanGap: 5,
  psuFanGap: 3,
  radWallGap: 0,
  radPlenumGap: 10,
  radLossK: 13,
  finStackLossK: 10,
  psuLossK: 4,
  dustFilterLossK: 2,
  radEffectiveness: 0.7,
};

export function defaultConfig(): DesignConfig {
  return structuredClone({
    parts: {
      board: boardFromFormFactor('mini-itx'),
      cooler: COOLERS[0],
      gpu: GPUS[0],
      psu: psuFromFormFactor('sfx', 850),
      extras: [],
    },
    prefs: DEFAULT_PREFS,
    advanced: DEFAULT_ADVANCED,
  });
}
