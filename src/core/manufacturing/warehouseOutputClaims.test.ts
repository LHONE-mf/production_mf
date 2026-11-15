import {afterEach,beforeEach,expect,it} from 'vitest';
import Dexie from 'dexie';
import {db} from '../db';
import {UserRole,type SortRun,type CutRun,type SortSpec} from '../types';
import {startSortingWorkflow,recordSortingStation,completeSortingWorkflow} from './sortingWorkflow';
import {takeAssemblySource,receiveAssemblyIntake} from './assemblyIntake';
import {receiveAssemblyOperationRun} from './assemblyOperations';
import {freezeWarehouseOutput,warehouseOutputClaims} from './warehouseOutputClaims';
import {exportLocalBackup,restoreLocalBackup} from '../db/localBackup';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'},epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let source:SortRun;
const input=()=>({operationId:crypto.randomUUID(),deviceId:scope.deviceId,productionBatchId:crypto.randomUUID(),completionId:crypto.randomUUID(),stepNumber:1,outputs:[{grade:'PASS',quantity:7,materialId:'55555555-5555-4555-8555-555555555555'}],reason:'Actual completed output',evidence:'Physical station count sheet'});
beforeEach(async()=>{
 await db.open();await db.users.add({id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()});
 const cut:CutRun={id:'cut',incomingId:'roll',electrodeType:'strip',goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
 const spec:SortSpec={id:'spec',cutRunId:cut.id,batchName:cut.incomingId,electrodeType:'strip',parameterName:'Mass',unit:'g',categories:[{name:'A',criteria:'Manual count',minMass:1}],authorId:'tech',createdAt:1,updatedAt:1};
 await db.cuttingRuns.add(cut);await db.sortSpecs.add(spec);await startSortingWorkflow(cut,spec,'pass-fail','master');
 for(const [i,station] of (['visual','thickness','mass'] as const).entries())await recordSortingStation('cut',{station,passedCount:9-i,rejectedCount:1,workerId:'operator'});
 source=await completeSortingWorkflow('cut','sort');
});
afterEach(async()=>{db.close();await db.delete();});
it('atomically freezes a whole source and original scoped submission without stock, surviving reopen',async()=>{
 const request=input(),claim=await freezeWarehouseOutput(scope,'master',epoch,source,request);
 expect(claim).toMatchObject({cutRunId:'cut',runId:'sort',source,epoch,state:'pending',request:{...request,source:{runId:'sort'}}});
 db.close();await db.open();expect(await warehouseOutputClaims(scope,'master')).toEqual([claim]);
 expect(await freezeWarehouseOutput(scope,'master',epoch,source,request)).toEqual(claim);
 await expect(freezeWarehouseOutput(scope,'master',epoch,source,input())).rejects.toThrow();
 await expect(takeAssemblySource(source,'assembler','assembly')).rejects.toThrow('склад');
 expect(await db.assemblyRuns.count()).toBe(0);
 expect(await warehouseOutputClaims({...scope,actorId:crypto.randomUUID()},'master')).toEqual([]);
});
it('serializes an offer against a concurrent full Assembly allocation so only one owns the source',async()=>{
 const results=await Promise.allSettled([freezeWarehouseOutput(scope,'master',epoch,source,input()),takeAssemblySource(source,'assembler','assembly')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect((await db.assemblyRuns.count())+(await db.warehouseOutputClaims.count())).toBe(1);
});
it('refuses already allocated/ambiguous history, changed sources and inactive authors without writing a claim',async()=>{
 const assembly=await takeAssemblySource(source,'assembler','assembly');await expect(freezeWarehouseOutput(scope,'master',epoch,source,input())).rejects.toThrow();
 expect(await db.assemblyRuns.get(assembly.id)).toEqual(assembly);
 await db.assemblyRuns.clear();await db.sortRuns.update(source.id,{updatedAt:source.updatedAt+1});
 await expect(freezeWarehouseOutput(scope,'master',epoch,source,input())).rejects.toThrow();await db.sortRuns.put(source);
 await db.users.update('master',{isActive:false});await expect(freezeWarehouseOutput(scope,'master',epoch,source,input())).rejects.toThrow();
 expect(await db.warehouseOutputClaims.count()).toBe(0);
});
it('rejects incoming Assembly provenance and legacy aliases after the original warehouse offer',async()=>{
 const run=await takeAssemblySource(source,'assembler','assembly');await db.assemblyRuns.clear();await freezeWarehouseOutput(scope,'master',epoch,source,input());
 await expect(receiveAssemblyIntake(run)).rejects.toThrow('склад');
 const {intake:_intake,sourceSort:_source,...legacy}=run;
 await expect(receiveAssemblyIntake({...legacy,id:'old',batchName:source.batchName})).rejects.toThrow('склад');
 const operated={...run,operationLedger:1 as const,sourceLedger:1 as const,ops:[{id:'operation',recordedAt:run.createdAt,finishedAt:run.createdAt,substation:'li-electrodes' as const,workerId:'operator',qtyIn:7,qtyOut:7,qtyScrap:0,units:{input:'electrodes' as const,output:'electrodes' as const,scrap:'electrodes' as const},source:{kind:'intake' as const,sortRunId:source.id},params:{},defects:[]}]};
 await expect(receiveAssemblyOperationRun(operated)).rejects.toThrow('склад');
 expect(await db.assemblyRuns.count()).toBe(0);
});
it('rolls a failed source freeze back so an unclaimed source still permits the existing offline Assembly intake',async()=>{
 const fail=()=>{throw Error('Claim storage unavailable');};db.warehouseOutputClaims.hook('creating',fail);
 try{await expect(freezeWarehouseOutput(scope,'master',epoch,source,input())).rejects.toThrow('Claim storage unavailable');}
 finally{db.warehouseOutputClaims.hook('creating').unsubscribe(fail);}
 expect(await db.warehouseOutputClaims.count()).toBe(0);expect(await db.sortRuns.get(source.id)).toEqual(source);
 await expect(takeAssemblySource(source,'assembler','assembly')).resolves.toHaveProperty('id','assembly');
});
it('adds claims to a populated v21 installation without changing any original row or manufacturing snapshot',async()=>{
 const tables=db.tables.filter(t=>!['warehouseOutputClaims','formationSerialIdentities','cellOutputClaims'].includes(t.name));
 const stores=Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')]));
 const rows=new Map<string,unknown[]>();for(const t of tables)rows.set(t.name,await t.toArray());
 db.close();await db.delete();const old=new Dexie(db.name);old.version(21).stores(stores);
 await old.open();for(const [name,data] of rows)if(data.length)await old.table(name).bulkAdd(data);old.close();
 await db.open();expect(db.verno).toBe(24);expect(await db.warehouseOutputClaims.count()).toBe(0);
 for(const [name,data] of rows)expect(await db.table(name).toArray(),name).toEqual(data);
 await freezeWarehouseOutput(scope,'master',epoch,source,input());db.close();await db.open();expect(await db.warehouseOutputClaims.count()).toBe(1);
});
it('retains v21 local-only backup restoration but archives new device-bound offers without granting their transfer',async()=>{
 const archive=JSON.parse(await exportLocalBackup());archive.schemaVersion=21;archive.payload.tables=archive.payload.tables.filter(([name]:[string,unknown])=>!['warehouseOutputClaims','formationSerialIdentities','cellOutputClaims'].includes(name));
 archive.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(archive.payload)))),b=>b.toString(16).padStart(2,'0')).join('');
 db.close();await db.delete();await restoreLocalBackup(JSON.stringify(archive));expect(await db.sortRuns.get(source.id)).toEqual(source);
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,input()),withClaim=await exportLocalBackup();
 expect(JSON.parse(withClaim).payload.tables.find(([name]:[string,unknown])=>name==='warehouseOutputClaims')[1]).toHaveLength(1);
 await expect(restoreLocalBackup(withClaim)).rejects.toThrow('серверную синхронизацию');expect(await db.warehouseOutputClaims.get(source.cutRunId!)).toEqual(claim);
});
