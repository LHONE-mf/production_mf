import {receiveAssemblyIntake} from './assemblyIntake';
import {exportLocalBackup,restoreLocalBackup} from '../db/localBackup';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import {UserRole,type FormationRun,type AssemblyRun} from '../types';
import {createFormationSerialIdentity,declareFormationSerialIdentity,type FormationSerialIdentity} from './formationSerialIdentity';
import {syntheticFormationLineage} from '../../../tests/fixtures/formation-lineage';
import {freezeCellOutput,cellOutputClaims} from './cellOutputClaims';
const scope={serverUrl:'https://inventory.example',organizationId:crypto.randomUUID(),actorId:crypto.randomUUID(),deviceId:crypto.randomUUID()},epoch=crypto.randomUUID();
let run:FormationRun,identity:FormationSerialIdentity;
const input=()=>({operationId:crypto.randomUUID(),deviceId:scope.deviceId,productionBatchId:crypto.randomUUID(),completionId:crypto.randomUUID(),stepNumber:1,materialId:crypto.randomUUID(),reason:'Actual final cell output',evidence:'Explicit channel sheet'});
beforeEach(async()=>{await db.open();await db.users.bulkAdd([{id:'chief',login:'chief',fullName:'Chief',password:'SYNTHETIC-test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'SYNTHETIC-test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);run=await syntheticFormationLineage('chief','worker');identity=createFormationSerialIdentity(run,[{start:10,end:10},{start:12,end:12}],'Explicit processed channels',(await db.users.get('chief'))!,crypto.randomUUID(),new Date().toISOString());await declareFormationSerialIdentity(identity,'chief');});
afterEach(async()=>{db.close();await db.delete();});
it('freezes the saved full identity, original scope/epoch/body once and preserves it through reopen',async()=>{
 const draft=input(),claim=await freezeCellOutput(scope,'chief',epoch,identity,draft);
 expect(claim).toMatchObject({version:1,identityId:identity.id,runId:run.id,assemblyOutputId:identity.assemblyOutputId,identity,epoch,scope,localActorId:'chief',localActorRole:'chief',state:'pending',request:{...draft,source:{identityId:identity.id,ranges:identity.ranges}}});
 db.close();await db.open();expect(await cellOutputClaims(scope,'chief')).toEqual([claim]);expect(await freezeCellOutput(scope,'chief',epoch,identity,draft)).toEqual(claim);
 for(const [s,a,e,d] of [[{...scope,actorId:crypto.randomUUID()},'chief',epoch,draft],[scope,'worker',epoch,draft],[scope,'chief',crypto.randomUUID(),draft],[scope,'chief',epoch,input()]] as const)await expect(freezeCellOutput(s,a,e,identity,d)).rejects.toThrow();
 expect(await db.cellOutputClaims.count()).toBe(1);expect(await cellOutputClaims({...scope,deviceId:crypto.randomUUID()},'chief')).toEqual([]);expect(await cellOutputClaims(scope,'worker')).toEqual([]);expect(await db.formationRuns.get(run.id)).toEqual(run);
});
it('rejects a missing or altered saved identity, inactive/worker actor and device/history mismatches without partial claims',async()=>{
 await db.formationSerialIdentities.delete(run.id);await expect(freezeCellOutput(scope,'chief',epoch,identity,input())).rejects.toThrow();await db.formationSerialIdentities.add(identity);
 await expect(freezeCellOutput(scope,'chief',epoch,{...identity,evidence:'Changed declaration'},input())).rejects.toThrow();
 await expect(freezeCellOutput(scope,'worker',epoch,identity,input())).rejects.toThrow();await db.users.update('chief',{isActive:false});await expect(freezeCellOutput(scope,'chief',epoch,identity,input())).rejects.toThrow();
 await expect(freezeCellOutput(scope,'chief','old',identity,input())).rejects.toThrow();await expect(freezeCellOutput(scope,'chief',epoch,identity,{...input(),deviceId:crypto.randomUUID()})).rejects.toThrow();expect(await db.cellOutputClaims.count()).toBe(0);
});
it('serializes competing freezes and rolls storage failure back without changing source evidence',async()=>{
 const second={...scope,deviceId:crypto.randomUUID()};const attempts=await Promise.allSettled([freezeCellOutput(scope,'chief',epoch,identity,input()),freezeCellOutput(second,'chief',epoch,identity,{...input(),deviceId:second.deviceId})]);
 expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.cellOutputClaims.count()).toBe(1);
 await db.cellOutputClaims.clear();const fail=()=>{throw Error('Claim storage unavailable');};db.cellOutputClaims.hook('creating',fail);
 try{await expect(freezeCellOutput(scope,'chief',epoch,identity,input())).rejects.toThrow('Claim storage unavailable');}finally{db.cellOutputClaims.hook('creating').unsubscribe(fail);}
 expect(await db.cellOutputClaims.count()).toBe(0);expect(await db.formationSerialIdentities.get(run.id)).toEqual(identity);expect(await db.formationRuns.get(run.id)).toEqual(run);
});

it('retains the whole serial domain through the claim when older identity/source rows are missing',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input()),assembly=run.inputSnapshot!.sourceFill!.sourceReceipt!.sourceAssembly!;
 for(const table of [db.assemblyRuns,db.electrolyteIncoming,db.fillRuns,db.walzingIncoming,db.walzRuns,db.formationIncoming,db.formationRuns,db.formationSerialIdentities])await table.clear();
 const unrelated:AssemblyRun={id:'unrelated',batchName:'Unrelated cells',cellType:'unassigned',ops:[],cellsOut:4,cellsScrap:0,defects:[],workerId:'worker',serialRange:run.serialRange,createdAt:run.createdAt,updatedAt:run.createdAt};
 await expect(receiveAssemblyIntake(unrelated,UserRole.MASTER)).rejects.toThrow('номер');expect(await db.assemblyRuns.count()).toBe(0);
 expect(await receiveAssemblyIntake(assembly,UserRole.MASTER)).toEqual(assembly);expect(await db.cellOutputClaims.get(run.id)).toEqual(claim);
});
it('exports original claims but refuses to restore device-bound proposals through a local-only backup',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input()),archive=await exportLocalBackup();
 expect(JSON.parse(archive).payload.tables.find(([name]:[string,unknown])=>name==='cellOutputClaims')[1]).toHaveLength(1);
 await expect(restoreLocalBackup(archive)).rejects.toThrow('серверную синхронизацию');expect(await db.cellOutputClaims.get(run.id)).toEqual(claim);
});
it('retains the exact saved identity, including undefined source fields, when the durable JSON form omits them',async()=>{
 const throughForm=JSON.parse(JSON.stringify(identity)),claim=await freezeCellOutput(scope,'chief',epoch,throughForm,input());
 expect(claim.identity).toStrictEqual(identity);expect((await db.cellOutputClaims.get(run.id))?.identity).toStrictEqual(identity);
});
