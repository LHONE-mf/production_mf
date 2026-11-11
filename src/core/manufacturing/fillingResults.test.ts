import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {StageId,UserRole,type AssemblyRun,type ElectrolyteIncoming,type FillRun} from '../types';
import {prepareFillingHandover,acceptFillingHandover,receiveFillingHandover} from './fillingHandover';
import {saveFillingResult,receiveFillingResult,FILLING_UNITS,validateFillingResult} from './fillingResults';
import {applyPacket} from '../../transfer/apply';
import {receiveAssemblyIntake} from './assemblyIntake';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let source:AssemblyRun,receipt:ElectrolyteIncoming,run:FillRun;
beforeEach(async()=>{
 await db.open();
 await db.users.bulkAdd([{id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);
 source={id:'job',batchName:'Filling source',cellType:'unassigned',ops:[{id:'cells',source:{kind:'declared',reference:'counted cells'},substation:'crimp-cyl',workerId:'worker',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]}],sourceLedger:1,operationLedger:1,cellsOut:0,cellsScrap:0,defects:[],workerId:'worker',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T13:00:00Z',cellOutput:{id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'FILL-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Count basis'}};
 await db.assemblyRuns.add(source);
 const pending=await prepareFillingHandover(source,'dry-room','master','instruction');
 receipt=await acceptFillingHandover(pending,'dry-room','worker',4,'Count checked','receipt');
 const now=new Date().toISOString();
 run={id:'result',resultVersion:1,sourceReceipt:receipt,box:'dry-room',batchName:receipt.batchName,serialRange:receipt.serialRange,cellType:receipt.cellType,cellsIn:4,cellsFilled:4,cellsScrap:0,cellsUnknown:0,electrolyteName:'Measured electrolyte',doseActual:2,vacuumKpa:0,pressureKpa:12,dwellMin:3,temperatureC:-2,humidityPpm:0,measurementUnits:FILLING_UNITS,measurementBasis:'Dose per cell; vacuum depth and gauge injection pressure; room environment',machineNo:'Machine observed',defects:[],workerId:'worker',recordedRole:UserRole.WORKER,createdAt:now,updatedAt:now};
});
afterEach(async()=>{db.close();await db.delete();});
it('saves the full received source with attributed journal once across concurrent retry and reopen',async()=>{
 const [a,b]=await Promise.all([saveFillingResult(run,'worker'),saveFillingResult(run,'worker')]);expect(a).toEqual(b);
 expect(await db.fillRuns.count()).toBe(1);expect(await db.journal.get(run.id)).toMatchObject({workerId:'worker',stage:StageId.ELECTROLYTE,params:{'Снимок результата':JSON.stringify(run)}});
 db.close();await db.open();expect(await saveFillingResult(run,'worker')).toEqual(a);
 expect(await receiveFillingHandover(receipt,UserRole.MASTER,'master',StageId.ELECTROLYTE)).toEqual(receipt);
});
it('retains an explicitly measured zero dose when the entire received count is rejected, without inventing filled output',async()=>{
 const rejected={...run,doseActual:0,cellsFilled:0,cellsScrap:4};
 expect(await saveFillingResult(rejected,'worker')).toEqual(rejected);
 expect((await db.fillRuns.get(run.id))?.cellsFilled).toBe(0);expect((await db.journal.get(run.id))?.params?.['Отклонено']).toBe(4);
});
it('requires exact saved independent receipt, destination, source, actor and immutable result',async()=>{
 for(const changed of [{sourceReceipt:{...receipt,receipt:undefined}},{box:'floor7-room5'},{sourceReceipt:{...receipt,receipt:{...receipt.receipt!,note:'Altered'}}},{serialRange:{prefix:'FILL-',start:11,end:14}},{workerId:'master'}])await expect(saveFillingResult({...run,...changed} as FillRun,'worker')).rejects.toThrow();
 await db.electrolyteIncoming.delete(receipt.id);await expect(saveFillingResult(run,'worker')).rejects.toThrow();await db.electrolyteIncoming.add(receipt);
 await db.assemblyRuns.put({...source,updatedAt:'2099-01-01'});await expect(saveFillingResult(run,'worker')).rejects.toThrow();await db.assemblyRuns.put(source);
 await db.users.update('worker',{isActive:false});await expect(saveFillingResult(run,'worker')).rejects.toThrow();await db.users.update('worker',{isActive:true});
 await saveFillingResult(run,'worker');await expect(saveFillingResult({...run,doseActual:5},'worker')).rejects.toThrow();expect(await db.fillRuns.get(run.id)).toEqual(run);
});
it('rejects blank/nonfinite measurements, bad units, fractions and incomplete full-source partitions',()=>{
 for(const changed of [{doseActual:undefined},{doseActual:0},{vacuumKpa:-1},{pressureKpa:Infinity},{temperatureC:-274},{humidityPpm:-1},{dwellMin:NaN},{measurementUnits:{...FILLING_UNITS,dose:'ml'}},{measurementUnits:{...FILLING_UNITS,humidity:'°C'}},{cellsIn:3},{cellsFilled:3.5,cellsScrap:.5},{cellsFilled:3},{cellsUnknown:undefined},{machineNo:' '},{createdAt:'bad date'}])expect(()=>validateFillingResult({...run,...changed} as FillRun)).toThrow();
 expect(()=>validateFillingResult({...run,cellsFilled:1,cellsScrap:1,cellsUnknown:2})).not.toThrow();
});
it('serializes competing claims and rolls result and journal back together before safe retry',async()=>{
 const fail=()=>{throw Error('Result journal failure');};db.journal.hook('creating',fail);
 try{await expect(saveFillingResult(run,'worker')).rejects.toThrow('Result journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.fillRuns.count()).toBe(0);expect(await db.journal.get(run.id)).toBeUndefined();
 const results=await Promise.allSettled([saveFillingResult(run,'worker'),saveFillingResult({...run,id:'competing'},'worker')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.fillRuns.count()).toBe(1);
});
it('blocks unrelated serial claims, ambiguous legacy results and typed/forced stripped or altered packets',async()=>{
 const legacy={...run,id:'old',resultVersion:undefined,sourceReceipt:undefined};await db.fillRuns.add(legacy);
 await expect(saveFillingResult(run,'worker')).rejects.toThrow();await db.fillRuns.delete('old');
 await db.formationIncoming.add({id:'collision',sourceBox:'dry-room',batchName:'other',cellsIn:4,serialRange:run.serialRange,receivedAt:run.createdAt,updatedAt:run.createdAt});await expect(saveFillingResult(run,'worker')).rejects.toThrow();await db.formationIncoming.clear();
 await saveFillingResult(run,'worker');
 for(const type of ['fill-run','forced-push'] as const)for(const payload of [{...run,doseActual:9},{...legacy,id:run.id},{...legacy,id:'bypass'}]){
  expect((await applyPacket({v:1,type,stage:StageId.ELECTROLYTE,payload,from:'master',role:UserRole.MASTER,forced:true,ts:Date.now()})).ok).toBe(false);
 }
 expect(await db.fillRuns.get(run.id)).toEqual(run);expect(await db.tasks.get('bypass')).toBeUndefined();
 expect((await applyPacket({v:1,type:'fill-run',stage:StageId.ELECTROLYTE_705,payload:run,from:'worker',role:UserRole.WORKER,ts:Date.now()})).ok).toBe(false);
 expect(await receiveFillingResult(run,StageId.ELECTROLYTE,UserRole.WORKER,'worker')).toEqual(run);
});
it('packet import requires a saved receipt, first-sender authority and creates its journal atomically',async()=>{
 await db.electrolyteIncoming.delete(receipt.id);await expect(receiveFillingResult(run,StageId.ELECTROLYTE,UserRole.WORKER,'worker')).rejects.toThrow();await db.electrolyteIncoming.add(receipt);
 await expect(receiveFillingResult(run,StageId.ELECTROLYTE,UserRole.WORKER,'different')).rejects.toThrow();
 const fail=()=>{throw Error('Import journal failure');};db.journal.hook('creating',fail);
 try{await expect(receiveFillingResult(run,StageId.ELECTROLYTE,UserRole.WORKER,'worker')).rejects.toThrow('Import journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.fillRuns.count()).toBe(0);
 expect(await receiveFillingResult(run,StageId.ELECTROLYTE,UserRole.MASTER,'master')).toEqual(run);expect(await db.journal.get(run.id)).toBeDefined();
});
it('keeps a filled result in its original lineage when the exact upstream declaration arrives later',async()=>{
 await saveFillingResult(run,'worker');await db.assemblyRuns.delete(source.id);
 expect(await receiveAssemblyIntake(source,UserRole.MASTER)).toEqual(source);
 await expect(prepareFillingHandover({...source,id:'other'},'floor7-room5','master','other')).rejects.toThrow();
});
