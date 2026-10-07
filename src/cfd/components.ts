import type { DesignConfig } from '../model/types';
import type { ComponentResult } from '../solver/airflow';
import type { Design } from '../solver/evaluate';
import type { FlowStats } from './solver';

export interface CfdThermal {
  components: ComponentResult[];
  worstMargin: number;
  worstHeadroomK: number;
  worstComponent: string;
}

/**
 * Component temperatures from a 3D simulation, by the same rules as the airflow model: each
 * component sits at room temperature + the simulated air around it (or its coolant) + its own
 * rise (power × thermal resistance, as in the design's airflow model).
 *
 *   'inlet'   flow-weighted air entering the heat source
 *   'mean'    mean air in the heat source (fins, card)
 *   'exit'    inlet + 2·(mean − inlet)
 *   'coolant' the simulated coolant (radiator cores exchange heat at the local air speed), else
 *             inlet + 2·(mean − inlet) / radiator effectiveness
 *   'zone'    air over the board (the board heat source's mean), else the case average
 */
export function cfdComponents(design: Design, cfg: DesignConfig, st: FlowStats): CfdThermal {
  const amb = cfg.prefs.ambientC;
  const eff = Math.max(0.05, cfg.advanced.radEffectiveness);
  const board = st.sources.find((s) => s.id === 'board');
  const zoneRise = board ? board.meanRise : st.caseRise;
  const out: ComponentResult[] = design.flow.components.map((c) => {
    const src = st.sources.find((s) => s.id === c.via);
    const through = src ? 2 * Math.max(0, src.meanRise - src.inletRise) : 0;
    const air =
      !src || c.air === 'zone'
        ? zoneRise
        : c.air === 'inlet'
          ? src.inletRise
          : c.air === 'mean'
            ? src.meanRise
            : c.air === 'exit'
              ? src.inletRise + through
              : src.coolantRise !== undefined
              ? src.coolantRise
              : src.inletRise + through / eff;
    const tempC = amb + air + c.selfRiseK;
    return { ...c, tempC, headroomK: c.limitC - tempC, margin: (c.limitC - tempC) / Math.max(1, c.limitC - amb) };
  });
  let worst = out[0];
  for (const c of out) if (c.margin < worst.margin) worst = c;
  return { components: out, worstMargin: worst?.margin ?? 1, worstHeadroomK: worst?.headroomK ?? 99, worstComponent: worst?.label ?? '' };
}
