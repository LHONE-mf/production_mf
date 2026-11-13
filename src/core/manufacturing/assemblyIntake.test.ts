import {beforeEach,afterEach,expect,it} from 'vitest';
import {db} from '../db';
import type {SortRun} from '../types';
import {takeAssemblySource,receiveAssemblyIntake} from './assemblyIntake';
const cut={id:'cut',incomingId:'roll',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec={id:'spec',cutRunId:'cut',batchName:'roll',electrodeType:'strip' as const,parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
const source:SortRun={id:'sorted',cutRunId:'cut',cutRunSnapshot:cut,specSnapshot:spec,specId:'spec',batchName:'roll',goodCount:10,buckets:[{categoryName:'A',count:8}],rejected:2,workerId:'sorter',createdAt:1,updatedAt:1};
beforeEach(async()=>{await db.open();await db.sortRuns.add(source);});
afterEach(async()=>{db.close();await db.delete();});
it('serializes full intake and resume, retains provenance and reopens without cell conversion',async()=>{
 const [a,b]=await Promise.all([takeAssemblySource(source,'assembler','a'),takeAssemblySource(source,'other','b')]);
 expect(a).toEqual(b);expect(a).toMatchObject({sourceSort:source,intake:{sortRunId:'sorted',electrodeCount:8},ops:[],cellsOut:0,cellType:'unassigned'});
 expect(await db.assemblyRuns.count()).toBe(1);expect(await db.journal.count()).toBe(1);
 db.close();await db.open();expect(await takeAssemblySource(source,'assembler','new-id')).toEqual(a);
});
it('rolls intake and journal back on failure and accepts retry',async()=>{
 const fail=()=>{throw Error('Journal unavailable');};db.journal.hook('creating',fail);
 try{await expect(takeAssemblySource(source,'assembler','a')).rejects.toThrow('Journal unavailable');}
 finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.assemblyRuns.count()).toBe(0);expect(await db.sortRuns.get('sorted')).toEqual(source);
 await takeAssemblySource(source,'assembler','a');expect(await db.journal.count()).toBe(1);
});
it('preserves legacy ambiguity and rejects stale or empty sources',async()=>{
 await db.sortRuns.update('sorted',{updatedAt:2});await expect(takeAssemblySource(source,'assembler','a')).rejects.toThrow('изменён');
 await db.sortRuns.put(source);
 const legacy={id:'legacy',batchName:'roll',cellType:'cylindrical' as const,ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId:'legacy',createdAt:'2026-01-01',updatedAt:'2026-01-01'};
 await db.assemblyRuns.add(legacy);await expect(takeAssemblySource(source,'assembler','a')).rejects.toThrow('неоднозначная');
 expect(await db.assemblyRuns.get('legacy')).toEqual(legacy);
 await expect(takeAssemblySource({...source,buckets:[],rejected:10},'assembler','a')).rejects.toThrow();
});
it('rejects duplicate imports, stripped provenance and fictitious cells',async()=>{
 const run=await takeAssemblySource(source,'assembler','a');expect(await receiveAssemblyIntake(run)).toEqual(run);
 for(const forged of [{...run,id:'b'},{...run,intake:undefined,sourceSort:undefined},{...run,cellsOut:4},{...run,defects:undefined as never},{...run,electrodesPerCell:2},{...run,cellType:'cylindrical' as const},{...run,ops:[{}] as never[]}])
  await expect(receiveAssemblyIntake(forged)).rejects.toThrow();
 expect(await db.assemblyRuns.get('a')).toEqual(run);
});
