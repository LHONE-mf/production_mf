import { expect, it } from 'vitest';
import type { RollSpec } from '../../core/types';
import { measuredDryThicknessUm, plannedThicknessReductionPct } from './rollThickness';

const roll:RollSpec={id:'measured',mixName:'Measured roll',segLengthsM:[10],createdAt:1,thicknessBeforeUm:100,
  thicknessBeforeMeasurement:{basis:'dry-electrode-including-foil',recordedBy:'operator',recordedAt:1}};
it('compares the same total dry-electrode basis and distinguishes the target from actual compression',()=>{
  expect(measuredDryThicknessUm(roll)).toBe(100);
  expect(plannedThicknessReductionPct(roll,80)).toBe(20);
  expect(plannedThicknessReductionPct(roll,100)).toBe(0);
  for(const target of [0,-1,101,NaN,Infinity])expect(plannedThicknessReductionPct(roll,target)).toBeNull();
});
it('does not treat unmarked legacy values or malformed provenance as measurements',()=>{
  for(const value of [undefined,null,{}, {basis:'wet-film',recordedBy:'operator',recordedAt:1},
    {...roll.thicknessBeforeMeasurement,recordedBy:''}, {...roll.thicknessBeforeMeasurement,recordedAt:Infinity},
    {...roll.thicknessBeforeMeasurement,recordedAt:Number.MAX_VALUE}]){
    const candidate={...roll,thicknessBeforeMeasurement:value} as RollSpec;
    expect(measuredDryThicknessUm(candidate)).toBeNull();
    expect(plannedThicknessReductionPct(candidate,80)).toBeNull();
  }
  for(const thickness of [undefined,0,-1,NaN,Infinity])
    expect(measuredDryThicknessUm({...roll,thicknessBeforeUm:thickness})).toBeNull();
});
