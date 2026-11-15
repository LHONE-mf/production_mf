import type { RollSpec } from '../../core/types';

/** Legacy thickness fields can contain wet estimates. Only an attributed,
 * explicitly dry total-electrode measurement is comparable with the new target. */
export function measuredDryThicknessUm(roll:RollSpec):number|null {
  const measurement=roll.thicknessBeforeMeasurement;
  if(!measurement||measurement.basis!=='dry-electrode-including-foil'||
    typeof measurement.recordedBy!=='string'||!measurement.recordedBy.trim()||
    !Number.isFinite(measurement.recordedAt)||measurement.recordedAt<=0||
    !Number.isFinite(new Date(measurement.recordedAt).getTime())||
    typeof roll.thicknessBeforeUm!=='number'||!Number.isFinite(roll.thicknessBeforeUm)||roll.thicknessBeforeUm<=0)return null;
  return roll.thicknessBeforeUm;
}

/** Comparison with an entered target, not measured compression or porosity. */
export function plannedThicknessReductionPct(roll:RollSpec,targetUm:number):number|null {
  const before=measuredDryThicknessUm(roll);
  if(before===null||!Number.isFinite(targetUm)||targetUm<=0||targetUm>before)return null;
  return Math.round((before-targetUm)/before*1000)/10;
}
