import { describe,expect,it } from 'vitest';
import { headGapUm,requiredScrewFlowLpm,screwRpmFromFlow,wetThicknessUm,intermittentCoverage } from './coatMath';

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

describe('coating coverage requires physical lengths and an explicit gap pattern',()=>{
  it('rejects missing, negative, nonfinite or incomplete geometry',()=>{
    for(const lengths of [[],[0],[-1],[NaN],[Infinity],[1,-1]])expect(intermittentCoverage(lengths)).toBeNull();
    for(const [width,pitch] of [[0,100],[-1,100],[100,100],[101,100],[1,0],[1,Infinity]])
      expect(intermittentCoverage([1],width,pitch)).toBeNull();
    expect(intermittentCoverage([1],10)).toBeNull();
  });
  it('assumes a gap starts each segment and preserves fractional lengths',()=>{
    expect(intermittentCoverage([1,0.05],10,100)).toMatchObject({totalM:1.05});
    expect(intermittentCoverage([1,0.05],10,100)?.coatedM).toBeCloseTo(0.94,10);
    expect(intermittentCoverage([1.234567])?.coatedM).toBe(1.234567);
  });
});

it('retains small positive flow estimates and rejects overflow rather than displaying fabricated zero or infinity',()=>{
  expect(requiredScrewFlowLpm(1,1,1)).toBeCloseTo(0.00001,12);
  expect(requiredScrewFlowLpm(Number.MAX_VALUE,Number.MAX_VALUE,8)).toBeNull();
  expect(wetThicknessUm(Number.MAX_VALUE,0.01,1)).toBeNull();
});
