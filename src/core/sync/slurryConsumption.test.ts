import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '../db';
import {inventoryOutbox,inventoryScopeKey} from './inventoryOutbox';
import {buildSlurryConsumption,freezeSlurryConsumption,sendSlurryConsumption,slurryConsumptionProposals} from './slurryConsumption';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryIssueContext} from './inventoryIssueClient';
import {UserRole,type MixBatch} from '../types';
import {SLURRY_UNITS} from '../manufacturing/slurryBatch';
import {SLURRY_BASIS,slurryMassBalance} from '../manufacturing/slurryMath';
vi.mock('./inventoryClient',()=>({inventoryRequest:vi.fn()}));
vi.mock('./inventoryIssueClient',()=>({loadInventoryIssueContext:vi.fn()}));
const id=()=>crypto.randomUUID();
const scope={serverUrl:'https://factory.test',organizationId:id(),actorId:id(),deviceId:id()};
const epoch=id(),actor='local-slurry-worker';
const components=[{id:'binder',name:'Binder',kind:'binder' as const,updatedAt:1,solidsMassFraction:1}];
const weighings=[{componentId:'binder',plannedG:9999,actualG:4.7}];
const batch:MixBatch={id:id(),measurementVersion:1,batchCode:'ACTUAL',recipeName:'Measured binder',workerId:actor,recordedRole:UserRole.WORKER,createdAt:1000,updatedAt:1000,measurementNote:'Scale record',weighings,componentSnapshots:components,batchKg:9.999,recipePlan:{basis:SLURRY_BASIS,lines:[{componentId:'binder',pct:100}]},measurementUnits:SLURRY_UNITS,massBalance:slurryMassBalance(weighings,components)};
const allocations=[{operationId:id(),issueId:id(),materialId:id(),componentId:'binder',quantity:4700,expectedSettlementRevision:1}];
beforeEach(async()=>{
 await db.delete();await db.open();await inventoryOutbox.delete();await inventoryOutbox.open();
 await db.users.put({id:actor,isActive:true,role:UserRole.WORKER} as never);await db.mixBatches.put(batch);
 vi.mocked(loadInventoryIssueContext).mockResolvedValue({...scope,epoch,postingEnabled:true,warehouseLevel:null});
 vi.mocked(inventoryRequest).mockReset();
});
describe('durable actual Slurry proposal',()=>{
 it('uses actual grams, never planned mass, and rejects incomplete/rounded quantities',()=>{
  const r=buildSlurryConsumption(batch,{operationId:id(),deviceId:scope.deviceId,productionBatchId:id(),stepNumber:1,allocations,reason:'Actual scale',evidence:'Lot mapped'});
  expect(r.source.components[0].actualMg).toBe(4700);
  expect(()=>buildSlurryConsumption(batch,{...r,allocations:[{...allocations[0],quantity:4699}]})).toThrow();
 });
 it('retains original body through reopen, lost reply and identical retry without stock writes',async()=>{
  const r=buildSlurryConsumption(batch,{operationId:id(),deviceId:scope.deviceId,productionBatchId:id(),stepNumber:1,allocations,reason:'Actual scale',evidence:'Lot mapped'});
  const row=await freezeSlurryConsumption(scope,actor,epoch,batch,r);
  expect(inventoryRequest).not.toHaveBeenCalled();await inventoryOutbox.close();await inventoryOutbox.open();
  const acknowledgement={...r,room:'slurry',actorId:scope.actorId,warehouseEffect:'none',recordedAt:new Date().toISOString()};
  vi.mocked(inventoryRequest).mockRejectedValueOnce(Error('Committed reply lost')).mockResolvedValue(new Response(JSON.stringify({status:'duplicate',operationId:r.operationId,consumption:JSON.parse(JSON.stringify(acknowledgement,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v))}),{status:200}));
  await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow('lost');
  await sendSlurryConsumption({} as never,scope,actor,row.key);
  expect(vi.mocked(inventoryRequest).mock.calls.map(c=>c[3]?.body)).toEqual([JSON.stringify(r),JSON.stringify(r)]);
  expect((await slurryConsumptionProposals(scope,actor))[0].fields.state).toBe('accepted');
  expect(await inventoryOutbox.stocks.count()).toBe(0);
  expect(inventoryScopeKey(scope)).toBeTruthy();
 });
 it('retains conflicts and prevents changed source, old epoch, account adoption and false ACK',async()=>{
  const r=buildSlurryConsumption(batch,{operationId:id(),deviceId:scope.deviceId,productionBatchId:id(),stepNumber:1,allocations,reason:'Actual scale',evidence:'Lot mapped'});
  const row=await freezeSlurryConsumption(scope,actor,epoch,batch,r);
  vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({...scope,epoch:id(),postingEnabled:true,warehouseLevel:null});
  await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow('История');
  expect(inventoryRequest).not.toHaveBeenCalled();
  await db.mixBatches.put({...batch,measurementNote:'Changed evidence'});
  await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow('изменён');
  await db.mixBatches.put(batch);
  await expect(freezeSlurryConsumption({...scope,actorId:id()},actor,epoch,batch,{...r,operationId:id()})).rejects.toThrow();
  vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({status:'confirmed',operationId:r.operationId,consumption:{}}),{status:201}));
  await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow();
  expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('pending');
  vi.mocked(inventoryRequest).mockResolvedValue(new Response('{}',{status:409}));
  await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow();
  expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('conflict');
 });
 it('keeps the original pending proposal when ACK storage rolls back and rejects a late ACK over a conflict',async()=>{
  const r=buildSlurryConsumption(batch,{operationId:id(),deviceId:scope.deviceId,productionBatchId:id(),stepNumber:1,allocations,reason:'Actual scale',evidence:'Lot mapped'}),row=await freezeSlurryConsumption(scope,actor,epoch,batch,r);
  const ack={status:'duplicate',operationId:r.operationId,consumption:{...r,room:'slurry',actorId:scope.actorId,warehouseEffect:'none',recordedAt:new Date().toISOString()}};
  vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(ack),{status:200}));
  const fail=()=>{throw Error('ACK storage failed');};inventoryOutbox.receivingDrafts.hook('updating',fail);
  try{await expect(sendSlurryConsumption({} as never,scope,actor,row.key)).rejects.toThrow('ACK storage failed');}finally{inventoryOutbox.receivingDrafts.hook('updating').unsubscribe(fail);}
  expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.request).toBe(JSON.stringify(r));
  let finish!:(r:Response)=>void;vi.mocked(inventoryRequest).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const sending=sendSlurryConsumption({} as never,scope,actor,row.key);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await inventoryOutbox.receivingDrafts.put({...row,revision:row.revision+1,fields:{...row.fields,state:'conflict'}});
  finish(new Response(JSON.stringify(ack),{status:200}));await expect(sending).rejects.toThrow('изменилось');
  expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('conflict');
 });
});
