# Expert team: the best case for heat dissipation

Three specialist passes over the default parts (Mini-ITX board, AXP120-X67 downdraft cooler, RTX 5080 SUPRIM LIQUID with a 3×120 radiator, SFX 850 W PSU), judged by the app's 3D simulation, not by the fast airflow model. Margin = share of the tightest part's temperature budget left (`thermal.worstMargin`); differences under about 0.03 are within the simulation's run-to-run noise. Coefficients marked *from memory* were not checked against a source opened here.

## Result: the cooling flagship

Shapes → Showcase → **Cooling flagship**: a slim tower, every part in one layer, the GPU radiator straight through the case, 10 mm more room in front of the CPU cooler, card and radiator fans (Model: cooler and card fan gaps 15 mm, radiator wall gap 10 mm), hex perforation with rounded holes, 20 mm feet, no case fans, at the default 30 dB(A) budget. Layout `flat-tight-slim-6`, 104 × 643 × 320 mm, 20.7 L (box envelope).

| Grid | Cells | Margin | Tightest part |
|---|---|---|---|
| ~15 mm | 22 000 | 0.439 | GPU memory/VRM |
| ~11 mm | 55 000 | 0.428 | GPU memory/VRM |
| ~9 mm | 110 000 | 0.441 | GPU memory/VRM |

On the finest grid: CPU 49.2 °C, GPU core 55.1 °C, GPU memory/VRM 64.2 °C, air over the board 37.9 °C, PSU intake 26.5 °C (room 25 °C). The same layout with the default gaps: 0.361 (GPU core 62.1 °C, the tightest part). The tightest part is now the card's memory/VRM, whose own rise (29 K of a 70 K budget) caps its margin at 0.58 even in room-temperature air: further gains have to come from the card, not the case. With the noise budget lifted, layouts reach 0.48 in 3D, but the best ones are then bound by the air over the board, which moves 0.1–0.25 between grids, so they are not offered as a showcase.

The thermal expert's own pick (console, radiator and two case fans exhausting through the top) scored 0.416/0.426 on its branch; with all three branches merged it fell to 0.281 on the fine grid, bound by the air over the board, and was dropped.

## Inlet and outlet aerodynamics

- **Room in front of the fans is the lever within the noise budget**: +10 mm on the cooler, card and radiator gaps gave +0.05 to +0.09 on both orientations and two grids (GPU core 4–5.5 K cooler). The gaps involved are about a cell wide; a fan-in-duct check at 5 mm cells is still to do.
- Fine (40 % open) perforation instead of hex (69 %): −0.05 to −0.11. Keep hex.
- Lifting the noise budget: +0.10 to +0.16, the biggest single lever.
- Rounded holes, deflectors, ducts, deeper plenums: under 0.005 each (noise). A 5–10 mm fan gap is too short for a diffuser to recover anything, and fan curves already include the frame inlet, so a bell-mouth's credit is now capped at the fan-proximity loss actually charged.
- Coefficients corrected: vents use Idelchik's thick-plate form for the 2.4 mm panel (hex 1.19 → 1.12), rounded holes follow the rounded-entry table (hex 1.12 → 0.76). From memory.
- A through-flow radiator's fans can now be reversed in 3D and are tried by the shaping optimiser (reversing them was worse here: −0.03).

## Internal flow routing

- Nothing beat the noise on the default parts: a duct sealing the radiator's intake side (+0.001, +0.002, −0.039 on three layouts), ducts on the CPU, PSU and GPU fans (−0.001 to +0.008), exhaust louvres in four directions (−0.012 to 0), and 45° turning vanes under intake case fans (−0.003 to 0; built as a 3D-only option, `Shaping.vanes`, not printed).
- The radiator already breathes fresh air: along its intake path the air is 0.2–0.75 K above room until one cell before the core. The 2.5–7 K inlet rise the 3D model reports is mostly the core's heat spreading upstream on the grid.
- The board sits in the CPU cooler's exhaust (air reaching the board ≈ air leaving the CPU fins), so turning another jet across it can't cool it below that; only a separate fresh-air path would.
- Case fans: +0.08 in a tower at 10 mm cells but none at 8 mm; worse in a console.

## Thermal architecture and heat transfer

- Across 48 layouts (8 configurations: tower/console, 0/2 case fans, radiator intake/exhaust), the fast model ranked layouts against 3D at a rank correlation of 0.33; 3D margins ranged −0.02 to 0.42. Use *Rank in 3D* or the explorer's 3D scoring before choosing.
- Winners share: the board swept by the downdraft cooler's jet with nothing blocking the pocket; the radiator on its own wall with a clear plenum (core uniformity 0.82–0.90). Radiator intake vs exhaust trades the GPU core against the card's memory/VRM: an intake radiator pays only if the card's fan and the board draw from a separate stream.
- 3D radiator model fixed: core cells now exchange heat with one coolant temperature at a rate set by their local air speed (NTU from the effectiveness, h ∝ v^0.51 after Chang & Wang 1997, from memory), so starved columns no longer overheat without limit; GPU core 0.6–5.3 K cooler in 3D.
- Vortex generators ahead of the radiator or fin stacks: not worth building. The 1–2 mm fin pitch and louvres break up upstream vortices and the fan's swirl already exceeds what they add; even +10 % air-side coefficient for 3 % less flow is about −0.26 K. Published gains (+16–44 %, Joardar & Jacobi 2008, from memory) are for generators punched into plain fins.
- Fan hub dead zone: a 15–25 mm spacer would recover at most about 0.5 K (estimate), below the 3D noise. Not worth the depth.
- Uneven flow across the core: uniformity 0.9/0.8/0.7 costs +0.06/+0.25/+0.6 K; the good layouts sit at 0.75–0.9.
- The explorer's 3D scoring now samples every flow scheme (layout family × radiator wall, direction and tilt × case-fan directions), not only the fast model's frontier.

## Still unverified

- Tilted radiator cores in 3D let air along their length (no fin blocking): tilted results may be flattered; an OpenFOAM check is needed.
- Layouts bound by the air over the board move 0.1–0.25 between grids; they need ~8 mm cells or finer.
- The fan-gap gain rests on gaps of about one cell; part of it may be the case being thicker.
- All literature coefficients above are from memory.
