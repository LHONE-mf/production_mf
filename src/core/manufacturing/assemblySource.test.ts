import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import type {AssemblyOp,SortRun} from '../types';
import {takeAssemblySource,receiveAssemblyIntake} from './assemblyIntake';
import {appendAssemblyOperation} from './assemblyOperations';
const cut={id:'cut',incomingId:'roll',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec={id:'spec',cutRunId:'cut',batchName:'roll',electrodeType:'strip' as const,parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
const source:SortRun={id:'sorted',cutRunId:'cut',cutRunSnapshot:cut,specSnapshot:spec,specId:'spec',batchName:'roll',goodCount:10,buckets:[{categoryName:'A',count:8}],rejected:2,workerId:'sorter',createdAt:1,updatedAt:1};
const first:AssemblyOp={id:'first',substation:'li-electrodes',workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:8,qtyOut:7,qtyScrap:1,units:{input:'electrodes',output:'electrodes',scrap:'electrodes'},params:{},defects:[],source:{kind:'intake',sortRunId:'sorted'}};
beforeEach(async()=>{await db.open();await db.sortRuns.add(source);});
afterEach(async()=>{db.close();await db.delete();});
it('links a whole intake to an observation then its exact remaining output to an explicit predecessor',async()=>{
 const base=await takeAssemblySource(source,'operator','job');
 const saved=await appendAssemblyOperation(base,first,'operator');
 expect(saved).toMatchObject({sourceLedger:1,intake:base.intake,sourceSort:source,cellsOut:0});
 const next={...first,id:'next',substation:'winding' as const,qtyIn:7,qtyOut:6,source:{kind:'operation' as const,operationId:'first'}};
 const continued=await appendAssemblyOperation(saved,next,'operator');expect(continued.ops).toEqual([first,next]);
 expect(await takeAssemblySource(source,'other','duplicate')).toEqual(continued);
 db.close();await db.open();expect(await receiveAssemblyIntake(continued)).toEqual(continued);
});
it('rejects missing, cross-run, self/future, mismatched and already allocated sources',async()=>{
 const base=await takeAssemblySource(source,'operator','job');
 for(const op of [{...first,source:undefined},{...first,qtyIn:9},{...first,units:{input:'parts' as const,output:'parts' as const,scrap:'parts' as const}}, {...first,source:{kind:'operation' as const,operationId:'first'}},{...first,source:{kind:'intake' as const,sortRunId:'other'}}, {...first,source:{kind:'declared' as const,reference:'external'}}])await expect(appendAssemblyOperation(base,op,'operator')).rejects.toThrow();
 const saved=await appendAssemblyOperation(base,first,'operator');
 await expect(appendAssemblyOperation(saved,{...first,id:'double'},'operator')).rejects.toThrow();
 const bad={...first,id:'child',qtyIn:7,qtyOut:6,source:{kind:'operation' as const,operationId:'missing'}};
 await expect(appendAssemblyOperation(saved,bad,'operator')).rejects.toThrow();
 expect((await db.assemblyRuns.get(base.id))?.ops).toEqual([first]);
});
it('serializes competing allocations and preserves a full history against forced receipt bypass',async()=>{
 const base=await takeAssemblySource(source,'operator','job');
 const results=await Promise.allSettled([appendAssemblyOperation(base,first,'operator'),appendAssemblyOperation(base,{...first,id:'competing'},'operator')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const saved=(await db.assemblyRuns.get(base.id))!;
 await expect(receiveAssemblyIntake({...saved,ops:[...saved.ops,{...first,id:'duplicate'}]})).rejects.toThrow();
 await expect(receiveAssemblyIntake({...saved,sourceLedger:undefined})).rejects.toThrow();
 await expect(receiveAssemblyIntake({...saved,id:'new-job'})).rejects.toThrow();
 expect(await db.assemblyRuns.count()).toBe(1);
});
it('requires an exact same-unit partition or an entered basis for differing units',async()=>{
 const base=await takeAssemblySource(source,'operator','job');
 await expect(appendAssemblyOperation(base,{...first,qtyOut:8},'operator')).rejects.toThrow();
 const changed={...first,qtyOut:2,units:{...first.units,output:'blocks' as const}};
 await expect(appendAssemblyOperation(base,changed,'operator')).rejects.toThrow();
 const declared={...changed,conversionNote:'Operator recorded block count separately; no calculated rate'};
 const saved=await appendAssemblyOperation(base,declared,'operator');expect(saved.ops).toEqual([declared]);expect(saved.cellsOut).toBe(0);
});
it('rejects reuse of a declared external reference across jobs and preserves older unlinked history',async()=>{
 const legacy={id:'legacy',batchName:'old batch',cellType:'cylindrical' as const,ops:[],cellsOut:7,cellsScrap:0,defects:[],workerId:'old',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};
 await db.assemblyRuns.add(legacy);await db.assemblyRuns.add({...legacy,id:'other',batchName:'other batch'});
 const declared={...first,source:{kind:'declared' as const,reference:'external-lot'},id:'declared'};
 const saved=await appendAssemblyOperation(legacy,declared,'operator');
 await expect(appendAssemblyOperation({...legacy,id:'other',batchName:'other batch'},{...declared,id:'different-op'},'operator')).rejects.toThrow('Внешний источник');
 const oldOp={...first,id:'old',source:undefined};
 const historical={...legacy,id:'historical',operationLedger:1 as const,ops:[oldOp]};await db.assemblyRuns.add(historical);
 expect(await receiveAssemblyIntake(historical)).toEqual(historical);
 await expect(receiveAssemblyIntake({...historical,ops:[oldOp,{...oldOp,id:'new-unlinked'}]})).rejects.toThrow();
 expect((await db.assemblyRuns.get(saved.id))?.ops).toEqual([declared]);
});
