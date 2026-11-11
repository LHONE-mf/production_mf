import { afterEach, beforeEach, expect, it } from 'vitest';
import { db } from '../../core/db';
import { prepareCoatingRun, saveCoatingRun, type CoatingEntry } from './coatingJournal';

const entry:CoatingEntry={foilType:'Al, measured 12 um',mode:'continuous',targetDryMgm2:20,
  coatingWidthCm:50,webSpeedMpm:8,headGapUm:180,pumpDeliveryCm3Rev:25,
  segLengthsM:[1.234567],ovenTempsC:[],
  mixSnapshot:{mixBatchId:'measured-mix',recipeName:'Measured slurry',pasteDensity:2,solidsPctMass:50,createdAt:1}};
beforeEach(async()=>{await db.open();});
afterEach(async()=>{db.close();await db.delete();});

it('retains reproducible inputs and calculated results after closing and reopening IndexedDB',async()=>{
  const run=await saveCoatingRun(entry,'operator','run');
  expect(run).toMatchObject({mixBatchId:'measured-mix',coatingWidthCm:50,pumpDeliveryCm3Rev:25,
    wetThicknessUm:200,headGapUm:180,estimatedFlowLpm:0.8,screwRpm:32,sideALengthM:1.234567,ovenTempsC:[]});
  db.close();await db.open();
  expect(await db.coatRuns.get('run')).toEqual(run);
  expect(await db.journal.get('run')).toMatchObject({workerId:'operator',params:{'Запись нанесения':'run'}});
});

it.each([
  {foilType:''},{targetDryMgm2:0},{coatingWidthCm:-1},{webSpeedMpm:Infinity},
  {segLengthsM:[1,-1]},{pumpDeliveryCm3Rev:0},{headGapUm:-1},{sideBLengthM:-1},
  {ovenTempsC:[120]},{ovenTempsC:[1,2,3,4,5,NaN]},
  {mode:'intermittent' as const,gapWidthMm:20,gapPitchMm:10},
  {mixSnapshot:{...entry.mixSnapshot!,solidsPctMass:101}},
])('rejects invalid entered data before writing: %j',async(change)=>{
  await expect(saveCoatingRun({...entry,...change},'operator','invalid')).rejects.toThrow();
  expect(await db.coatRuns.count()).toBe(0);expect(await db.journal.count()).toBe(0);
});

it('keeps estimates unavailable without measured slurry properties or pump calibration',()=>{
  const noMix=prepareCoatingRun({...entry,mixSnapshot:undefined},'operator','no-mix');
  expect(noMix.wetThicknessUm).toBeUndefined();expect(noMix.estimatedFlowLpm).toBeUndefined();
  expect(noMix.screwRpm).toBeUndefined();
  const noCalibration=prepareCoatingRun({...entry,pumpDeliveryCm3Rev:undefined},'operator','no-calibration');
  expect(noCalibration.estimatedFlowLpm).toBe(0.8);expect(noCalibration.screwRpm).toBeUndefined();
});

it('rolls back both stores after a journal failure and permits a safe retry of the same ID',async()=>{
  const fail=()=>{throw new Error('Test storage failure');};
  db.journal.hook('creating',fail);
  try{await expect(saveCoatingRun(entry,'operator','retry')).rejects.toThrow('Test storage failure');}
  finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(await db.coatRuns.count()).toBe(0);expect(await db.journal.count()).toBe(0);
  await saveCoatingRun(entry,'operator','retry');
  await expect(saveCoatingRun(entry,'operator','retry')).rejects.toThrow();
  expect(await db.coatRuns.count()).toBe(1);expect(await db.journal.count()).toBe(1);
});
