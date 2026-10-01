# Iteration 1 audit

Every acceptance criterion and requirement in [iteration-1-brief.md](iteration-1-brief.md), checked against the code at the end of iteration 1. **Pass** means a test or a measurement shows it; **partial** means part of it is done and the rest is named; **deferred** means it moved to iteration 2 on purpose.

Tests are in `tests/` (`npm test`, 55 tests) and `e2e/run.mjs` (`npm run e2e`, 29 browser checks).

## 1. Tight shell

| Criterion | Result | Evidence |
|---|---|---|
| Separate *Shell* and *Smoothness*; smoothness never blends in the box | Pass | `src/solver/shrinkwrap.ts` (`shellGrid`: box field only when Shell = box); Tune → Shape & finish |
| Bridging radius ~15 → 90 mm | **Partial** | 15 → 65 mm. At 90 mm one slot-mounted design left 26.4 % unexplained volume, over the 25 % target; 65 mm gives 23.5 %. |
| Wrap encloses bodies, clearances and routed hoses, offset by the wall | Pass | `shrinkwrap.test.ts` › "keeps every part body, clearance, hose and cable at least a wall inside, at every smoothness" (4 designs × 3 smoothness levels) |
| Litres the smoothing adds are shown | Pass | Summary text ("smoothness adds 0.5 L" on the default design) |
| GPU power connector as a local box plus a cable path to the PSU | **Partial** | The shell uses a local 50 mm plug box and a routed cable (`hoses.ts`: `connectorBox`, `gpuCablePath`). The **solver still reserves the bend room along the whole card edge** when packing, so in slot-mounted designs the case thickness still includes it. A local reservation needs non-box footprints in the packer. |
| Hoses checked against length and bend radius | Pass | `evaluate.ts` › `hoseChecks` (routed path length + 20 mm fittings; bends under 35 mm flagged) |
| Unexplained volume < 15 % at smoothness 0 | Pass | 5.1–6.2 % on 4 designs (`shrinkwrap.test.ts` › "leaves under 15 % unexplained volume…") |
| Unexplained volume < 25 % at smoothness 1 | Pass | 17.6–23.5 % on the same 4 designs |

## 2. Thermal targets per component

| Criterion | Result | Evidence |
|---|---|---|
| CPU, GPU core, GPU memory/VRM, PSU intake air, SSD/board air each against its own limit | Pass | `airflow.ts` › `ComponentSpec`; Results → Component temperatures |
| T = room + inlet air rise + air/coolant rise + power × resistance | Pass | `airflow.test.ts` › "rates each component against its own limit, with its own internal rise" |
| Typical gaming and sustained full load, editable | Pass | Tune → Thermal targets; Model → Loads; both loads shown in the results |
| Limits, resistances, loads editable and marked estimate or cited | Pass, estimates only | Model tab sections are titled "(estimates)". None is cited: the manufacturer sites were unreachable from the build environment. |
| Score = heat-weighted headroom; worst component prominent | Pass | `FlowResult.score`, `worstMargin`; Summary → "Tightest part" |

## 3. Multi-chamber airflow model

| Criterion | Result | Evidence |
|---|---|---|
| Zone network: pressures, temperatures, fans between zones, own vents, leaky partitions | Pass | `airflow.ts` › `solveNetwork` |
| Mass and energy balance | Pass | `airflow.test.ts` › "conserves mass and energy across chambers" (3 zones, 2 links) |
| Only buildable partitions (no body or clearance cut; pass-throughs) | Pass | `chambers.test.ts` › "never puts a partition through a part body" and "…through any functional clearance" |
| 1 vs best 2- and 3-chamber layouts compared for every design; temperature change and cost reported | Pass | `evaluate.ts` (`chamberOptions`); Results → Internal chambers; `chambers.test.ts` › "adopts a partition … only past the threshold" |

## 4. Flow-shaping structures

