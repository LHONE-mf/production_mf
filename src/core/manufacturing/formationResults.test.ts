import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {StageId,UserRole,type AssemblyRun,type FillRun,type WalzRun,type FormationIncoming,type FormationRun} from '../types';
import {prepareFillingHandover,acceptFillingHandover} from './fillingHandover';
import {saveFillingResult,FILLING_UNITS} from './fillingResults';
import {prepareWalzingHandover,saveWalzingResult,WALZING_UNITS} from './walzingResults';
import {prepareFormationHandover,receiveFormationIncoming,saveFormationResult,receiveFormationResult,validateFormationResult,FORMATION_UNITS} from './formationResults';
import {applyPacket} from '../../transfer/apply';
import {receiveAssemblyIntake} from './assemblyIntake';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let fill:FillRun,walz:WalzRun,incoming:FormationIncoming,run:FormationRun;
beforeEach(async()=>{
 await db.open();await db.users.bulkAdd([{id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);
 const source:AssemblyRun={id:'job',batchName:'Filling source',cellType:'unassigned',ops:[{id:'cells',source:{kind:'declared',reference:'counted cells'},substation:'crimp-cyl',workerId:'worker',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]}],sourceLedger:1,operationLedger:1,cellsOut:0,cellsScrap:0,defects:[],workerId:'worker',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T13:00:00Z',cellOutput:{id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'FILL-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Count basis'}};
 await db.assemblyRuns.add(source);
 const pending=await prepareFillingHandover(source,'floor7-room5','master','instruction');const receipt=await acceptFillingHandover(pending,'floor7-room5','worker',4,'Count checked','receipt');const now=new Date().toISOString();
 fill={id:'fill',resultVersion:1,sourceReceipt:receipt,box:'floor7-room5',batchName:source.batchName,serialRange:receipt.serialRange,cellType:receipt.cellType,cellsIn:4,cellsFilled:4,cellsScrap:0,cellsUnknown:0,electrolyteName:'Electrolyte',doseActual:2,vacuumKpa:0,pressureKpa:10,dwellMin:3,temperatureC:20,humidityPpm:0,measurementUnits:FILLING_UNITS,measurementBasis:'Dose per cell; vacuum depth and gauge injection pressure; room environment',defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:now,updatedAt:now};await saveFillingResult(fill,'worker');
 const walzIncoming=await prepareWalzingHandover(fill,'worker');
 const recordedAt=new Date().toISOString();walz={id:'walz',sourceLedger:1,inputSnapshot:walzIncoming,batchName:walzIncoming.batchName,serialRange:walzIncoming.serialRange,cellsIn:4,cellsOut:4,cellsScrap:0,cellsUnknown:0,incomingDiameter:21,finalDiameter:20.9,passes:1,pressureKgf:5,speedRpm:10,temperatureC:20,measurementUnits:WALZING_UNITS,machineNo:'Observed machine',defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:recordedAt,updatedAt:recordedAt};
 await saveWalzingResult(walz,'worker');incoming=await prepareFormationHandover(walz,'worker');const savedAt=new Date().toISOString();
 run={id:'formation',sourceLedger:1,inputSnapshot:incoming,batchName:incoming.batchName,serialRange:incoming.serialRange,mode:{cycles:5,currentA:-1,voltageV:4.1},startDate:'2026-11-10',endDate:'2026-11-11',coulombEfficiencyPct:95,capacityCycle5Ah:2.5,cellsIn:4,cellsOut:4,cellsScrap:0,cellsUnknown:0,equipmentRef:'Observed channel',measurementBasis:'Recorded cycle observations, no QA release',measurementUnits:FORMATION_UNITS,defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:savedAt,updatedAt:savedAt};
});
afterEach(async()=>{db.close();await db.delete();});
it('persists one pending complete-source formation instruction and safely reopens without claiming physical receipt',async()=>{
 expect(incoming.sourceWalz).toEqual(walz);expect(incoming.destination).toBe(StageId.FORMATION);expect(incoming.receivedAt).toBeUndefined();expect(await prepareFormationHandover(walz,'worker')).toEqual(incoming);
 db.close();await db.open();expect(await db.formationIncoming.get(incoming.id)).toEqual(incoming);
 await expect(prepareFormationHandover({...walz,cellsOut:3,cellsUnknown:1},'worker')).rejects.toThrow();await expect(prepareFormationHandover(fill,'worker')).rejects.toThrow();
});
it('supports the complete dry-room alternative and commits its instruction and journal atomically',async()=>{
 const source=fill.sourceReceipt!.sourceAssembly!;
 // Disposable test history only: create a fresh independent dry-room lineage.
 await db.formationIncoming.clear();await db.walzingIncoming.clear();await db.walzRuns.clear();await db.fillRuns.clear();await db.electrolyteIncoming.clear();
 const pending=await prepareFillingHandover(source,'dry-room','master','dry-instruction');const receipt=await acceptFillingHandover(pending,'dry-room','worker',4,'Dry count','dry-receipt');
 const now=new Date().toISOString();const dry={...fill,id:'dry-fill',box:'dry-room' as const,sourceReceipt:receipt,createdAt:now,updatedAt:now};await saveFillingResult(dry,'worker');
 const fail=()=>{throw Error('Formation instruction journal failed');};db.journal.hook('creating',fail);
 try{await expect(prepareFormationHandover(dry,'worker')).rejects.toThrow('Formation instruction journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.formationIncoming.count()).toBe(0);const prepared=await prepareFormationHandover(dry,'worker');expect(prepared.sourceBox).toBe('dry-room');expect(prepared.sourceFill).toEqual(dry);expect(prepared.receivedAt).toBeUndefined();
});
it('validates real calendar dates, explicit cycles/units/counts and optional measured current, voltage, Ah and percent',()=>{
 for(const changed of [{startDate:''},{startDate:'2026-02-30'},{startDate:'2026-2-03'},{endDate:'2026-11-09'},{endDate:'2026-13-01'},{mode:{cycles:0}},{mode:{cycles:1.5}},{mode:{cycles:4},capacityCycle5Ah:2},{mode:{cycles:5,currentA:Infinity}},{mode:{cycles:5,voltageV:-1}},{coulombEfficiencyPct:100.1},{capacityCycle5Ah:-1},{cellsIn:3},{cellsOut:3.5,cellsScrap:.5},{cellsOut:3},{measurementUnits:{...FORMATION_UNITS,capacity:'mAh'}},{inputSnapshot:{...incoming,cellsIn:3}}])expect(()=>validateFormationResult({...run,...changed} as FormationRun)).toThrow();
 expect(()=>validateFormationResult({...run,serialRange:{prefix:'FILL-',start:10,end:14}})).toThrow();
 expect(()=>validateFormationResult({...run,startDate:'2024-02-29',mode:{cycles:1},capacityCycle5Ah:undefined,coulombEfficiencyPct:undefined,cellsOut:2,cellsScrap:1,cellsUnknown:1})).not.toThrow();
});
it('atomically rolls result/journal back, prevents concurrent source claims and preserves exact retry after reopen',async()=>{
 const fail=()=>{throw Error('Formation journal failed');};db.journal.hook('creating',fail);try{await expect(saveFormationResult(run,'worker')).rejects.toThrow('Formation journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.formationRuns.count()).toBe(0);expect(await db.journal.get(run.id)).toBeUndefined();
 const outcomes=await Promise.allSettled([saveFormationResult(run,'worker'),saveFormationResult({...run,id:'duplicate'},'worker')]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.formationRuns.count()).toBe(1);
 db.close();await db.open();expect(await saveFormationResult(run,'worker')).toEqual(run);expect((await db.journal.get(run.id))?.params?.['Снимок результата']).toBe(JSON.stringify(run));
});
it('rejects stale input/upstream, inactive actor, wrong destination and altered/stripped typed or forced packets',async()=>{
 await db.formationIncoming.put({...incoming,updatedAt:'2099-01-01'});await expect(saveFormationResult(run,'worker')).rejects.toThrow();await db.formationIncoming.put(incoming);
 await db.walzRuns.put({...walz,comment:'Changed'});await expect(saveFormationResult(run,'worker')).rejects.toThrow();await db.walzRuns.put(walz);
 await db.users.update('worker',{isActive:false});await expect(saveFormationResult(run,'worker')).rejects.toThrow();await db.users.update('worker',{isActive:true});
 const packet=(type:'formation-in'|'formation-run'|'forced-push',payload:unknown)=>({v:1 as const,type,stage:StageId.FORMATION,payload,from:'master',role:UserRole.MASTER,forced:true,ts:Date.now()});
 expect((await applyPacket({...packet('formation-in',incoming),stage:StageId.WALZING})).ok).toBe(false);
 for(const type of ['formation-in','forced-push'] as const)expect((await applyPacket(packet(type,{...incoming,cellsIn:3}))).ok).toBe(false);
 await saveFormationResult(run,'worker');
 for(const type of ['formation-run','forced-push'] as const)for(const payload of [{...run,mode:{cycles:6}},{...run,inputSnapshot:undefined,sourceLedger:undefined},{...run,id:'bypass',inputSnapshot:undefined,sourceLedger:undefined}])expect((await applyPacket(packet(type,payload))).ok).toBe(false);
 expect(await receiveFormationResult(run,UserRole.MASTER,'master')).toEqual(run);expect(await receiveFormationIncoming(incoming,StageId.FORMATION,UserRole.MASTER,'master')).toEqual(incoming);expect(await db.tasks.get('bypass')).toBeUndefined();
});
it('retains historical records and permits explicit validated historical observations without protected-source bypass',async()=>{
 const legacy:FormationRun={id:'legacy',batchName:'Historical formation',mode:{cycles:1},startDate:'2026-11-10',cellsIn:2,cellsOut:1,cellsScrap:1,defects:[],workerId:'worker',createdAt:run.createdAt,updatedAt:run.createdAt};
 expect(await saveFormationResult(legacy,'worker')).toEqual(legacy);await expect(saveFormationResult({...legacy,id:'bypass',batchName:run.batchName},'worker')).rejects.toThrow();expect(await db.formationRuns.get(legacy.id)).toEqual(legacy);
});
it('recognizes the original serial lineage after full formation history and rejects unrelated overlap',async()=>{
 const source=fill.sourceReceipt!.sourceAssembly!;await saveFormationResult(run,'worker');await db.assemblyRuns.delete(source.id);expect(await receiveAssemblyIntake(source,UserRole.MASTER)).toEqual(source);
 await expect(prepareFillingHandover({...source,id:'other-job'},'dry-room','master','other')).rejects.toThrow();
});
