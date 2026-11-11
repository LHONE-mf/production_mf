import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {StageId,UserRole,type AssemblyRun,type FillRun,type WalzingIncoming,type WalzRun} from '../types';
import {prepareFillingHandover,acceptFillingHandover} from './fillingHandover';
import {saveFillingResult,FILLING_UNITS} from './fillingResults';
import {prepareWalzingHandover,receiveWalzingIncoming,saveWalzingResult,receiveWalzingResult,WALZING_UNITS,validateWalzingResult} from './walzingResults';
import {applyPacket} from '../../transfer/apply';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let fill:FillRun,incoming:WalzingIncoming,run:WalzRun;
beforeEach(async()=>{
 await db.open();await db.users.bulkAdd([{id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);
 const source:AssemblyRun={id:'job',batchName:'Filling source',cellType:'unassigned',ops:[{id:'cells',source:{kind:'declared',reference:'counted cells'},substation:'crimp-cyl',workerId:'worker',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]}],sourceLedger:1,operationLedger:1,cellsOut:0,cellsScrap:0,defects:[],workerId:'worker',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T13:00:00Z',cellOutput:{id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'FILL-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Count basis'}};
 await db.assemblyRuns.add(source);
 const pending=await prepareFillingHandover(source,'floor7-room5','master','instruction');const receipt=await acceptFillingHandover(pending,'floor7-room5','worker',4,'Count checked','receipt');const now=new Date().toISOString();
 fill={id:'fill',resultVersion:1,sourceReceipt:receipt,box:'floor7-room5',batchName:source.batchName,serialRange:receipt.serialRange,cellType:receipt.cellType,cellsIn:4,cellsFilled:4,cellsScrap:0,cellsUnknown:0,electrolyteName:'Electrolyte',doseActual:2,vacuumKpa:0,pressureKpa:10,dwellMin:3,temperatureC:20,humidityPpm:0,measurementUnits:FILLING_UNITS,measurementBasis:'Dose per cell; vacuum depth and gauge injection pressure; room environment',defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:now,updatedAt:now};await saveFillingResult(fill,'worker');
 incoming=await prepareWalzingHandover(fill,'worker');
 const recordedAt=new Date().toISOString();run={id:'walz',sourceLedger:1,inputSnapshot:incoming,batchName:incoming.batchName,serialRange:incoming.serialRange,cellsIn:4,cellsOut:4,cellsScrap:0,cellsUnknown:0,incomingDiameter:21,finalDiameter:20.9,passes:1,pressureKgf:5,speedRpm:10,temperatureC:20,measurementUnits:WALZING_UNITS,machineNo:'Observed machine',defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:recordedAt,updatedAt:recordedAt};
});
afterEach(async()=>{db.close();await db.delete();});
it('persists a pending full-source cylindrical 705 instruction before export, with stable retry and reopen',async()=>{
 expect(incoming.sourceFill).toEqual(fill);expect(incoming.destination).toBe(StageId.WALZING);expect(incoming.receivedAt).toBeUndefined();expect(await prepareWalzingHandover(fill,'worker')).toEqual(incoming);
 db.close();await db.open();expect(await db.walzingIncoming.get(incoming.id)).toEqual(incoming);
 await expect(prepareWalzingHandover({...fill,box:'dry-room'},'worker')).rejects.toThrow();
 await expect(prepareWalzingHandover({...fill,cellsFilled:3,cellsScrap:1},'worker')).rejects.toThrow();
});
it('rolls the saved instruction and its journal back together, and preserves unrelated serial history',async()=>{
 await db.walzingIncoming.delete(incoming.id);await db.journal.delete(`walzing-in:${incoming.id}`);
 const fail=()=>{throw Error('Instruction journal failed');};db.journal.hook('creating',fail);
 try{await expect(prepareWalzingHandover(fill,'worker')).rejects.toThrow('Instruction journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.walzingIncoming.get(incoming.id)).toBeUndefined();incoming=await prepareWalzingHandover(fill,'worker');run.inputSnapshot=incoming;run.createdAt=new Date().toISOString();run.updatedAt=run.createdAt;
 await db.formationIncoming.add({id:'collision',batchName:'Other serial claim',sourceBox:'dry-room',cellsIn:4,serialRange:run.serialRange,receivedAt:run.createdAt,updatedAt:run.createdAt});
 await expect(saveWalzingResult(run,'worker')).rejects.toThrow();expect(await db.formationIncoming.get('collision')).toBeDefined();
});
it('requires exact saved input and active actor; validates whole full-source partition and optional measured units',async()=>{
 for(const changed of [{cellsIn:3},{cellsOut:3.5,cellsScrap:.5},{cellsOut:3},{cellsUnknown:undefined},{passes:1.5},{pressureKgf:-1},{incomingDiameter:0},{temperatureC:-274},{speedRpm:Infinity},{machineNo:' '},{measurementUnits:{...WALZING_UNITS,diameter:'cm'}},{inputSnapshot:{...incoming,cellsIn:3}}])expect(()=>validateWalzingResult({...run,...changed} as WalzRun)).toThrow();
 await db.walzingIncoming.put({...incoming,updatedAt:'2099-01-01'});await expect(saveWalzingResult(run,'worker')).rejects.toThrow();await db.walzingIncoming.put(incoming);
 await db.users.update('worker',{isActive:false});await expect(saveWalzingResult(run,'worker')).rejects.toThrow();await db.users.update('worker',{isActive:true});
 expect(()=>validateWalzingResult({...run,cellsOut:2,cellsScrap:1,cellsUnknown:1})).not.toThrow();
 expect(()=>validateWalzingResult({...run,incomingDiameter:undefined,finalDiameter:undefined,passes:undefined,pressureKgf:undefined,speedRpm:undefined,temperatureC:undefined})).not.toThrow();
});
it('serializes competing allocations, atomically rolls result/journal back, and resumes exact retry after reopen',async()=>{
 const fail=()=>{throw Error('Walzing journal failed');};db.journal.hook('creating',fail);
 try{await expect(saveWalzingResult(run,'worker')).rejects.toThrow('Walzing journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.walzRuns.count()).toBe(0);expect(await db.journal.get(run.id)).toBeUndefined();
 const results=await Promise.allSettled([saveWalzingResult(run,'worker'),saveWalzingResult({...run,id:'duplicate'},'worker')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.walzRuns.count()).toBe(1);
 db.close();await db.open();expect(await saveWalzingResult(run,'worker')).toEqual(run);expect((await db.journal.get(run.id))?.params?.['Снимок результата']).toBe(JSON.stringify(run));
});
it('guards typed and generic forced packet paths against wrong destinations, overwritten sources, stripping and replay',async()=>{
 const packet=(type:'walzing-in'|'walz-run'|'forced-push',payload:unknown)=>({v:1 as const,type,stage:StageId.WALZING,payload,from:'master',role:UserRole.MASTER,forced:true,ts:Date.now()});
 expect((await applyPacket(packet('walzing-in',incoming))).ok).toBe(true);
 for(const type of ['walzing-in','forced-push'] as const)expect((await applyPacket(packet(type,{...incoming,cellsIn:3}))).ok).toBe(false);
 await saveWalzingResult(run,'worker');
 for(const type of ['walz-run','forced-push'] as const)for(const payload of [{...run,cellsOut:3,cellsScrap:1},{...run,inputSnapshot:undefined,sourceLedger:undefined},{...run,id:'bypass',inputSnapshot:undefined,sourceLedger:undefined}])expect((await applyPacket(packet(type,payload))).ok).toBe(false);
 expect(await receiveWalzingResult(run,UserRole.MASTER,'master')).toEqual(run);expect(await receiveWalzingIncoming(incoming,StageId.WALZING,UserRole.MASTER,'master')).toEqual(incoming);
 expect((await applyPacket({...packet('walzing-in',incoming),stage:StageId.FORMATION})).ok).toBe(false);expect(await db.tasks.get('bypass')).toBeUndefined();
});
it('preserves legacy results and permits validated legacy work without bypassing a protected source',async()=>{
 const legacy:WalzRun={id:'legacy',batchName:'Historical work',cellsIn:2,cellsOut:1,cellsScrap:1,defects:[],workerId:'worker',createdAt:run.createdAt,updatedAt:run.createdAt};
 expect(await saveWalzingResult(legacy,'worker')).toEqual(legacy);await expect(saveWalzingResult({...legacy,cellsIn:0},'worker')).rejects.toThrow();
 await expect(saveWalzingResult({...legacy,id:'bypass',batchName:run.batchName},'worker')).rejects.toThrow();expect(await db.walzRuns.get(legacy.id)).toEqual(legacy);
});
