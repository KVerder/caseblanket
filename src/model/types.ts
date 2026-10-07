// All lengths are millimetres, powers are watts, temperatures °C,
// airflow m³/s and pressure Pa unless a name says otherwise.

/** Where a number came from, so the UI can say how far to trust it. */
export type Provenance =
  | 'standard' // published form-factor standard
  | 'catalog' // pc-part-dataset (PCPartPicker scrape) fetched at runtime
  | 'unverified' // manufacturer figure seen via a web-search summary, not the page itself
  | 'estimate' // generic/typical value chosen by caseblanket
  | 'user'; // typed in by the user

export interface SourceInfo {
  provenance: Provenance;
  url?: string;
  note?: string;
  /** Fields the source did not provide (kept from the previous part); flagged in the UI until edited. */
  missing?: string[];
}

export interface FanSpec {
  /** Frame size, e.g. 120 for a 120 mm fan. */
  size: number;
  thickness: number;
  /** Free-air airflow in m³/h (manufacturer convention). */
  maxAirflowM3h: number;
  /** Maximum static pressure in mm H₂O (manufacturer convention). */
  maxPressureMmH2O: number;
  /** Speed range, noise rating (dB(A) at 1 m, max speed) and blade count; typical values by size when absent. */
  acoustics?: { rpmMax: number; rpmMin: number; dbaMax: number; blades: number };
}

export interface RadiatorSpec {
  /** Overall length incl. end tanks (along the fan row). */
  length: number;
  width: number;
  /** Core (fin stack + tubes) thickness, fans excluded. */
  coreThickness: number;
  fanCount: number;
  fan: FanSpec;
  /** Space needed past the port/tank end for fittings and the tube bend. */
  portClearance: number;
}

export type BoardFormFactor = 'mini-itx' | 'thin-mini-itx' | 'mini-dtx' | 'micro-atx' | 'atx' | 'custom';

export interface MotherboardSpec {
  name: string;
  formFactor: BoardFormFactor;
  /** Length of the rear-I/O edge. */
  edge: number;
  /** Size perpendicular to the rear-I/O edge. */
  depth: number;
  /** Tallest board-mounted part other than the CPU cooler (RAM, I/O stack, VRM sinks), above the PCB. */
  componentHeight: number;
  /** Standoff + solder + backplate space under the PCB. */
  underside: number;
  pcbThickness: number;
  /** Height the socket + CPU add above the PCB before the cooler starts. */
  socketStack: number;
  /** CPU socket centre, measured from the rear edge (u) and from the slot/bottom edge (v). */
  socketU: number;
  socketV: number;
  /** Primary PCIe x16 slot centre-line, measured from the bottom edge. */
  slotV: number;
  /** Heat from VRM, chipset, RAM and SSDs. */
  heatW: number;
  /** Mounting holes (u from the rear-I/O edge, v from the bottom/slot edge), mm; standard positions when absent. */
  mountHoles?: [number, number][];
  source: SourceInfo;
}

export type CoolerKind = 'air-downdraft' | 'air-tower' | 'aio';

export interface CpuCoolerSpec {
  name: string;
  kind: CoolerKind;
  /** Air: total height incl. fan above the CPU. AIO: pump-block height above the CPU. */
  height: number;
  /** Air cooler footprint (heatsink incl. fan overhang). */
  width: number;
  depth: number;
  fan: FanSpec;
  radiator?: RadiatorSpec;
  tubeLength?: number;
  /** CPU package power to dissipate. */
  cpuPowerW: number;
  source: SourceInfo;
}

export type GpuCooling = 'aio' | 'air';
export type TubeExit = 'end' | 'top';

