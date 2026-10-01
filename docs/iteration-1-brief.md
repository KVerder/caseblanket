# Iteration 1 brief

**Role and context.** You are extending **caseblanket** (`KVerder/caseblanket`), a TypeScript + Vite + React + three.js web app that designs a PC case around a parts list (motherboard, CPU cooler, PSU, GPU; AIO liquid-cooled GPUs are the main case). It already has a layout solver (beam search over flat / sandwich / direct-slot / stacked layouts), a one-zone fan-curve airflow model, a 3D airflow + heat simulation with an exhaust/duct optimiser, a shrinkwrapped organic shell, touch-friendly 3D rendering, and STL / 3D-printable / SVG exports. Read the README and `docs/airflow-sim-brief.md` before changing anything.

**Objective.** Let the user see and pick from the whole trade-off between (a) the smallest case (volume or thickness, weighted by the existing slider) and (b) the best thermal performance, with internal air-guiding structures designed from fluid-dynamics principles. Every thermal claim must come from the app's own calculation or simulation, never from analogy.

## 1. Tight shell (fix before anything else)

Problems found in review: the Shape slider still blends in the straight box (at 0.6: 16.9 L vs 15.0 L fully wrapped); the 220 mm closing radius bridges hollows that hold nothing (15.0 L vs 11.8 L unbridged); AIO hoses aren't part of the wrap and stick out; the GPU power-connector clearance is a 35 mm strip along the whole card and sets the case thickness.

- Separate controls: *Shell* (straight box / shrinkwrap) and *Smoothness* (gap-bridging radius ~15 → 90 mm, plus edge rounding). Smoothness never blends in the box.
- The wrap encloses part bodies, functional clearances and routed hoses, offset by the wall. Show the litres the smoothing adds.
- Clearances sit where the feature is: the GPU power connector gets a local box at its real position plus a cable path to the PSU. Hoses are routed parts, checked against hose length and bend radius.
- **Acceptance:** enclosed volume not explained by parts, clearances or hoses is < 15 % of the shell at smoothness 0 and < 25 % at 1; no body, hose or clearance less than one wall from the outside; existing tests green, new tests for both.

## 2. Thermal targets per component

- Rate every component against its own limit, replacing the single "allowed air rise": CPU, GPU core, GPU memory/VRM, PSU intake air, SSD/board air.
- Component temperature = room + inlet air rise + air or coolant rise across its heat exchanger + the part's internal rise (power × its thermal resistance).
- Load profiles: *Typical gaming* (default) and *Sustained full load*, as editable fractions of CPU and GPU power.
- Limits, internal resistances and load fractions are editable in the Model tab, each marked *estimate* or cited.
- Thermal score = heat-weighted headroom (limit − predicted temperature); the worst component is shown prominently.

## 3. Multi-chamber airflow model

- Replace the one-zone model with a zone network: each zone has its own pressure and air temperature; fans connect outside ↔ zone or zone ↔ zone; each zone has its own passive vents; partitions leak through set gaps (seams, hose and cable pass-throughs). Mass and energy balance are solved together.
- Generate only buildable partitions: flat walls or shrouds that cut no part body or clearance, with pass-throughs for hoses, the riser and cables. 3D-printable by default.
- For every design, compare one chamber against the best 2- and 3-chamber layouts. Report each component's temperature change and the partition's volume and weight cost.

## 4. Flow-shaping structures

Generate, simulate and keep only those that lower the worst component temperature by more than the model's uncertainty: intake/exhaust separation against recirculation; ducts sealing a fan to its own vent; fan-to-panel spacing and shrouds; bell-mouth inlets and exit diffusers; turning vanes at sharp bends; exhaust louvres that throw hot air away from intakes; stacking hot exhausts high so rising warm air helps; slight overpressure for dust. Vortex or "McLaren-style" structures are in scope only if the simulation shows a gain. Each kept structure shows before/after component temperatures, the flow picture and its volume cost.

## 5. Design-space explorer (main deliverable)

- Collect every valid design the solver evaluates (layouts, gap profiles, chamber layouts, structures), not just the shortlist.
- Plot size against worst-component headroom: x = volume or thickness (per the slider). Highlight the frontier (best headroom for each size) and label the minimum-size and maximum-thermal ends.
- Tapping any point loads that design into the 3D view and results. Works on touch.
- A single *Size ↔ Thermal* control moves along the frontier.
- The 1D model scores everything. The 3D simulation runs on request for the selected point and both ends, and shows how far it agrees with the 1D model.

## 6. Simulation fidelity

- Calibrate the 3D simulation against the fan-curve model on two simple cases (one fan through a radiator, one fan through a perforated panel) to within 20 % on airflow. Today the 3D sim is ~2.5× low on radiators.
- Grid-refinement check: halving the cell size must not reverse any reported gain.
- State the remaining limits in the UI next to the results.

## 7. Output and verification

- Per design: outer size, volume, thickness, component temperatures vs limits at both loads, chamber layout, kept structures with measured gains.
- Partitions and ducts appear in the 3D view and in the printable STL pieces.
- Unit tests for the shell tightness criteria, zone-network mass and energy conservation, the calibration cases, and the frontier (no frontier point beaten on both size and headroom by another design).
- Browser test covers the explorer on a 390 px phone and on desktop. Update the README and the airflow brief.
- Commit in stages (shell → thermal model → chambers → structures → explorer → calibration), each with tests passing.

## Ground rules

- No hidden trade-offs: every structure lists its thermal gain and its volume and weight cost.
- Numbers from outside the app are cited from pages actually opened, or marked as estimates.
- Defaults where unspecified: 3D-printed construction; 25 °C room; typical gaming load at 50 % CPU and 90 % GPU of rated power (estimate).
