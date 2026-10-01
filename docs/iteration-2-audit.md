# Iteration 2 audit

Every requirement in [iteration-2-brief.md](iteration-2-brief.md), checked against the code at the end of iteration 2. **Pass** means a test or a measurement shows it. **Partial** means part of it is done and the rest is named. **Cut** or **deferred** means it was left out on purpose, following the brief's priority list.

Tests are in `tests/` (`npm test`, 85 tests) and `e2e/run.mjs` (`npm run e2e`, 36 browser checks). CI runs both on every push. An optional `openfoam` job meshes the exported case in the official openfoam.com v2312 container, runs 300 iterations and prints the comparison with the app.

## Findings first

- **Case geometry barely moves the thermal margin for the default parts (AIO GPU, 30 dB(A)).** Across the 55 evaluated layouts the frontier spans under one point of margin. Noise is set by the AIO pumps (22 dB(A) each, estimate), not by the fans.
- **Partitions rarely pay** once fan speeds follow the load and the PSU fan is semi-passive. The zone model adopts one only past `CHAMBER_MIN_GAIN`, and the 3D optimiser drops walls that do nothing in 3D.
- **None of the round-2 structures beats the uncertainty on the default design.** They pay only where fans are held back by the noise budget. With a tower cooler and an air-cooled GPU at 24 dB(A), a bell-mouth on the card fan adds +0.75 K of headroom (±55 %).
- **Silencers cost more pressure than they free in noise budget** in every case tried. A ~4.4 dB expansion chamber on the vent side lowers that fan by ~1.7 dB. Its ~0.9 velocity-head loss then costs more speed than the freed budget buys.
- **At the same fan speeds, the 3D sim runs every part hotter than the 1D model** on the default design: CPU +8.9 K, GPU memory/VRM +6.2 K, GPU core +7.0 K, PSU intake +3.5 K, case air over the board +12.8 K. Until late in this iteration the 3D scene drove every fan on its full rated curve while the 1D model used the solved speeds, which hid part of the gap (GPU core +2.9 K). Fixed in the commit that adds this audit. The OpenFOAM reference (below) sides with the 3D sim.
- **The independent OpenFOAM reference now runs, and it sides with the 3D sim: the 1D model is optimistic.** On the default design, mean air temperature rise inside each heat source, all at the same fan speeds:

| Heat source | App 1D | App 3D sim | OpenFOAM (v2312) |
|---|---|---|---|
| CPU fins | 2.1 K | 11.0 K | 8.5 K |
| PSU | 4.0 K | 7.1 K | 7.7 K |
| GPU card | 3.1 K | 9.3 K | 13.7 K |
| GPU radiator core | 3.8 K | 7.4 K | 9.7 K |
| Board and case air | 6.7 K | 19.5 K | 24.3 K |

  The two 3D solvers agree within 2–5 K, and both run 4–18 K hotter than the 1D model. Not fully like-for-like: the 3D figures are volume means that include stagnant cells, while the 1D figure assumes even through-flow. Airflow agrees better: OpenFOAM vs the 1D model is −30 % for the CPU cooler fan, −7 % PSU, +3 % GPU card fan and −10 % GPU radiator. Recirculation of warm air into the fans is 7–15 %. [inference] The 1D model's main error is its perfectly mixed zones and even flow through each part, not the fan curves. Part temperatures, and the trade-offs built on them, should be read with this offset until a prototype is measured.
- **The 1D model also ranks designs differently from the 3D sim.** For 9 designs spread across each design space (in-app 3D sim, 12 k cells, 2 s of flow, solved fan speeds), the rank correlation of tightest-part headroom between 1D and 3D is 0.40 for the default parts and −0.08 for a tower cooler with an air-cooled GPU. The two models often disagree on which part is tightest: in 3D the board and case air limit many designs, where 1D names the GPU core or PSU intake. The explorer's thermal axis comes from the 1D model, so **its frontier is not reliable until the 1D model's mixing assumption is fixed, or the frontier is re-scored in 3D.** [inference] The short, coarse 3D runs add noise, but the gaps (10–25 K) are well beyond the ±55 % gain uncertainty, and OpenFOAM agrees with the 3D sim on the default design.
- **Leakage cannot be identified from prototype measurements on the default design.** The fit reports it as not identifiable instead of inventing a value.

## 0. Audit of iteration 1

| Requirement | Result | Evidence |
|---|---|---|
| Every iteration-1 criterion checked, with evidence | Pass | [iteration-1-audit.md](iteration-1-audit.md) |
| Failures fixed before new work | Pass | Two missing checks were added in the audit commit. The partials (bridging radius 65 mm, connector reservation, exhaust placement) are named there and carried over below. |

## 1. Acoustic model