export interface GpuSpec {
  name: string;
  cooling: GpuCooling;
  /** Bracket to far end. */
  length: number;
  /** PCIe fingers edge to top edge (incl. shroud). */
  height: number;
  /** Backplate to front of cooler/pump (slot thickness). */
  thickness: number;
  boardPowerW: number;
  /** AIO cards: share of board power that goes into the radiator; the rest is dumped by the card. */
  radiatorHeatShare: number;
  /** A fan on the card itself (VRM/VRAM on hybrids, the main cooler on air cards). */
  cardFan: boolean;
  cardFanSpec: FanSpec;
  /** Power connector on the top edge needs straight cable run before any bend. */
  connectorClearance: number;
  /** Connector position along the card from the bracket, as a share of its length (estimate when absent: 0.7). */
  connectorPos?: number;
  radiator?: RadiatorSpec;
  tubeLength?: number;
  tubeExit: TubeExit;
  tubeClearance: number;
  source: SourceInfo;
}

export type PsuFormFactor = 'sfx' | 'sfx-l' | 'flex-atx' | 'tfx' | 'atx' | 'custom';

export interface PsuSpec {
  name: string;
  formFactor: PsuFormFactor;
  /** AC inlet face to cable face. */
  length: number;
  width: number;
  height: number;
  /** 'face': fan on the large face (SFX, SFX-L, ATX). 'end': fan on the cable end, drawing case air (Flex ATX, TFX). */
  fanOn: 'face' | 'end';
  fan: FanSpec;
  ratedW: number;
  efficiency: number;
  /** Straight space needed in front of the modular/cable face. */
  cableClearance: number;
  source: SourceInfo;
}

export interface ExtraItem {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  heatW: number;
}

/** Case fans on a panel of their own (not on a radiator or cooler). */
export interface CaseFansConfig {
  /** 0, 1 or 2. */
  count: number;
  fan: FanSpec;
  /** Let the solver pick intake or exhaust for each fan, or fix them all. */
  direction: 'auto' | 'intake' | 'exhaust';
}

export interface PartsConfig {
  board: MotherboardSpec;
  cooler: CpuCoolerSpec;
  gpu: GpuSpec;
  psu: PsuSpec;
  extras: ExtraItem[];
  caseFans: CaseFansConfig;
}

export type GpuMount = 'any' | 'riser' | 'slot';
export type TopologyId = 'flat' | 'sandwich' | 'direct' | 'direct-stack';
export type Orientation = 'tower' | 'console';
export type EdgeStyle = 'round' | 'chamfer';
export type RadDirection = 'auto' | 'intake' | 'exhaust';
export type PanelName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface VentStyle {
  id: string;
  label: string;
  /** Open (free) area ratio of the perforation. */
  openRatio: number;
}

/** Straight box, shrinkwrap, flat panels at angles (facet), or curved panels (pebble). */
export type ShellKind = 'box' | 'wrap' | 'facet' | 'pebble';

export type LoadProfileId = 'gaming' | 'full';

export interface ComponentLimits {
  cpu: number;
  gpuCore: number;
  /** GPU memory and VRM on the card (AIO cards' own fan, air cards' cooler). */
  gpuMem: number;
  /** Air entering the PSU. */
  psuInlet: number;
  /** Case air around the board VRM, chipset and SSD. */
  caseAir: number;
}

export interface ComponentResistances {
  /** CPU die to AIO coolant. */
  cpuToCoolant: number;
  /** GPU die to AIO coolant. */
  gpuToCoolant: number;
  /** CPU die to the air through an air cooler. */
  cpuToAir: number;
  /** GPU die to the air through an air-cooled card's heatsink. */
  gpuToAir: number;
  /** GPU memory/VRM to the air the card's fan moves, per watt the card dumps. */
  gpuMemToAir: number;
}