| Candidate | Result | Notes |
|---|---|---|
| Intake/exhaust separation (deflectors) | Pass | Kept only above the 3 % threshold; recirculation test +8.3 K → +2.8 K |
| Ducts sealing a fan to its vent | Pass | Optimiser candidate |
| Partitions (chambers) in 3D | Pass | Added, or the design's walls removed when they do nothing in 3D (`cfd.test.ts` › "keeps a structure only when it beats the uncertainty…") |
| Fan-to-panel spacing and shrouds | Pass | Spacing via the solver's gap profiles; fan frames are solid shrouds in the 3D scene |
| Stacking hot exhausts high | **Partial** | Only through radiator fan reversal; no candidate moves an exhaust to a higher panel. |
| Slight overpressure for dust | **Partial** | Case pressure is reported; not optimised as a structure. |
| Bell-mouth inlets, exit diffusers, turning vanes | **Deferred** | Below the ~1 cm grid; listed in the UI as unresolved. Iteration 2 § 3 and § 5. |
| Vortex / "McLaren" structures only if the sim shows a gain | Pass | None claimed beyond the deflector, which the simulation shows |
| Each kept structure shows before/after temperatures, flow picture, volume cost | Pass | Sim panel table (as solved vs shaped), 3D view, weight per step; all structures sit inside the shell (no added volume) |

## 5. Design-space explorer

| Criterion | Result | Evidence |
|---|---|---|
| Every valid evaluated design, not just the shortlist | Pass | `SolveResult.space` (70 designs for the default build) |
| Size vs worst-component headroom, frontier highlighted, ends labelled | Pass | `frontier.test.ts`; e2e "plots the design space" |
| Tap/click loads a design; works on touch | Pass | e2e on 390 px phone (tap) and desktop (click) |
| A *Size ↔ Thermal* control moves along the frontier | Pass | e2e "the Size ↔ Thermal slider snaps to the coolest end" |
| 3D sim on request for the selected point and both ends, with agreement shown | Pass | e2e "3D check plots … simulated point(s)"; table of model vs 3D |
| Frontier correctness test | Pass | `frontier.test.ts` › "has no frontier design beaten on both size and margin" |

Finding: for the default parts the frontier is nearly flat (55 → 56 % of the tightest part's budget). The case shape barely moves temperatures because each part's own rise above its air dominates. The explorer says so.

## 6. Simulation fidelity

| Criterion | Result | Evidence |
|---|---|---|
| Radiator and perforated-panel cases within 20 % of the fan-curve model | Pass | −1 % (panel), 0 % (radiator), −2 % (open duct): `cfd-calibration.test.ts` |
| Halving the cell size must not reverse a reported gain | Pass, with a caveat | Radiator flow changes 0.3 % (`cfd-calibration.test.ts`). The deflector gain keeps its sign but drops from 5.6 K to 2.6 K (`cfd.test.ts` › "keeps the deflector gain when the grid is twice as fine"), so gain **magnitudes** are grid-dependent by about 2×. |
| Limits stated in the UI | Pass | Sim panel note; README "Known limits" |

The calibration is against the app's own fan-curve model, so it shows the solver is consistent with that model, not that either is right. Iteration 2 § 5 adds independent references.

## 7. Output and verification

| Criterion | Result | Evidence |
|---|---|---|
| Per-design outputs (size, volume, thickness, temperatures at both loads, chambers, structures) | Pass | Results panel |
| Partitions in the 3D view and printable pieces | Pass | `chambers.test.ts` › "exports partition plates as closed pieces that fit the bed" |
| Unit tests: shell tightness, conservation, calibration, frontier | Pass | as listed above |
| Browser test of the explorer on phone and desktop | Pass | `e2e/run.mjs` (29/29) |
| README and airflow brief updated | Pass | |
| Commits in stages with tests passing | **Partial** | Stages committed separately, but calibration (stage 6) was done before structures (stage 4): structure gains measured with the uncalibrated sim would have been meaningless. |

## Open items carried into iteration 2

1. Local GPU-connector reservation in the packer (thickness of slot-mounted designs).
2. Exhaust placement and overpressure as optimised structures.
3. Bell-mouths, diffusers, turning vanes (iteration 2 § 3, with reference CFD).
4. Grid dependence of structure gains: GCI over three levels (iteration 2 § 5).
5. Citations for the component limits and thermal resistances.