| Requirement | Result | Evidence |
|---|---|---|
| Per fan: RPM range, rated noise, P-Q curve; datasheet dBA read as SPL at 1 m | Pass, estimates | `presets.ts` (`acoustics` on the stock fans), `acoustics.ts` › `fanAcoustics`. Values are estimates: no datasheet page was opened from the build environment. |
| Fan laws: Q ∝ N, P ∝ N², Lw +50·log10(N₂/N₁) | Pass | `acoustics.test.ts` › "adds ~15 dB for twice the speed", "scales airflow with speed and pressure with speed squared" |
| Sources: case/radiator fans, GPU card fan, semi-passive PSU fan, AIO pumps | Pass | `evaluate.ts` › `noiseOf`; Model → Noise sources (pump dB, PSU fanless share) |
| Inflow-distortion penalty from obstruction distance and blockage | Pass, estimate | `acoustics.test.ts` › "penalises a grille close to the blades, not one a quarter-diameter away" |
| Tonal penalty at BPF | Pass, estimate | `obstructionPenalty` (tone flag), checks list names the frequency |
| Broadband vent noise | Pass, estimate | `acoustics.ts` › `ventLw` |
| Incoherent sum; Lw and SPL at 1 m (−8 dB, hemisphere) | Pass | `acoustics.test.ts` › "adds 3 dB for two identical fans", "reads a datasheet rating as SPL at 1 m" |
| Noise budget, default 30 dB(A), editable | Pass | Tune → Noise |
| Speed solver: coolest within budget; quietest safe; infeasible reported, never clipped | Pass | `acoustics.test.ts` › "never exceeds the noise budget, and says so when the budget cannot be met", "quiet mode keeps every part under its limit", "cools at least as well with a bigger budget" |

## 2. Explorer with noise

| Requirement | Result | Evidence |
|---|---|---|
| Default view at the budget; frontier recomputed live when the budget changes | Pass | `frontier.test.ts` › "has no frontier design beaten on size and margin at … dB(A)"; e2e "noise budget 25" checks |
| Infeasible designs shown separately | Pass | Hollow points along the bottom, counted in the caption |
| Toggle: noise needed | Pass | e2e "explorer switches to the noise-needed view" (phone and desktop) |
| Fan speeds and noise in the results | Pass | Results → Noise (source by source, with speeds) |

## 3. Flow-shaping structures, round 2

| Requirement | Result | Evidence |
|---|---|---|
| Bell-mouth inlets | Pass, estimate | `structures.ts` (entry K 0.5 → 0.05); `structures.test.ts` › "a bell-mouth helps a design whose fans are held back by the noise budget" |
| Exit diffusers (5–7°), hub-wake fill cone | Pass, estimate | 6° cone, recovery 0.7 × (1 − 1/AR²), in the existing gap and with the case 25 mm deeper. The fill cone is folded into the 0.7. |
| Fan-to-radiator plenum depth | Pass | Plenum +10 / +20 mm in the zone model; 3D flow-uniformity index per core (`FlowSolver.quality`) |
| Turning vanes, Coanda bends, vortex generators | **Not estimated** | Need bend geometry and boundary-layer physics. Listed under Structures as "reference CFD only". |
| Conformal shrouds | Covered | The 3D optimiser's duct structure seals the fan to its vent. The 1D model already sends all fan air through the vent. |
| Helmholtz resonators, gyroid grilles | **Cut** (priority list) | Resonators act on the tone only and the noise model has no spectrum. No loss data for gyroids was opened. Both are listed with the reason. |
| Lined expansion chambers / labyrinths | Pass, standard formula | TL = 10·log10(1 + ¼(m − 1/m)²·sin²kL), averaged over frequency. `structures.test.ts` › "uses the textbook forms". Lining is not credited. A labyrinth = the same plus bend losses. |
| 3D sim at the solved fan speeds | Pass (fixed this iteration) | `scene.ts` scales each fan's free-air speed by s and stall pressure by s²; a fan that is off is an open disk |
| Recirculation fraction per intake | Pass | 3D: air rise at each intake fan ÷ heat-weighted mean rise of the sources (`FlowSolver.quality`; Airflow simulation panel). OpenFOAM: tracer `s` at each fan (`compareWithApp`). |
| Flow-uniformity index | Pass | 3D, per radiator core and fin stack. On the default design: core 0.90, CPU fins 0.61. |
| Pressure recovery per diffuser | Pass, estimate | In each diffuser's basis line (share of the exit head) |
| Each structure: before/after temperatures and noise, volume, weight, filament, print time | Pass | Structures panel; e2e "structures list … with their costs and basis, no page scroll" (phone and desktop) |
| Kept only past the model uncertainty; off the frontier until confirmed | Pass | `worthIt`: > 3 % of the tightest part's budget, or ≥ 1 dB quieter. Nothing here changes the design or the explorer. |

## 4. Printability and materials

