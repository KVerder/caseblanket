/**
 * The model's uncertainty, as numbers, from its own checks (tests/cfd-calibration.test.ts,
 * tests/cfd.test.ts). Shown next to every reported gain.
 *
 *   Airflow through a part: the 3D sim matches the fan-curve model within 2 % on calibration ducts,
 *   and three grid levels (6 / 8.5 / 12 mm) spread by 1.1 % → ±5 % on airflow.
 *   Structure gains: the exhaust-deflector gain drops from 5.6 K to 2.6 K when the cells are halved
 *   (it keeps its sign) → a gain is uncertain by about ±55 % of itself.
 *   Neither is checked against reality: that needs the OpenFOAM reference or prototype measurements.
 */
export const FLOW_UNCERTAINTY = 0.05;
export const GAIN_RELATIVE_UNCERTAINTY = 0.55;

/** "3.2 K ± 1.8 K" for a structure gain. */
export function gainWithUncertainty(gainK: number): string {
  const u = Math.abs(gainK) * GAIN_RELATIVE_UNCERTAINTY;
  return `${gainK >= 0 ? '+' : '−'}${Math.abs(gainK).toFixed(1)} K ± ${u.toFixed(1)} K`;
}
