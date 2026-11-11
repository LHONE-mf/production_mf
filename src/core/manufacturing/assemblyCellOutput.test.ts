import {beforeEach,afterEach,expect,it} from 'vitest';
import {db} from '../db';
import {UserRole,type AssemblyRun,type AssemblyOp,type AssemblyCellOutput} from '../types';
import {appendAssemblyOperation} from './assemblyOperations';
import {declareAssemblyCellOutput} from './assemblyCellOutput';
import {receiveAssemblyIntake} from './assemblyIntake';
const base:AssemblyRun={id:'job',batchName:'Declared cells',cellType:'unassigned',ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId:'operator',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};
const op:AssemblyOp={id:'cells',source:{kind:'declared',reference:'counted-source'},substation:'crimp-cyl',workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]};
const declaration:AssemblyCellOutput={id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'MF-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Operator count reviewed locally; this is not QA approval'};
let saved:AssemblyRun;
beforeEach(async()=>{
 await db.open();await db.users.add({id:'master',login:'master',fullName:'Local master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()});
 await db.assemblyRuns.add(base);saved=await appendAssemblyOperation(base,op,'operator');
});
afterEach(async()=>{db.close();await db.delete();});
it('records a separate whole cell-output declaration and journal atomically, with exact retry and reopen',async()=>{
 const [a,b]=await Promise.all([declareAssemblyCellOutput(saved,declaration,'master'),declareAssemblyCellOutput(saved,declaration,'master')]);
 expect(a).toEqual(b);expect(a).toMatchObject({cellOutput:declaration,cellsOut:0,cellType:'unassigned',ops:[op]});expect(await db.journal.count()).toBe(2);
 db.close();await db.open();expect(await declareAssemblyCellOutput(saved,declaration,'master')).toEqual(a);
 await expect(appendAssemblyOperation(a,{...op,id:'later'},'operator')).rejects.toThrow();
});
it('rejects non-cell/nonterminal output, unbalanced serial counts, unsafe ranges and unauthorized actors',async()=>{
 for(const invalid of [{...declaration,count:3},{...declaration,operationId:'missing'},{...declaration,serialRange:{start:1.5,end:4.5}},{...declaration,serialRange:{start:0,end:9007199254740992}},{...declaration,cellType:'unassigned' as never}])await expect(declareAssemblyCellOutput(saved,invalid,'master')).rejects.toThrow();
 await db.users.update('master',{role:UserRole.WORKER});await expect(declareAssemblyCellOutput(saved,declaration,'master')).rejects.toThrow();
 expect((await db.assemblyRuns.get(base.id))?.cellOutput).toBeUndefined();
});
it('rolls declaration and journal back on failure and preserves a stable retry',async()=>{
 const fail=()=>{throw Error('Output journal failure');};db.journal.hook('creating',fail);
 try{await expect(declareAssemblyCellOutput(saved,declaration,'master')).rejects.toThrow('Output journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.assemblyRuns.get(base.id)).toEqual(saved);
 await declareAssemblyCellOutput(saved,declaration,'master');expect(await db.journal.count()).toBe(2);
});
it('serializes competing ranges across jobs and checks existing downstream/unknown-prefix ranges',async()=>{
 const other={...base,id:'other',batchName:'Other counted cells'};await db.assemblyRuns.add(other);
 const second=await appendAssemblyOperation(other,{...op,id:'other-cells',source:{kind:'declared',reference:'other-source'}},'operator');
 const results=await Promise.allSettled([declareAssemblyCellOutput(saved,declaration,'master'),declareAssemblyCellOutput(second,{...declaration,id:'other-output',operationId:'other-cells'},'master')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await db.electrolyteIncoming.add({id:'downstream',box:'dry-room',batchName:'Legacy range',cellsIn:4,serialRange:{start:100,end:103},receivedAt:'2026-11-11',updatedAt:'2026-11-11'});
 const current=results[0].status==='rejected'?saved:second;
 await expect(declareAssemblyCellOutput(current,{...declaration,id:'downstream-overlap',operationId:current.ops[0].id!,serialRange:{prefix:'OTHER-',start:100,end:103}},'master')).rejects.toThrow('номеров');
});
it('requires a permitted signed-envelope role on first receipt and rejects stripped or changed declarations',async()=>{
 const declared=await declareAssemblyCellOutput(saved,declaration,'master');
 expect(await receiveAssemblyIntake(declared,UserRole.MASTER)).toEqual(declared);
 for(const altered of [{...declared,cellOutput:undefined},{...declared,cellOutput:{...declaration,count:3}},{...declared,ops:[]}])await expect(receiveAssemblyIntake(altered,UserRole.CHIEF)).rejects.toThrow();
 await db.assemblyRuns.put(saved);expect(await receiveAssemblyIntake(declared,UserRole.MASTER)).toEqual(declared);
 await db.assemblyRuns.delete(base.id);
 await expect(receiveAssemblyIntake(declared,UserRole.WORKER)).rejects.toThrow();
 await expect(receiveAssemblyIntake({...declared,cellOutput:null as never},UserRole.MASTER)).rejects.toThrow();
 expect(await db.assemblyRuns.get(base.id)).toBeUndefined();
 expect(await receiveAssemblyIntake(declared,UserRole.MASTER)).toEqual(declared);
});
it('rejects non-cell terminals, consumed output and historical ancestors without explicit provenance',async()=>{
 const electrodes={...saved,ops:[{...op,units:{input:'electrodes' as const,output:'electrodes' as const,scrap:'electrodes' as const}}]};
 await db.assemblyRuns.put(electrodes);await expect(declareAssemblyCellOutput(electrodes,declaration,'master')).rejects.toThrow();
 await db.assemblyRuns.put(saved);
 const child={...op,id:'child',source:{kind:'operation' as const,operationId:'cells'},qtyIn:4,qtyOut:3};
 const continued=await appendAssemblyOperation(saved,child,'operator');await expect(declareAssemblyCellOutput(continued,declaration,'master')).rejects.toThrow();
 const unlinked={...op,source:undefined};const incomplete={...continued,ops:[unlinked,child]};await db.assemblyRuns.put(incomplete);
 await expect(declareAssemblyCellOutput(incomplete,{...declaration,operationId:'child',count:3,serialRange:{start:1,end:3}},'master')).rejects.toThrow('явного источника');
});
it('rolls receipt back completely when a fresh declaration conflicts with an occupied range',async()=>{
 const original=await declareAssemblyCellOutput(saved,declaration,'master');
 const incoming={...saved,id:'fresh-job',batchName:'Fresh import',ops:[{...op,id:'fresh-op',source:{kind:'declared' as const,reference:'fresh-source'}}],cellOutput:{...declaration,id:'fresh-output',operationId:'fresh-op'},updatedAt:declaration.recordedAt};
 await expect(receiveAssemblyIntake(incoming,UserRole.MASTER)).rejects.toThrow('номеров');
 expect(await db.assemblyRuns.get('fresh-job')).toBeUndefined();expect(await db.assemblyRuns.get(base.id)).toEqual(original);
});
it('does not mistake a downstream record with extra operation fields for the current assembly row',async()=>{
 const legacy={id:base.id,box:'dry-room' as const,batchName:'Historical incoming',cellsIn:4,serialRange:declaration.serialRange,receivedAt:'2026-11-11',updatedAt:'2026-11-11',ops:[]};
 await db.electrolyteIncoming.add(legacy);
 await expect(declareAssemblyCellOutput(saved,declaration,'master')).rejects.toThrow('номеров');
 expect((await db.assemblyRuns.get(base.id))?.cellOutput).toBeUndefined();
});
