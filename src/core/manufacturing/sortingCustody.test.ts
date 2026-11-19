import {afterEach,beforeEach,it,expect} from 'vitest';
import {db} from '../db';
import {UserRole,type SortSpec} from '../types';
import {cuttingOutputTestData} from '../sync/cuttingOutputTestFixture';
import {copyCutOutputHandoffRead} from '../sync/cuttingOutputTypes';
import {prepareReceivedCuttingSource,saveReceivedCuttingSource} from './sortingCustody';
import {startSortingWorkflow,recordSortingStation,completeSortingWorkflow} from './sortingWorkflow';
import {sourceFromSortRun} from '../sync/inventoryOutputTypes';
import {takeAssemblySource} from './assemblyIntake';

const id=()=>crypto.randomUUID();
const scope={serverUrl:'https://factory.test',organizationId:id(),actorId:id(),deviceId:id()};
const actor='local-sorting-inspector';
const received=()=>{
 const f=cuttingOutputTestData(scope);
 if(f.receipt.kind!=='receipt')throw Error('expected receive');
 const receipt={...f.receipt.request,sourceSnapshot:f.handoff,actorId:scope.actorId,
  recordedAt:new Date().toISOString(),custodyEffect:'received',unit:'pieces',warehouseEffect:'none'};
 return copyCutOutputHandoffRead({operationId:f.handoff.operationId,handoff:f.handoff,
  eligible:true,received:receipt,eventCount:1});
};
beforeEach(async()=>{
 await db.open();
 await db.users.put({id:actor,login:actor,fullName:'TEST inspector',password:'test',
  role:UserRole.WORKER,isActive:true,createdAt:new Date()});
});
afterEach(async()=>{db.close();await db.delete();});

it('imports an exact acknowledged partial physical receipt, never an invented local Cutting yield',async()=>{
 const h=received();
 const candidate=prepareReceivedCuttingSource(h,scope,actor,'strip');
 expect(candidate).toMatchObject({incomingId:h.handoff.sourceSnapshot.lot.label,goodCount:4,
  defectCount:null,receivedCustody:{receiptId:h.received!.operationId,count:4}});
 const saved=await saveReceivedCuttingSource(h,scope,actor,'strip');
 expect(await saveReceivedCuttingSource(h,scope,actor,'strip')).toEqual(saved);
 db.close();await db.open();
 expect(await db.cuttingRuns.get(saved.id)).toEqual(saved);
 await expect(saveReceivedCuttingSource(h,scope,actor,'prismatic')).rejects.toThrow(/закреплена/i);
 expect((await db.cuttingRuns.get(saved.id))?.electrodeType).toBe('strip');
});

it('does not accept unconfirmed, held, mismatched or another receiver receipt',async()=>{
 const h=received();
 for(const malformed of [
  {...h,received:null,eventCount:0},
  {...h,eligible:false},
  {...h,received:{...h.received!,actorId:id()}},
 ])expect(()=>prepareReceivedCuttingSource(malformed as typeof h,scope,actor,'strip')).toThrow();
 expect(()=>prepareReceivedCuttingSource(h,{...scope,actorId:id()},actor,'strip')).toThrow();
 expect(()=>prepareReceivedCuttingSource(h,scope,actor,'' as never)).toThrow();
 expect(await db.cuttingRuns.count()).toBe(0);
});

it('binds Visual, Thickness and Mass to exactly the received count while blocking unauthorized warehouse/assembly claims',async()=>{
 const h=received();
 const source=await saveReceivedCuttingSource(h,scope,actor,'strip');
 const spec:SortSpec={id:id(),cutRunId:source.id,batchName:source.incomingId,
  electrodeType:'strip',parameterName:'Actual three-station test',unit:'g',authorId:'tech',
  categories:[{name:'A',criteria:'Mass',minMass:1,maxMass:2}],createdAt:1,updatedAt:1};
 await db.sortSpecs.add(spec);
 await expect(startSortingWorkflow(source,spec,'pass-fail','different-actor')).rejects.toThrow();
 const w=await startSortingWorkflow(source,spec,'pass-fail',actor);
 await recordSortingStation(w.id,{station:'visual',passedCount:3,rejectedCount:1,workerId:actor});
 await recordSortingStation(w.id,{station:'thickness',passedCount:2,rejectedCount:1,workerId:actor});
 await recordSortingStation(w.id,{station:'mass',passedCount:2,rejectedCount:0,workerId:actor});
 const final=await completeSortingWorkflow(w.id,id());
 expect(final).toMatchObject({goodCount:4,rejected:2,buckets:[{categoryName:'PASS',count:2}]});
 expect(()=>sourceFromSortRun(final)).toThrow(/QA|сервер/i);
 await expect(takeAssemblySource(final,actor,id())).rejects.toThrow(/подтвержд/i);
 expect(await db.assemblyRuns.count()).toBe(0);
});

it('stops a new station if the previously received source is changed',async()=>{
 const source=await saveReceivedCuttingSource(received(),scope,actor,'strip');
 const spec:SortSpec={id:id(),cutRunId:source.id,batchName:source.incomingId,
  electrodeType:'strip',parameterName:'Thickness',unit:'um',authorId:'tech',
  categories:[{name:'PASS',criteria:'Spec'}],createdAt:1,updatedAt:1};
 await db.sortSpecs.add(spec);
 const w=await startSortingWorkflow(source,spec,'pass-fail',actor);
 await db.cuttingRuns.update(source.id,{goodCount:5});
 await expect(recordSortingStation(w.id,{station:'visual',passedCount:4,rejectedCount:0,workerId:actor})).rejects.toThrow();
 expect((await db.sortingWorkflows.get(w.id))?.stages).toHaveLength(0);
});
