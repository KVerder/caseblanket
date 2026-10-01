# Iteration 2 brief

Written by the project owner, with the review changes from the planning discussion folded in (marked *review*). Runs after iteration 1.

**Role and context.** You are continuing work on caseblanket (KVerder/caseblanket), a TypeScript + Vite + React + three.js web app that designs a 3D-printed PC case around a parts list (motherboard, CPU cooler, PSU, GPU; AIO liquid-cooled GPUs are the main case). The previous iteration's brief is docs/iteration-1-brief.md. Read it, the README and docs/airflow-sim-brief.md before changing anything.

**Objective.** Extend the trade-off from two axes (size, thermal headroom) to three (size, thermal headroom, noise). The case is a home product: noise is a hard constraint, not an afterthought. Air is moved by stock 120/140 mm axial fans only (parts' own fans — GPU card fan, PSU fan, AIO pump — as given by the part; *review*). All gains come from case geometry. Every thermal or acoustic claim must come from the app's own calculation or simulation, never from analogy.

## 0. Audit the previous iteration (do first)

- Check every acceptance criterion in docs/iteration-1-brief.md. Report each as pass/fail with evidence (test name, measured value).
- Fix failures before starting new work. Commit the audit report as docs/iteration-1-audit.md.

## 1. Acoustic model

- Per fan: rated RPM, min/max RPM (*review*), rated sound power or dBA, P-Q curve. Mark each value cited or estimate. Datasheet dBA is treated as SPL at 1 m unless sound power is cited (*review*).
- Fan laws: Q ∝ N, P ∝ N², sound power ~ 50·log10(N2/N1) dB (estimate unless cited).
- Sources: case and radiator fans, GPU card fan, PSU fan (semi-passive threshold), AIO pump as a fixed source (*review*).
- Installation penalties:
  - inflow distortion: obstruction (panel, grille, radiator, part) within a set distance of the fan face, from obstruction distance and blockage ratio (estimate); turbulence intensity only from imported reference CFD (*review*: the browser grid does not resolve turbulence);
  - tonal penalty for struts, grilles or edges close to the blades, at blade-pass frequency (BPF = blades × RPM / 60);
  - broadband vent noise from face velocity at each vent.
- Sum sources incoherently; report case sound power and dBA at 1 m (SPL = Lw − 8 dB, desk / hemispherical free-field estimate, labelled as such; *review*).
- Noise budget control, default 30 dBA at 1 m (estimate, editable).
- Fan-speed solver: for each design, choose fan speeds that maximise worst-component headroom within the noise budget. Alternate mode: minimise noise subject to headroom ≥ 0 for every component. If no speed set meets the budget, report "infeasible at budget" and the noise needed, never clip (*review*).

Acceptance: tests that one fan at 2× RPM adds ~15 dB, two identical fans add 3 dB, and the speed solver never exceeds the budget.

## 2. Explorer: add noise

- Default view: x = size (per slider), y = worst-component headroom, all designs evaluated at the noise budget. Changing the budget recomputes the frontier live with the 1D model. Infeasible designs shown separately (*review*).
- Toggle: y = noise required for zero headroom.
- Points show fan speeds and noise in the results panel. Touch support as before.

## 3. Flow-shaping structures, round 2

Generate parametrically from these rules; keep only structures whose gain exceeds model uncertainty (section 5). Gains may be thermal, acoustic, or both.

- Bell-mouth inlets: lip radius as a fraction of fan diameter (start ~0.1–0.2, estimate), replacing sharp-edged openings.
- Exit diffusers: half-angle 5–7°; hub-wake fill cone behind fan motors.
- Radiused (Coanda) bends; turning vanes wherever bend radius < ~1 duct width.
- Conformal shrouds closing the fan tip gap; fan-to-radiator plenum depth optimised for flow uniformity.
- Vortex generators upstream of radiator or fin stacks: only with reference CFD (section 5), since the browser grid cannot resolve boundary layers.
- Helmholtz resonators in double-walled panels, tuned to BPF at the solved operating RPM; gain shown across the operating RPM range (*review*).
- Gyroid/TPMS grilles vs perforated panels: pressure-drop coefficients from reference CFD or cited sources.
- Lined expansion chambers or labyrinth exhausts as combined duct and silencer.
- Acoustic gains of resonators, lined chambers and labyrinths use transmission-loss formulas (estimate) or are marked "needs reference" (*review*).

New metrics, per design: recirculation fraction (passive scalar from GPU/radiator exhaust, measured at each intake); flow uniformity index across radiator and heatsink faces; pressure recovery per diffuser.

Each kept structure shows before/after component temperatures and noise, flow picture, volume, weight, filament mass, print time.

## 4. Printability and materials

- Overhang check: generated internal structures self-supporting at ≤ 45°; report any support volume.
- Recommend print orientation per piece. Priority: self-supporting, then fewest pieces, then layers parallel to the local flow in ducts and on curved turning surfaces (*review*).
- Segment the shell and internals into pieces fitting an editable build volume (default 250 mm cube), with alignment and sealing joints. Feed joint leakage into the zone network as gaps.
- Material per piece from maximum predicted adjacent air temperature at sustained load, with margin: PLA only well below ~55 °C, otherwise PETG, ASA, or PC/PA-CF. UL94 V-0 near the PSU; if the chosen material is not V-0, flag it and require a V-0 filament or a metal PSU enclosure (*review*). Cite heat-deflection values or mark them as estimates.
- Metal inserts and grounding points for motherboard and PSU mounting. Flag in the UI that a plastic shell provides no EMI shielding; offer an optional conductive liner (optional polish; *review*).
- Panel stiffening ribs where a simple plate estimate puts the first mode near fan BPF (estimate, labelled; optional polish; *review*).
- STL export per piece with a manifest: material, orientation, filament mass, print time estimate. Slicer assumptions: 0.2 mm layers, 3 walls, 15 % gyroid infill, 100 mm/s (estimate, editable; *review*).

## 5. Simulation fidelity, round 2

The last calibration compared the 3D sim to the app's own fan-curve model, which is circular. Add independent references:

- OpenFOAM case export: geometry, fans as pressure-jump boundaries from P-Q curves, radiators as porous media, heat sources, buoyancy (Boussinesq), k-omega SST, snappyHexMesh and solver dictionaries (buoyantSimpleFoam). The user runs it offline. Import results (per-fan flow, component air temperatures, recirculation fraction) and show residuals against the app. Test: a parser check, plus an optional CI job that meshes and runs 50 iterations in the official OpenFOAM container (*review*).
- Measurement import: the user enters thermocouple temperatures, fan RPMs and SPL at 1 m from a printed prototype. Minimum data set: sensor count and locations as specified by the app, fans at ≥ 2 speeds (*review*). The app fits correction factors (radiator resistance, leakage, noise offset) and shows residuals before and after the fit.
- Structures whose gain depends on boundary-layer physics (vortex generators, Coanda surfaces, fin heat transfer) are marked "needs reference CFD" and kept off the explorer frontier until verified by import.
- Define model uncertainty numerically from calibration residuals and grid-refinement deltas. Show it next to every reported gain.
- Grid refinement: three levels, run as a test/CLI job rather than interactively (*review*); report GCI for headline quantities. No refinement may reverse a reported gain.

## 6. Output and verification

Per design, in addition to iteration 1 outputs: noise at both loads, fan speeds, recirculation fraction, piece count, materials, support volume, filament mass, print time.

Unit tests for: acoustic summation, speed scaling and the budget-constrained speed solver; overhang check and build-volume segmentation; OpenFOAM export produces a complete, parseable case; measurement import fit reduces residuals on synthetic data; frontier correctness with noise (no frontier point beaten on size and headroom at the same budget).

Browser test covers the noise control and explorer on a 390 px phone and desktop. Update the README and the airflow brief.

Commit in stages (audit fixes → acoustics → explorer noise → structures → printability → fidelity and export), each with tests passing.

**Priority if time runs short** (*review*): acoustics + speed solver → explorer noise → printability basics → OpenFOAM export → structures → measurement import → resonators / gyroids / vortex generators.

## Ground rules

- No hidden trade-offs: every structure lists thermal gain, noise change, volume, weight and print cost.
- No thermal gain may be bought with unreported noise.
- Numbers from outside the app are cited from pages actually opened, or marked as estimates.
- Defaults where unspecified: 25 °C room; typical gaming load at 50 % CPU and 90 % GPU of rated power (estimate); noise budget 30 dBA at 1 m (estimate); PETG; 250 mm build volume.
