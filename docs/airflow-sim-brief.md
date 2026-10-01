# Airflow simulation and flow shaping: brief

## Original request

> Incorporate and visualise a fluid dynamics model showing the airflow dynamically in the rendering. … directing airflow to do all kinds of weird vortex stuff or anything that might help the thermal performance. Think of how McLaren designed their brake system to bend air around in a way that kept the heat from the brakes away from the tires.

## Improved brief

Add a 3D airflow and heat simulation that runs in the browser for the selected design. Show it live in the 3D view, and use it to search for flow-shaping features that lower the temperature of the air each heat source breathes.

**What the McLaren idea maps to in a PC case.** The brake ducts don't make cooling air out of nothing. They steer hot air away from the part that must stay cool. In a case, the equivalent is keeping hot exhaust out of the intakes, both outside the case (a plume curling back into a neighbouring vent) and inside it (a radiator dumping heat where the CPU cooler breathes). The levers are:
1. **Exhaust deflectors:** louvres angled so each hot plume leaves pointing away from the nearest intake.
2. **Intake ducts:** a short shroud between a fan and its vent, so the fan draws outside air and not case air.
3. **Fan direction:** each radiator pushes or pulls, chosen by simulation, not by rule of thumb.
4. **Fan swirl:** axial fans leave a rotating jet. The simulation includes it, which is where visible vortices come from.

**Simulation.**
- Incompressible flow on a staggered (MAC) grid covering the case plus about 60 mm of room air around it, with an open far boundary at room temperature.
- Fans act as actuator disks. Each is driven to the airflow the fan-curve model already computes and given a swirl component.
- Radiators, fin stacks, the PSU and the GPU shroud are porous blocks that let air through along one axis only. Perforated panels are porous by their open area.
- Temperature is carried with the air. Heat goes in where each part releases it, and warm air rises (buoyancy, along real "up" for the chosen orientation).
- It runs in a Web Worker and streams frames, so the view animates while it converges.

**Visualisation.**
- Thousands of animated tracer particles follow the simulated flow, coloured from room temperature (blue) to hottest (red).
- An optional temperature slice that can be swept through the case.
- A legend with the temperature scale.

**Optimiser ("Shape the airflow").**
- Starts from the current design and tries each lever in turn, keeping a change only if it lowers a heat-weighted intake air temperature.
- Reports before and after numbers for every heat source and draws the chosen louvres and ducts.

## Goals and how they are checked

| Goal | Check |
|---|---|
| Flow is physically consistent | Unit test: in a sealed box with one fan the solver's divergence stays near zero, and the flow through an open duct matches the imposed fan flow within 15%. |
| Heat goes where it should | Unit test: with fans off and a heat source on, warm air rises toward "up"; with a fan on, the hottest air leaves through the exhaust side. |
| Recirculation is detectable | Unit test: an exhaust vent placed next to an intake raises that intake's air temperature in the simulation, and pointing the exhaust deflector away lowers it. |
| Fast enough to use | First animated frame within 1 s; a converged simulation of the default design within about 10 s on a laptop, without freezing the page. |
| Visible and touch-friendly | Particles animate on phone and desktop; rotate, pinch and pan keep working while the simulation runs (end-to-end test). |
| Honest | The UI labels it a coarse simulation (about 10 mm cells). It shows the cell size and doesn't claim accuracy it lacks. |

## Out of scope / known limits

- Grid cells of about 10 mm can't resolve fan blades, fin passages or boundary layers. Swirl is imposed, not resolved, and fine vortex structure is partly numerical.
- Steady-state numbers are good for comparing layouts and shaping options. They aren't a substitute for testing a prototype.
- The temperature rise comes from the heat released into the air. Component junction temperatures are not modelled.

## Update, iteration 1 (see docs/iteration-1-brief.md)

**Calibration.** The first version under-predicted airflow by about 40 % even in a plain duct: the fans' push and the porous drag were applied before the pressure projection, which diluted them by (1 + coefficient × dt) at the time steps used, roughly 13× for fans and 6× for radiator cores. Both now act inside the projection: every face's velocity is v = W·(v* − Δp/h) + S, with porous drag giving W = 1/(1 + k·|v*|·dt) and each fan face carrying its fan curve as a pressure jump, Δp = Pmax·(1 − v/vmax), solved implicitly (as OpenFOAM's fan baffle). Calibration tests (`tests/cfd-calibration.test.ts`), a 120 mm fan in a duct open to room air at both ends, against the fan-curve model with the same losses:

| Case | 3D sim | Fan-curve model | Difference |
|---|---|---|---|
| Open duct | 52.2 CFM | 53.0 CFM | −2 % |
| Through a 50 %-open perforated panel | 42.1 CFM | 42.3 CFM | −1 % |
| Through a 27 mm radiator core | 33.0 CFM | 33.2 CFM | 0 % |
| Radiator case, cells 12 mm → 6 mm | 33.1 → 33.0 CFM | | −0.3 % |

In a full case the radiator's air temperature rise agrees with the fan-curve model within 7 %. This calibration is against the app's own fan-curve model, so it checks the solver's consistency, not reality; iteration 2 adds independent references (an OpenFOAM case export and measurements from a printed prototype).

**Component temperatures.** Simulation results are read as component temperatures by the same rules as the airflow model: the simulated air (or coolant) around each part plus that part's own rise (power × an estimated thermal resistance), against its own limit, at the design's load.

**Structures.** The optimiser tries exhaust deflectors, intake ducts, radiator fan reversals and internal partitions (or removing the design's own), and keeps a change only when it lifts the tightest part's margin by more than 3 % of its budget; walls that make no difference in 3D are dropped. Bell-mouth inlets, diffusers, turning vanes and vortex generators act on features smaller than a grid cell, so they are listed as needing a finer reference simulation and never claimed.

**Recirculation test, recalibrated.** An exhaust beside an intake: the intake air is +8.3 K over room without a deflector, +2.8 K with one (before calibration: +8.0 K and +2.0 K).
