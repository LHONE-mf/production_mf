import { expect, it } from 'vitest';
import type { CuttingIncoming } from '../../core/types';
import { estimateCuttingYield, prepareCuttingRun, readCuttingYield } from './cutMath';

const incoming:CuttingIncoming={id:'incoming',electrodeType:'strip',electrodeLengthMm:100,
  roll:{id:'roll',mixName:'Measured roll',sideALengthM:10,sideBLengthM:10,segLengthsM:[10],createdAt:1},createdAt:1};
const geometry={physicalLengthM:10,electrodeLengthMm:100,kerfMm:0};
it('uses one physical web length regardless of one-sided or two-sided coating',()=>{
  for(const sideBLengthM of [undefined,10,500]){
    const run=prepareCuttingRun({...incoming,roll:{...incoming.roll,sideBLengthM}},
      {goodCount:90,defectCount:10,geometry},'operator','run');
    expect(run.yieldCalculation).toMatchObject({expected:100,physicalLengthM:10,rows:100,columns:1,electrodeLengthSource:'incoming_spec'});
    expect(run.electrodeLengthMm).toBeUndefined(); // Specification is not a measured actual length.
  }
});
it('requires both plate dimensions and usable web width instead of assuming square plates',()=>{
  expect(estimateCuttingYield('prismatic',geometry)).toBeNull();
  expect(estimateCuttingYield('prismatic',{...geometry,electrodeWidthMm:50,usableWebWidthMm:120}))
    .toMatchObject({expected:200,rows:100,columns:2});
  expect(estimateCuttingYield('prismatic',{...geometry,electrodeWidthMm:25,usableWebWidthMm:120}))
    .toMatchObject({expected:400,columns:4});
});
it('includes explicit kerf in each pitch, preserves short valid zero estimates and guards overflow',()=>{
  expect(estimateCuttingYield('strip',{...geometry,kerfMm:1})?.expected).toBe(99);
  expect(estimateCuttingYield('strip',{...geometry,physicalLengthM:0.01})?.expected).toBe(0);
  expect(estimateCuttingYield('strip',{...geometry,physicalLengthM:Number.MAX_VALUE})).toBeNull();
  expect(estimateCuttingYield('strip',{...geometry,electrodeLengthMm:Number.MAX_VALUE,kerfMm:Number.MAX_VALUE})).toBeNull();
});
it.each([{physicalLengthM:0},{physicalLengthM:-1},{kerfMm:-1},{kerfMm:NaN},{electrodeLengthMm:Infinity}])('rejects invalid geometry %j',change=>{
  expect(estimateCuttingYield('strip',{...geometry,...change})).toBeNull();
});
it.each([{goodCount:1.5},{goodCount:-1},{goodCount:Infinity},{goodCount:Number.MAX_SAFE_INTEGER+1},
  {goodCount:undefined},{defectCount:undefined},{defectCount:-1},{defectCount:0.5},{breaks:0.5}])('rejects invalid actual counts %j',change=>{
  expect(()=>prepareCuttingRun(incoming,{goodCount:90,defectCount:10,...change},'operator','run')).toThrow();
});
it('allows counts without an estimate, all-reject work and an actual dimension override',()=>{
  const counts=prepareCuttingRun(incoming,{goodCount:0,defectCount:5},'operator','run');
  expect(counts.yieldCalculation).toBeUndefined();
  const actual=prepareCuttingRun(incoming,{goodCount:90,defectCount:10,electrodeLengthMm:200,geometry},'operator','run');
  expect(actual.yieldCalculation).toMatchObject({expected:50,electrodeLengthMm:200,electrodeLengthSource:'entered'});
  expect(actual.electrodeLengthMm).toBe(200);
  expect(()=>prepareCuttingRun(incoming,{goodCount:0,defectCount:0},'operator','run')).toThrow();
  expect(()=>prepareCuttingRun(incoming,{goodCount:1,defectCount:0,geometry:{...geometry,kerfMm:NaN}},'operator','run')).toThrow();
});

it('ignores malformed or inconsistent imported estimate metadata without inventing a result',()=>{
  const valid=estimateCuttingYield('strip',geometry)!;
  expect(readCuttingYield('strip',valid)).toMatchObject({expected:100});
  for(const value of [null,{},1,{...valid,expected:200},{...valid,rows:{}},
    {...valid,physicalLengthM:{value:10}},{...valid,electrodeWidthMm:{value:50}}])
    expect(readCuttingYield('strip',value)).toBeNull();
});