export interface Preferences {
  /** 0 = compactness only, 1 = airflow only. */
  airflowPriority: number;
  /** 0 = minimise total volume, 1 = minimise thickness. */
  thinnessPriority: number;
  /** Designs whose worst heat path gets less than this share of the airflow it needs are ranked last. */
  minAirflowAdequacy: number;
  /** Straight box, or a shell shrinkwrapped around the parts, hoses and clearances. */
  shell: ShellKind;
  /** Facet and pebble shells: bevel depth, front lean (degrees) and roundness. */
  sculpt: { cut: number; slope: number; round: number };
  /**
   * Shrinkwrap mode: the shell is moulded along every part, its air gaps, hoses and cables, with no
   * dead space (overrides `shell`, `organic` and `sculpt`). Layouts are ranked on the moulded size.
   */
  mold?: boolean;
  /** Shrinkwrap smoothness: 0 = tight with straight faces, 1 = smooth, bridging gaps up to ~180 mm. */
  organic: number;
  edgeStyle: EdgeStyle;
  edgeRadius: number;
  wallThickness: number;
  materialId: string;
  ventStyleId: string;
  dustFilters: boolean;
  /** Share of free panel area (on vent-allowed panels) that gets passive perforation. */
  passiveVentCoverage: number;
  ventPanels: Record<PanelName, boolean>;
  radDirection: RadDirection;
  allowSlimFans: boolean;
  /** Flow structures switched on in the Flow tab (see solver/flow.ts). */
  flow: { ducts: boolean; bellMouths: boolean; diffusers: boolean; roundedHoles: boolean; radiusedTurns: boolean; deepPlenums: boolean; deflectors: boolean };
  /** Let radiators and case fans tilt against their panel (15, 30, 45°) on a printed wedge frame. */
  allowTilt: boolean;
  orientation: Orientation;
  topologies: Record<TopologyId, boolean>;
  riserLength: number;
  /** How the graphics card connects: on a riser cable, straight in the board's slot, or let the solver try both. */
  gpuMount: GpuMount;
  /** Keep the PSU's AC inlet on the back panel instead of using an internal extension cable. */
  psuInletAtBack: boolean;
  /** Extra space kept around every part. */
  tolerance: number;
  /** 0 disables a limit. External dimensions in world terms. */
  maxWidth: number;
  maxHeight: number;
  maxDepth: number;
  ambientC: number;
  /** Let the solver add internal partitions (air chambers) when they help, or keep one chamber. */
  chambers: 'auto' | 'single';
  /** Fan speeds: as cool as possible within the noise budget, or as quiet as possible with every part under its limit. */
  noiseMode: 'budget' | 'quiet';
  /** Noise budget, dB(A) at 1 m (free-field estimate). */
  noiseBudgetDb: number;
  /** Printer build volume, mm (printed shells are cut into pieces that fit it). */
  buildVolume: [number, number, number];
  /** Effective leak gap along a glued joint between printed pieces, mm (estimate). */
  jointGapMm: number;
  /** Load the design is rated at: typical gaming or sustained full load. */
  loadProfile: LoadProfileId;
  /** Allowed air temperature rise leaving any heat exchanger. */
  targetRiseC: number;
  feetHeight: number;
  spineThickness: number;
  finish: string;
}

export interface AdvancedModel {
  /** Minimum gap between a cooler/card fan and its vented panel. */
  coolerFanGap: number;
  cardFanGap: number;
  psuFanGap: number;
  /** Radiator fans to vented panel (0 = screwed to the panel). */
  radWallGap: number;
  /** Space behind a radiator that blows into / pulls from the case. */
  radPlenumGap: number;
  /** Pressure-loss coefficient of a radiator core at 27 mm, per velocity head. Scales with thickness. */
  radLossK: number;
  /** Loss coefficient of an air-cooler fin stack. */
  finStackLossK: number;
  psuLossK: number;
  dustFilterLossK: number;
  /** Radiator effectiveness used for the coolant estimate. */
  radEffectiveness: number;
  /** Share of an internal fan's intake that is its own exhaust (e.g. a tower cooler in the case air). */
  internalRecirculation: number;
  /** Share of rated CPU / GPU power drawn at each load profile. */
  loads: Record<LoadProfileId, { cpu: number; gpu: number }>;
  /** Temperature limits per component, °C. */
  limits: ComponentLimits;
  /** Thermal resistances from a component to its air or coolant, K/W. */
  rth: ComponentResistances;
  /** AIO pump noise, dB(A) at 1 m, each (estimate). */
  pumpDb: number;
  /** PSU fan stays off below this share of the PSU's rating (semi-passive; estimate). */
  psuFanlessShare: number;
}

export interface DesignConfig {
  parts: PartsConfig;
  prefs: Preferences;
  advanced: AdvancedModel;
}