| Requirement | Result | Evidence |
|---|---|---|
| Overhang check ≤ 45°, support volume | Pass | `printability.test.ts` › "finds the orientation of a T that needs no support", "counts support under an overhang when it has to" |
| Orientation per piece | **Partial** | Self-supporting first, then least support. "Layers parallel to the local flow" is not applied. |
| Segmentation into the build volume; joint leakage into the zone network | Pass | `printability.test.ts` › "cuts the shell into pieces that fit a 250 mm build volume and plans every one"; `evaluate.ts` › `printJointLeak` |
| Material by adjacent air temperature (HDT − 20 K); V-0 near the PSU flagged | Pass, HDT estimates | `printability.test.ts` › "moves hot pieces to a higher-temperature filament, with a 20 K margin"; `nearPsu` (30 mm) |
| Inserts, grounding, EMI note and optional liner | Pass | Print dialog (`insertPlan`, liner option) |
| Stiffening ribs near fan BPF | **Deferred** (optional polish) | Not implemented |
| Per-piece STL with manifest (material, orientation, mass, time); editable slicer settings | Pass | Print dialog; `manifestCsv`; `printability.test.ts` › "prices a solid cube…" |

## 5. Simulation fidelity, round 2

| Requirement | Result | Evidence |
|---|---|---|
| OpenFOAM case export (buoyantSimpleFoam, k-ω SST, snappyHexMesh, fan jumps, porous radiators, heat sources) | Pass | `openfoam.test.ts` (complete, parseable, consistent references, valid STL). CI on openfoam.com v2312: meshes (36 k cells, "Mesh OK") and runs 300 iterations (airflow changes under 1 % over the last 50 for all fans but the PSU, 4 %). Two bugs caused the earlier divergence. (1) Snapping to the shell left collapsed sliver cells where a wall meets a vent: it diverged within three iterations even with no fans, heat or gravity, so the mesh is now castellated (stair-stepped) by default. (2) Heat zones overlapped porous zones, and OpenFOAM keeps a cell in one zone only, so the CPU heat zone had no cells (division by zero) and the board kept 292 of 733. Zones are now disjoint, and a heat source that is a porous block heats that zone. The CI job stays optional (`continue-on-error`) because it pulls a 1 GB container. |
| Results import with residuals against the app | Pass | `openfoam.test.ts` › "reads the last row of each function object…" (synthetic) and "imports the run and compares it with the app" (the CI run's own results) |
| Measurement import and fit (radiator, leakage, noise), ≥ 2 speeds | Pass | `calibrate.test.ts` › "asks for at least two different fan speeds", "reduces the residuals on synthetic data and recovers the corrections". Unidentifiable factors are reported, not fitted. |
| Boundary-layer structures marked "needs reference CFD" and off the frontier | Pass | Structures panel; `UNRESOLVED_STRUCTURES` in the 3D optimiser |
| Model uncertainty as numbers next to every gain | Pass | `uncertainty.ts`: airflow ±5 %, structure gains ±55 % of themselves |
| Grid refinement, three levels, GCI; no refinement reverses a gain | Pass | `cfd-calibration.test.ts` › GCI (1.1 % spread, oscillating); `cfd.test.ts` › "keeps the deflector gain when the grid is twice as fine" (5.6 → 2.6 K, same sign) |

## 6. Output and verification

| Requirement | Result | Evidence |
|---|---|---|
| Noise at both loads, fan speeds, recirculation, piece count, materials, support, mass, print time | Pass | Results → Noise (both loads), Airflow simulation (recirculation), Print dialog manifest |
| Unit tests listed in the brief | Pass | `acoustics`, `printability`, `openfoam`, `calibrate`, `frontier` test files |
| Browser test: noise control and explorer at 390 px and desktop | Pass | e2e `explorer-phone`, `explorer-desktop` |
| README and airflow brief updated | Pass | README "Noise", "Structures", "Fidelity"; airflow brief "Update, iteration 2" |
| Staged commits with tests passing | Pass | 9f5fba4 acoustics → afb6b70 explorer → 31d886a printability → 544d661 fidelity → cd8e617 structures. 1f8a00c fixed two CI failures introduced on the way (an e2e timing race and an ambiguous locator). |

## Carried over

- The OpenFOAM reference meshes only the air inside the case (no room around it), on a stair-stepped mesh at 6–12 mm. A snapped mesh needs the vent/wall junction cleaned up first; room air needs a larger domain.
- Use the reference to correct the 1D model (mixing in the zones, uneven flow through parts), or re-score the explorer's frontier with the 3D sim, then re-check the ranking.
- The GPU connector's local reservation in the packer is dropped: box thickness is set by the tallest rectangle either way, and the shrinkwrapped shell already uses the local plug box, so the expected gain is about zero.
- Orientation by local flow direction; stiffening ribs.
- Iteration-1 partials still open: local GPU-connector reservation in the packer, exhaust placement and overpressure not optimised, bridging radius 65 mm instead of 90.
- Every coefficient in the acoustic and structure models is an estimate. None was checked against a cited source or a measurement in this iteration.
