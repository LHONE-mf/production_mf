import {beforeEach,afterEach,expect,it} from 'vitest';
import {db} from '../db';
import {UserRole,StageId,type AssemblyRun,type AssemblyOp} from '../types';
import {appendAssemblyOperation} from './assemblyOperations';
import {declareAssemblyCellOutput} from './assemblyCellOutput';
import {receiveAssemblyIntake} from './assemblyIntake';
import {prepareFillingHandover,acceptFillingHandover,receiveFillingHandover} from './fillingHandover';
let source:AssemblyRun;
beforeEach(async()=>{
 await db.open();await db.users.bulkAdd([{id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()},{id:'receiver',login:'receiver',fullName:'Receiver',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);
 const base:AssemblyRun={id:'job',batchName:'Counted cells',cellType:'unassigned',ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId:'operator',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};await db.assemblyRuns.add(base);
 const op:AssemblyOp={id:'cells',source:{kind:'declared',reference:'counted-source'},substation:'crimp-cyl',workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]};
 const observed=await appendAssemblyOperation(base,op,'operator');source=await declareAssemblyCellOutput(observed,{id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'MF-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Entered count basis, not QA'},'master');
});
afterEach(async()=>{db.close();await db.delete();});
it('prepares one durable pending instruction using the declaration, not old raw totals, and resumes on retry/reopen',async()=>{
 const [a,b]=await Promise.all([prepareFillingHandover(source,'dry-room','master','a'),prepareFillingHandover(source,'dry-room','master','b')]);
 expect(a).toEqual(b);expect(a).toMatchObject({cellsIn:4,cellType:'cylindrical',serialRange:source.cellOutput!.serialRange,sourceAssembly:source,handover:{outputId:'output',preparedBy:'master'}});
 expect(a.receipt).toBeUndefined();expect(a.receivedAt).toBeUndefined();expect(await db.electrolyteIncoming.count()).toBe(1);expect(await db.journal.count()).toBe(3);
 db.close();await db.open();expect(await prepareFillingHandover(source,'dry-room','master','retry')).toEqual(a);expect(await db.assemblyRuns.get(source.id)).toEqual(source);
});
it('serializes competing destinations and rejects stale sources or unprivileged preparation',async()=>{
 await expect(prepareFillingHandover(source,'dry-room','receiver','worker')).rejects.toThrow();
 await expect(prepareFillingHandover({...source,updatedAt:'2099-01-01'},'dry-room','master','stale')).rejects.toThrow();
 const results=await Promise.allSettled([prepareFillingHandover(source,'dry-room','master','dry'),prepareFillingHandover(source,'floor7-room5','master','705')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.electrolyteIncoming.count()).toBe(1);
});
it('rolls pending instruction and journal back together on failure',async()=>{
 const fail=()=>{throw Error('Handover journal failure');};db.journal.hook('creating',fail);
 try{await expect(prepareFillingHandover(source,'dry-room','master','a')).rejects.toThrow('Handover journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.electrolyteIncoming.count()).toBe(0);expect(await db.journal.count()).toBe(2);
 await prepareFillingHandover(source,'dry-room','master','a');expect(await db.electrolyteIncoming.count()).toBe(1);
});
it('requires an explicit different receiver, exact count and destination; receipt/journal roll back and retry once',async()=>{
 const pending=await prepareFillingHandover(source,'dry-room','master','a');
 for(const [box,actor,count] of [['floor7-room5','receiver',4],['dry-room','master',4],['dry-room','receiver',3]] as const)await expect(acceptFillingHandover(pending,box,actor,count,'Count checked','receipt')).rejects.toThrow();
 const fail=()=>{throw Error('Receipt journal failure');};db.journal.hook('creating',fail);
 try{await expect(acceptFillingHandover(pending,'dry-room','receiver',4,'Count checked','receipt')).rejects.toThrow('Receipt journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.electrolyteIncoming.get(pending.id)).toEqual(pending);
 const accepted=await acceptFillingHandover(pending,'dry-room','receiver',4,'Count checked','receipt');
 expect(accepted).toMatchObject({receipt:{id:'receipt',count:4,recordedBy:'receiver',note:'Count checked'}});
 expect(accepted.receivedAt).toBe(accepted.receipt!.recordedAt);expect(await acceptFillingHandover(pending,'dry-room','receiver',4,'Count checked','another-id')).toEqual(accepted);expect(await db.journal.count()).toBe(4);
});
it('packet arrival is pending; identical replay and receipt append preserve history while forced/legacy bypass fails',async()=>{
 const pending=await prepareFillingHandover(source,'dry-room','master','a');await db.electrolyteIncoming.delete(pending.id);
 await expect(receiveFillingHandover(pending,UserRole.WORKER,'receiver',StageId.ELECTROLYTE)).rejects.toThrow();
 expect((await receiveFillingHandover(pending,UserRole.MASTER,'master',StageId.ELECTROLYTE)).receipt).toBeUndefined();
 for(const invalid of [{...pending,id:'duplicate',box:'floor7-room5' as const},{...pending,cellsIn:3},{...pending,handover:undefined,sourceAssembly:undefined},{id:'legacy',box:'floor7-room5' as const,batchName:pending.batchName,cellsIn:4,fromAssemblyRunId:source.id,receivedAt:'2026-11-11',updatedAt:'2026-11-11'}])await expect(receiveFillingHandover(invalid,UserRole.MASTER,'master',invalid.box==='dry-room'?StageId.ELECTROLYTE:StageId.ELECTROLYTE_705)).rejects.toThrow();
 const accepted=await acceptFillingHandover(pending,'dry-room','receiver',4,'Checked','receipt');await db.electrolyteIncoming.put(pending);
 expect(await receiveFillingHandover(accepted,UserRole.WORKER,'receiver',StageId.ELECTROLYTE)).toEqual(accepted);
 expect(await receiveFillingHandover(pending,UserRole.MASTER,'master',StageId.ELECTROLYTE)).toEqual(accepted);
 await expect(receiveFillingHandover({...accepted,receipt:{...accepted.receipt!,note:'Replaced'}},UserRole.CHIEF,'master',StageId.ELECTROLYTE)).rejects.toThrow();
});
it('preserves ambiguous legacy history and can import the exact assembly snapshot after its handover arrives',async()=>{
 const legacy={id:'old',box:'floor7-room5' as const,batchName:source.batchName,cellsIn:4,receivedAt:'2026-11-11',updatedAt:'2026-11-11'};await db.electrolyteIncoming.add(legacy);
 await expect(prepareFillingHandover(source,'dry-room','master','a')).rejects.toThrow();expect(await db.electrolyteIncoming.get('old')).toEqual(legacy);await db.electrolyteIncoming.delete('old');
 const pending=await prepareFillingHandover(source,'dry-room','master','a');await db.electrolyteIncoming.clear();await db.assemblyRuns.delete(source.id);
 await receiveFillingHandover(pending,UserRole.MASTER,'master',StageId.ELECTROLYTE);
 expect(await receiveAssemblyIntake(source,UserRole.MASTER)).toEqual(source);
});
