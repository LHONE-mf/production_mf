import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import {StageId,type CutRun,type SortSpec,type SortingWorkflow,type SyncPacket} from '../types';
import {setWorkshopKey,signPacket} from '../security';
import {applyPacket} from '../../transfer/apply';
import {decodePacket,encodePacket} from '../../transfer/packet';
import {receiveSortingHandoff} from './sortingHandoff';
import {startSortingWorkflow,recordSortingStation} from './sortingWorkflow';

const cut:CutRun={id:'cut-handoff',incomingId:'coil-1',electrodeType:'strip',
  goodCount:12,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec:SortSpec={id:'spec-handoff',cutRunId:cut.id,batchName:cut.incomingId,
  electrodeType:'strip',parameterName:'Mass',unit:'g',categories:[
    {name:'A',criteria:'Operator decision',minMass:1,maxMass:2},
    {name:'B',criteria:'Operator decision',minMass:2,maxMass:3},
  ],authorId:'technologist',createdAt:1,updatedAt:1};

beforeEach(async()=>{
  await db.open();
  await db.cuttingRuns.put(cut);
  await db.sortSpecs.put(spec);
  setWorkshopKey('TEST-only-local-workshop-key');
});
afterEach(async()=>{db.close();await db.delete();localStorage.clear();});

async function sample():Promise<{visual:SortingWorkflow;thickness:SortingWorkflow}>{
  const started=await startSortingWorkflow(cut,spec,'grading','shift-lead');
  const visual=await recordSortingStation(started.id,{station:'visual',passedCount:11,
    rejectedCount:1,workerId:'visual-operator',rejectionReasons:[{reason:'surface',count:1}]});
  const thickness=await recordSortingStation(started.id,{station:'thickness',passedCount:9,
    rejectedCount:2,workerId:'thickness-operator'});
  return {visual,thickness};
}
function handoff(payload:unknown):SyncPacket{
  return {v:1,type:'sort-handoff',stage:StageId.SORTING,payload,from:'visual-operator',ts:Date.now()};
}

it('receives immutable sequential station prefixes using the existing signed QR packet',async()=>{
  const {visual,thickness}=await sample();
  // Different physical device: records and approved reference data are preloaded.
  await db.sortingWorkflows.clear();
  const qr=decodePacket(await encodePacket(handoff(visual)))!;
  expect(qr.type).toBe('sort-handoff');
  expect(qr.stage).toBe(StageId.SORTING);
  const first=await applyPacket(qr);
  expect(first.ok).toBe(true);
  expect((await db.sortingWorkflows.get(cut.id))?.stages).toHaveLength(1);
  expect((await applyPacket(qr)).ok).toBe(true);
  expect((await db.sortingWorkflows.get(cut.id))?.stages).toEqual(visual.stages);

  const second=await applyPacket(decodePacket(await encodePacket(handoff(thickness)))!);
  expect(second.ok).toBe(true);
  expect((await db.sortingWorkflows.get(cut.id))?.stages).toEqual(thickness.stages);
  expect((await applyPacket(qr)).ok).toBe(true); // stale retry may not roll back
  expect((await db.sortingWorkflows.get(cut.id))?.stages).toHaveLength(2);

  await recordSortingStation(cut.id,{station:'mass',passedCount:8,rejectedCount:1,
    workerId:'mass-operator',grades:[{categoryName:'A',count:5},{categoryName:'B',count:3}]});
  expect((await db.sortingWorkflows.get(cut.id))?.stages.map(s=>s.inputCount)).toEqual([12,11,9]);
  expect(await db.sortRuns.count()).toBe(0); // no silent final report
});

it('never replaces a divergent local inspection or a finished local history',async()=>{
  const {visual,thickness}=await sample();
  const mismatched={...visual,stages:[{...visual.stages[0],passedCount:10,rejectedCount:2}]};
  await expect(receiveSortingHandoff(mismatched)).rejects.toThrow();
  const changedMode={...visual,mode:'pass-fail' as const};
  await expect(receiveSortingHandoff(changedMode)).rejects.toThrow();
  expect(await receiveSortingHandoff(visual)).toEqual(thickness); // stale prefix
  expect((await db.sortingWorkflows.get(cut.id))?.stages).toEqual(thickness.stages);
});

it('requires local approved KD and local Cutting history; no catalogs are installed by HMAC',async()=>{
  const {visual}=await sample();
  await db.sortingWorkflows.delete(cut.id);
  await db.sortSpecs.delete(spec.id);
  await expect(receiveSortingHandoff(visual)).rejects.toThrow(/КД/);
  expect(await db.sortingWorkflows.count()).toBe(0);
  expect(await db.sortSpecs.count()).toBe(0);
  await db.sortSpecs.put({...spec,updatedAt:2});
  await expect(receiveSortingHandoff(visual)).rejects.toThrow(/КД/);
  await db.sortSpecs.put(spec);
  await db.cuttingRuns.update(cut.id,{goodCount:13});
  await expect(receiveSortingHandoff(visual)).rejects.toThrow(/КД/);
  expect(await db.sortingWorkflows.count()).toBe(0);
});

it('rejects missing, premature, finalized, and wrong-stage handoffs without mutation',async()=>{
  const {visual}=await sample();
  await db.sortingWorkflows.clear();
  const mass=await recordSortingStation(cut.id,{station:'mass',passedCount:8,rejectedCount:1,
    workerId:'mass-operator',grades:[{categoryName:'A',count:5},{categoryName:'B',count:3}]});
  for(const value of [null,{}, {...visual,stages:[]}, mass,
    {...visual,finalizedSortRunId:'final-1'},
    {...visual,stages:[{...visual.stages[0],station:'thickness'}]}]){
    await expect(receiveSortingHandoff(value)).rejects.toThrow();
  }
  expect((await applyPacket({...handoff(visual),stage:StageId.CUTTING,sig:await signPacket({...handoff(visual),stage:StageId.CUTTING})})).ok).toBe(false);
  const forced={...handoff(visual),forced:true};
  expect((await applyPacket({...forced,sig:await signPacket(forced)})).ok).toBe(false);
  expect(await db.sortingWorkflows.count()).toBe(0);
});

it('does not import stations over an existing legacy finalized SortRun',async()=>{
  const {visual}=await sample();
  await db.sortingWorkflows.clear();
  await db.sortRuns.add({id:'old-summary',cutRunId:cut.id,cutRunSnapshot:cut,specSnapshot:spec,
    specId:spec.id,batchName:cut.incomingId,goodCount:12,
    buckets:[{categoryName:'A',count:12}],rejected:0,workerId:'operator',createdAt:1,updatedAt:1});
  await expect(receiveSortingHandoff(visual)).rejects.toThrow(/итог/);
  expect(await db.sortingWorkflows.count()).toBe(0);
  await db.sortRuns.delete('old-summary');
});
