import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import type {CutRun,SortSpec} from '../types';
import {saveSortingAllocation,receiveSortingAllocation} from './sortingAllocation';
const source:CutRun={id:'cut',incomingId:'roll',electrodeType:'strip',goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec:SortSpec={id:'spec',batchName:'roll',cutRunId:'cut',electrodeType:'strip',parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
const result={id:'allocation',buckets:[{categoryName:'A',count:8}],rejected:2};
beforeEach(async()=>{await db.open();await db.cuttingRuns.add(source);await db.sortSpecs.add(spec);});
afterEach(async()=>{db.close();await db.delete();});
it('freezes the exact cut run and specification, acknowledges retries and reopens unchanged',async()=>{
 const saved=await saveSortingAllocation(source,spec,result,'sorter');
 expect(saved).toMatchObject({cutRunId:'cut',cutRunSnapshot:source,specSnapshot:spec,goodCount:10});
 expect(await saveSortingAllocation(source,spec,result,'sorter')).toEqual(saved);
 db.close();await db.open();expect(await db.sortRuns.get(saved.id)).toEqual(saved);
 await expect(saveSortingAllocation(source,spec,{...result,id:'another'},'sorter')).rejects.toThrow('уже');
});
it.each([{buckets:[{categoryName:'A',count:8.5}],rejected:1.5},{buckets:[{categoryName:'A',count:11}],rejected:-1},
 {buckets:[{categoryName:'A',count:9}],rejected:0},{buckets:[{categoryName:'Other',count:10}],rejected:0},
 {buckets:[{categoryName:'A',count:8,avgThicknessUm:-1}],rejected:2}])('rejects invalid partitions %j',async change=>{
 await expect(saveSortingAllocation(source,spec,{...result,...change},'sorter')).rejects.toThrow();expect(await db.sortRuns.count()).toBe(0);
});
it('allows all-reject records without inventing missing average measurements',async()=>{
 const saved=await saveSortingAllocation(source,spec,{...result,buckets:[],rejected:10},'sorter');
 expect(saved.buckets).toEqual([]);expect(saved.rejected).toBe(10);
});
it('serializes competing allocations and protects receipt even when bypassing transport freshness',async()=>{
 const attempts=await Promise.allSettled([saveSortingAllocation(source,spec,result,'sorter'),saveSortingAllocation(source,spec,{...result,id:'other'},'another')]);
 expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.sortRuns.count()).toBe(1);
 const [saved]=await db.sortRuns.toArray();expect(await receiveSortingAllocation(saved)).toEqual(saved);
 await expect(receiveSortingAllocation({...saved,id:'received-duplicate'})).rejects.toThrow();
 await expect(receiveSortingAllocation({...saved,buckets:[{categoryName:'A',count:7}],rejected:3})).rejects.toThrow();
 await expect(receiveSortingAllocation({...saved,id:'legacy-bypass',cutRunId:undefined,cutRunSnapshot:undefined,specSnapshot:undefined})).rejects.toThrow();
 expect(await db.sortRuns.get(saved.id)).toEqual(saved);
});
it('rejects stale sources and ambiguous legacy history without deleting it',async()=>{
 await db.cuttingRuns.update('cut',{goodCount:11});await expect(saveSortingAllocation(source,spec,result,'sorter')).rejects.toThrow('изменена');
 await db.cuttingRuns.put(source);
 const legacy={...result,specId:'old-spec',batchName:'roll',goodCount:10,workerId:'legacy-worker',createdAt:1,updatedAt:1};
 await db.sortRuns.add(legacy);await expect(saveSortingAllocation(source,spec,{...result,id:'new'},'sorter')).rejects.toThrow('неоднозначная');
 expect(await db.sortRuns.get(legacy.id)).toEqual(legacy);
});
it('rolls back failed writes and accepts the retained request ID on retry',async()=>{
 const fail=()=>{throw new Error('Sorting storage failure');};db.sortRuns.hook('creating',fail);
 try{await expect(saveSortingAllocation(source,spec,result,'sorter')).rejects.toThrow('storage failure');}
 finally{db.sortRuns.hook('creating').unsubscribe(fail);}
 expect(await db.sortRuns.count()).toBe(0);await saveSortingAllocation(source,spec,result,'sorter');expect(await db.sortRuns.count()).toBe(1);
});

it('does not invent a mean for an empty category',async()=>{
 await expect(saveSortingAllocation(source,spec,{...result,buckets:[{categoryName:'A',count:0,avgMassG:1}],rejected:10},'sorter')).rejects.toThrow('пустой');
});

it('allows distinct cut runs from the same roll but keeps each allocation unique',async()=>{
 await saveSortingAllocation(source,spec,result,'sorter');
 const second={...source,id:'cut-2'},secondSpec={...spec,id:'spec-2',cutRunId:'cut-2'};
 await db.cuttingRuns.add(second);await db.sortSpecs.add(secondSpec);
 await saveSortingAllocation(second,secondSpec,{...result,id:'second'},'sorter');
 expect(await db.sortRuns.count()).toBe(2);
});

it('acknowledges an exact historical retry but rejects new writes under a stale specification',async()=>{
 const saved=await saveSortingAllocation(source,spec,result,'sorter');
 await db.sortSpecs.update('spec',{updatedAt:2,categories:[{name:'B',criteria:'New criterion'}]});
 expect(await saveSortingAllocation(source,spec,result,'sorter')).toEqual(saved);
 await expect(saveSortingAllocation(source,spec,{...result,id:'new'},'sorter')).rejects.toThrow('изменена');
 expect(await db.sortRuns.get(saved.id)).toEqual(saved);
});
