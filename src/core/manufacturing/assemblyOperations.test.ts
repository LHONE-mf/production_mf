import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import type {AssemblyRun,AssemblyOp} from '../types';
import {appendAssemblyOperation,receiveAssemblyOperationRun} from './assemblyOperations';
const base:AssemblyRun={id:'run',batchName:'Recorded batch',cellType:'cylindrical',ops:[],cellsOut:7,cellsScrap:2,defects:['Historical observation'],workerId:'original',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};
const op:AssemblyOp={id:'operation',recordedAt:'2026-11-11T11:00:00Z',finishedAt:'2026-11-11T11:00:00Z',substation:'li-electrodes',workerId:'operator',qtyIn:10,qtyOut:8,qtyScrap:2,units:{input:'parts',output:'electrodes',scrap:'parts'},params:{},defects:['Entered defect']};
beforeEach(async()=>{await db.open();await db.assemblyRuns.add(base);});
afterEach(async()=>{db.close();await db.delete();});
it('commits an attributed operation and journal once, preserving historical totals without converting units',async()=>{
 const [a,b]=await Promise.all([appendAssemblyOperation(base,op,'operator'),appendAssemblyOperation(base,op,'operator')]);
 expect(a).toEqual(b);expect(a).toMatchObject({operationLedger:1,cellsOut:7,cellsScrap:2,defects:base.defects,ops:[op]});
 expect(await db.journal.count()).toBe(1);expect(await db.journal.get('operation')).toMatchObject({workerId:'operator',params:{'Единица входа':'parts','Единица выхода':'electrodes'}});
 db.close();await db.open();expect(await appendAssemblyOperation(base,op,'operator')).toEqual(a);
 await expect(appendAssemblyOperation(base,{...op,qtyOut:9},'operator')).rejects.toThrow();
});
it('rolls operation and journal back together and permits retry with the original ID',async()=>{
 const fail=()=>{throw Error('Journal failure');};db.journal.hook('creating',fail);
 try{await expect(appendAssemblyOperation(base,op,'operator')).rejects.toThrow('Journal failure');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.assemblyRuns.get('run')).toEqual(base);expect(await db.journal.count()).toBe(0);
 await appendAssemblyOperation(base,op,'operator');expect(await db.journal.count()).toBe(1);
});
it('rejects stale parallel intent without dropping history and requires a refreshed retry',async()=>{
 const saved=await appendAssemblyOperation(base,op,'operator');
 const second={...op,id:'second',substation:'winding' as const};
 await expect(appendAssemblyOperation(base,second,'operator')).rejects.toThrow('изменена');
 const current=await appendAssemblyOperation(saved,second,'operator');expect(current.ops).toEqual([op,second]);
 await db.assemblyRuns.add({...base,id:'other'});
 await expect(appendAssemblyOperation({...base,id:'other'},op,'operator')).rejects.toThrow();
});
it('validates units, actor, count and finite parameters and blocks protected intakes',async()=>{
 for(const invalid of [{...op,units:undefined},{...op,units:{input:'parts' as const}},{...op,qtyOut:1.5},{...op,params:{Power:Infinity}},{...op,workerId:'other'}])
  await expect(appendAssemblyOperation(base,invalid,'operator')).rejects.toThrow();
 await db.assemblyRuns.put({...base,intake:{sortRunId:'sorted',electrodeCount:10,recordedBy:'original',recordedAt:base.createdAt}});
 await expect(appendAssemblyOperation(base,op,'operator')).rejects.toThrow();
 expect(await db.journal.count()).toBe(0);
});
it('receipt permits only an identical replay or full append, retaining conflicting and stripped history',async()=>{
 const saved=await appendAssemblyOperation(base,op,'operator');expect(await receiveAssemblyOperationRun(saved)).toEqual(saved);
 for(const altered of [{...base,updatedAt:'2099-01-01'},{...saved,ops:[]},{...saved,cellsOut:100},{...saved,ops:[{...op,qtyOut:9}]},{...saved,operationLedger:undefined}])
  await expect(receiveAssemblyOperationRun(altered)).rejects.toThrow();
 const next={...op,id:'received'};const received={...saved,ops:[op,next],updatedAt:'2026-11-11T12:00:00Z'};
 expect((await receiveAssemblyOperationRun(received)).ops).toEqual([op,next]);
 await expect(receiveAssemblyOperationRun(saved)).rejects.toThrow();
 expect((await db.assemblyRuns.get('run'))?.ops).toEqual([op,next]);
});
it('preserves original legacy operations while adding observations and rejects fractional layer counts',async()=>{
 const legacy:AssemblyOp={substation:'winding',workerId:'old-operator',qtyIn:1.5,qtyOut:1,qtyScrap:0,params:{'Legacy measured value':2.5},defects:[]};
 const historical={...base,ops:[legacy]};await db.assemblyRuns.put(historical);
 const saved=await appendAssemblyOperation(historical,op,'operator');expect(saved.ops).toEqual([legacy,op]);
 expect(saved.cellsOut).toBe(base.cellsOut);
 await expect(appendAssemblyOperation(saved,{...op,id:'layers',substation:'z-stacking',params:{'Слоёв в стеке':2.5}},'operator')).rejects.toThrow();
});
