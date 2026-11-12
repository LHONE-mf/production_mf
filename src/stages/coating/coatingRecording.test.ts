import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,StageId,type CoatingMixSnapshot} from '../../core/types';
import {prepareRecordedCoatingRun,savePreparedCoatingRun,receiveCoatingRun,saveCoatingRollHandover,type CoatingEntry} from './coatingJournal';
import {applyPacket} from '../../transfer/apply';
vi.mock('../../core/security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let mix:CoatingMixSnapshot,entry:CoatingEntry;
beforeEach(async()=>{await db.open();await db.users.add({id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()});mix={mixBatchId:'source',recipeName:'Frozen source',pasteDensity:2,solidsPctMass:50,createdAt:1};await db.coatIncomingMixes.add(mix);entry={foilType:'Measured Al',mixSnapshot:mix,targetDryMgm2:20,coatingWidthCm:50,webSpeedMpm:8,mode:'continuous',segLengthsM:[10.125],ovenTempsC:[]};});
afterEach(async()=>{db.close();await db.delete();});
it('keeps one immutable attributed run/journal through concurrent exact retry and reopen, even after the source changes',async()=>{
 const run=prepareRecordedCoatingRun(entry,'worker','run',UserRole.WORKER,Date.now());
 await Promise.all([savePreparedCoatingRun(run,'worker'),savePreparedCoatingRun(run,'worker')]);expect(await db.coatRuns.count()).toBe(1);expect(await db.journal.count()).toBe(1);
 await db.coatIncomingMixes.update('source',{recipeName:'Later source',createdAt:2});db.close();await db.open();expect(await savePreparedCoatingRun(run,'worker')).toEqual(run);expect((await db.journal.get(run.id))?.createdAt.getTime()).toBe(run.createdAt);
 await expect(savePreparedCoatingRun({...run,notes:'Changed intent'},'worker')).rejects.toThrow();expect(await db.coatRuns.get(run.id)).toEqual(run);
});
it('rolls the exact attempt and journal back on failure, then retains its original timestamp for retry',async()=>{
 const run=prepareRecordedCoatingRun(entry,'worker','run',UserRole.WORKER,Date.now());const fail=()=>{throw Error('Coating journal failed');};db.journal.hook('creating',fail);
 try{await expect(savePreparedCoatingRun(run,'worker')).rejects.toThrow('Coating journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.coatRuns.count()).toBe(0);expect(await db.journal.count()).toBe(0);db.close();await db.open();expect(await savePreparedCoatingRun(run,'worker')).toEqual(run);
});
it('rejects stale sources, fabricated estimates, unknown mode/units fields and stale actor activation or role',async()=>{
 const run=prepareRecordedCoatingRun(entry,'worker','run',UserRole.WORKER,Date.now());
 for(const patch of [{estimatedFlowLpm:99},{screwRpm:500},{updatedAt:run.createdAt+1},{mode:'assumed'},{massUnit:'kg'},{mixBatchId:'other'}])await expect(savePreparedCoatingRun({...run,...patch} as typeof run,'worker')).rejects.toThrow();
 await db.coatIncomingMixes.update('source',{recipeName:'Changed'});await expect(savePreparedCoatingRun(run,'worker')).rejects.toThrow();await db.coatIncomingMixes.put(mix);
 await db.users.update('worker',{isActive:false});await expect(savePreparedCoatingRun(run,'worker')).rejects.toThrow();await db.users.update('worker',{isActive:true,role:UserRole.MASTER});await expect(savePreparedCoatingRun(run,'worker')).rejects.toThrow();expect(await db.coatRuns.count()).toBe(0);
});
it('protects new runs against altered and stripped typed/forced imports and preserves unrelated legacy history',async()=>{
 const run=prepareRecordedCoatingRun(entry,'worker','run',UserRole.WORKER,Date.now());await savePreparedCoatingRun(run,'worker');
 const packet=(type:'coat-run'|'forced-push',payload:unknown)=>({v:1 as const,type,payload,stage:StageId.COATING,from:'master',role:UserRole.MASTER,forced:true,ts:Date.now()});
 for(const type of ['coat-run','forced-push'] as const){expect((await applyPacket(packet(type,run))).ok).toBe(true);for(const payload of [{...run,foilType:'Changed'},{...run,recordingVersion:undefined,recordedRole:undefined},{...run,ovenTempsC:undefined,segLengthsM:undefined}])expect((await applyPacket(packet(type,payload))).ok).toBe(false);}
 const legacy={id:'old',foilType:'Old record',mode:'continuous' as const,segLengthsM:[],ovenTempsC:[],workerId:'historical',createdAt:1,updatedAt:1};await db.coatRuns.add(legacy);expect(await db.coatRuns.get(legacy.id)).toEqual(legacy);expect(await db.coatRuns.get(run.id)).toEqual(run);
});
it('imports a late recorded observation atomically without inventing or overwriting its source catalog',async()=>{
 const run=prepareRecordedCoatingRun(entry,'worker','remote',UserRole.WORKER,Date.now());await db.coatIncomingMixes.clear();await receiveCoatingRun(run,StageId.COATING,UserRole.WORKER,'worker');expect(await db.coatIncomingMixes.count()).toBe(0);expect(await db.coatRuns.get(run.id)).toEqual(run);expect(await db.journal.get(run.id)).toBeDefined();
 await expect(receiveCoatingRun({...run,id:'another'},StageId.SORTING,UserRole.MASTER,'master')).rejects.toThrow();
});

it('requires a new protected roll handover to use the exact durable coating record',async()=>{
 const run=prepareRecordedCoatingRun({...entry,measuredDryThicknessUm:100},'worker','run',UserRole.WORKER,Date.now());await expect(saveCoatingRollHandover(run)).rejects.toThrow();expect(await db.rollSpecs.count()).toBe(0);await savePreparedCoatingRun(run,'worker');
 await expect(saveCoatingRollHandover({...run,measuredDryThicknessUm:101})).rejects.toThrow();expect(await db.rollSpecs.count()).toBe(0);const spec=await saveCoatingRollHandover(run);expect(spec.thicknessBeforeUm).toBe(100);expect(await saveCoatingRollHandover(run)).toEqual(spec);
});
