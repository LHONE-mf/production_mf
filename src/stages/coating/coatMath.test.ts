import { describe,expect,it } from 'vitest';
import { headGapUm,requiredScrewFlowLpm,screwRpmFromFlow,wetThicknessUm } from './coatMath';

describe('coating mass-balance and units',()=>{
  it('uses dry solids MASS fraction with paste density, not volume fraction',()=>{
    expect(wetThicknessUm(25,1.5,50)).toBe(333.3);
    expect(wetThicknessUm(20,2,50)).toBe(200);
    expect(wetThicknessUm(20,2,100)).toBe(100);
  });
  it('returns no estimate when inputs are incomplete or unphysical',()=>{
    for(const n of [0,-1,101,NaN,Infinity])expect(wetThicknessUm(20,1.5,n)).toBeNull();
    for(const n of [0,-1,NaN,Infinity]){
      expect(wetThicknessUm(n,1.5,50)).toBeNull();
      expect(wetThicknessUm(20,n,50)).toBeNull();
      expect(requiredScrewFlowLpm(n,200,8)).toBeNull();
    }
  });
  it('checks volumetric flow and film thickness by dimensional equivalence',()=>{
    // 50 cm * 200 um * 8 m/min = 800 cm3/min.
    expect(requiredScrewFlowLpm(50,200,8)).toBe(0.8);
    expect(headGapUm(800,50,8)).toBe(200);
  });
  it('requires explicit calibrated pump capacity for RPM',()=>{
    expect(screwRpmFromFlow(0.8)).toBeNull();
    expect(screwRpmFromFlow(0.8,0)).toBeNull();
    expect(screwRpmFromFlow(0.8,Infinity)).toBeNull();
    expect(screwRpmFromFlow(0.8,-2)).toBeNull();
    expect(screwRpmFromFlow(0.8,25)).toBe(32);
  });
});
