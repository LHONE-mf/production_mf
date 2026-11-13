import {beforeEach,afterEach,expect,it} from 'vitest';
import {db} from '../db';
import type {CutRun,SortSpec} from '../types';
import {startSortingWorkflow,recordSortingStation,completeSortingWorkflow} from './sortingWorkflow';

const cut:CutRun={id:'cut-1',incomingId:'roll-1',electrodeType:'strip',goodCount:100,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec:SortSpec={id:'spec-1',cutRunId:'cut-1',batchName:'roll-1',electrodeType:'strip',parameterName:'Mass',unit:'g',categories:[
 {name:'A',criteria:'Mass grade A',minMass:1,maxMass:1.5},
 {name:'B',criteria:'Mass grade B',minMass:1.5,maxMass:2},
],authorId:'tech',createdAt:1,updatedAt:1};
beforeEach(async()=>{await db.open();await db.cuttingRuns.add(cut);await db.sortSpecs.add(spec);});
afterEach(async()=>{db.close();await db.delete();});
const visual={station:'visual' as const,passedCount:97,rejectedCount:3,workerId:'inspector-1',rejectionReasons:[{reason:'Coating defects',count:3}]};
const thickness={station:'thickness' as const,passedCount:95,rejectedCount:2,workerId:'inspector-2'};
const gradedMass={station:'mass' as const,passedCount:92,rejectedCount:3,workerId:'inspector-3',grades:[{categoryName:'A',count:62},{categoryName:'B',count:30}]};

it('records three ordered independent inspections and derives graded mass output from actual counts',async()=>{
 const started=await startSortingWorkflow(cut,spec,'grading','planner');
 expect(started).toMatchObject({id:'cut-1',mode:'grading',stages:[],cutRunSnapshot:cut,specSnapshot:spec});
 await recordSortingStation(started.id,visual);
 await recordSortingStation(started.id,thickness);
 const mass=await recordSortingStation(started.id,gradedMass);
 expect(mass.stages.map(s=>[s.station,s.inputCount,s.passedCount,s.rejectedCount])).toEqual([
  ['visual',100,97,3],['thickness',97,95,2],['mass',95,92,3]]);
 const saved=await completeSortingWorkflow(started.id,'final-1');
 expect(saved).toMatchObject({id:'final-1',cutRunId:'cut-1',goodCount:100,rejected:8,buckets:[{categoryName:'A',count:62},{categoryName:'B',count:30}],
  sortingWorkflow:{mode:'grading',finalizedSortRunId:'final-1'}});
 expect(saved.workerId).toBe('inspector-3');
 expect(await completeSortingWorkflow(started.id,'final-1')).toEqual(saved);
 expect((await db.sortingWorkflows.get(started.id))?.finalizedSortRunId).toBe('final-1');
 await expect(completeSortingWorkflow(started.id,'different-final')).rejects.toThrow();
 await expect(recordSortingStation(started.id,{...gradedMass,station:'visual'})).rejects.toThrow();
 db.close();await db.open();
 expect(await db.sortRuns.get('final-1')).toEqual(saved);
 expect((await db.sortingWorkflows.get('cut-1'))?.stages).toHaveLength(3);
});

it('supports batch-specific pass/fail without assigning a mass grade',async()=>{
 const workflow=await startSortingWorkflow(cut,spec,'pass-fail','planner');
 await recordSortingStation(workflow.id,visual);
 await recordSortingStation(workflow.id,thickness);
 await recordSortingStation(workflow.id,{station:'mass',passedCount:94,rejectedCount:1,workerId:'inspector-3'});
 const final=await completeSortingWorkflow(workflow.id,'binary-final');
 expect(final).toMatchObject({rejected:6,buckets:[{categoryName:'PASS',count:94}],sortingWorkflow:{mode:'pass-fail'}});
});

it('requires Visual, then Thickness, then Mass; no failed electrode reaches the next station',async()=>{
 const workflow=await startSortingWorkflow(cut,spec,'grading','planner');
 await expect(recordSortingStation(workflow.id,thickness)).rejects.toThrow();
 await expect(recordSortingStation(workflow.id,{...visual,passedCount:98})).rejects.toThrow();
 await expect(recordSortingStation(workflow.id,{...visual,rejectedCount:3.5})).rejects.toThrow();
 expect((await db.sortingWorkflows.get(workflow.id))?.stages).toEqual([]);
 await recordSortingStation(workflow.id,visual);
 await expect(recordSortingStation(workflow.id,{...thickness,passedCount:96})).rejects.toThrow();
 await expect(recordSortingStation(workflow.id,{...visual,rejectedCount:2,passedCount:98})).rejects.toThrow();
 await recordSortingStation(workflow.id,thickness);
 await expect(recordSortingStation(workflow.id,{...gradedMass,grades:[{categoryName:'A',count:90},{categoryName:'B',count:3}]})).rejects.toThrow();
 await expect(completeSortingWorkflow(workflow.id,'premature')).rejects.toThrow();
 expect(await db.sortRuns.count()).toBe(0);
});

it('requires mass grades only at final Mass station in grading mode, not in pass/fail mode',async()=>{
 const graded=await startSortingWorkflow(cut,spec,'grading','planner');
 await recordSortingStation(graded.id,visual);
 await recordSortingStation(graded.id,thickness);
 for(const bad of [
  {...gradedMass,grades:undefined},
  {...gradedMass,grades:[{categoryName:'A',count:92}]},
  {...gradedMass,grades:[{categoryName:'A',count:62},{categoryName:'A',count:30}]},
  {...gradedMass,grades:[{categoryName:'Unknown',count:92}]},
  {...gradedMass,grades:[{categoryName:'A',count:62.5},{categoryName:'B',count:29.5}]},
  {...gradedMass,rejectionReasons:[{reason:'bad mass',count:2}]},
 ])await expect(recordSortingStation(graded.id,bad)).rejects.toThrow();
 await recordSortingStation(graded.id,gradedMass);
 expect((await db.sortingWorkflows.get(graded.id))?.stages).toHaveLength(3);
});

it('supports exact retries but prevents silent changes to decisions and starting mode',async()=>{
 const workflow=await startSortingWorkflow(cut,spec,'grading','planner');
 expect(await startSortingWorkflow(cut,spec,'grading','planner')).toEqual(workflow);
 await recordSortingStation(workflow.id,visual);
 const saved=await recordSortingStation(workflow.id,visual);
 expect(saved.stages).toHaveLength(1);
 await expect(recordSortingStation(workflow.id,{...visual,rejectionReasons:[]})).rejects.toThrow();
 await expect(startSortingWorkflow(cut,spec,'pass-fail','planner')).rejects.toThrow();
 await expect(startSortingWorkflow(cut,{...spec,updatedAt:2},'grading','planner')).rejects.toThrow();
 await expect(startSortingWorkflow({...cut,id:'new-cut'},spec,'grading','planner')).rejects.toThrow();
});

it('rejects ambiguous preexisting sort history and stale source/spec at start',async()=>{
 await db.cuttingRuns.update(cut.id,{goodCount:101});
 await expect(startSortingWorkflow(cut,spec,'grading','planner')).rejects.toThrow();
 await db.cuttingRuns.put(cut);
 await db.sortSpecs.update(spec.id,{updatedAt:2});
 await expect(startSortingWorkflow(cut,spec,'grading','planner')).rejects.toThrow();
 await db.sortSpecs.put(spec);
 await db.sortRuns.add({id:'old',specId:'spec-1',batchName:'roll-1',goodCount:100,buckets:[{categoryName:'A',count:100}],rejected:0,workerId:'legacy',createdAt:1,updatedAt:1});
 await expect(startSortingWorkflow(cut,spec,'grading','planner')).rejects.toThrow();
 expect(await db.sortingWorkflows.count()).toBe(0);
});

it('rejects incomplete or invalid grading rules and protected one-step allocations',async()=>{
 await expect(startSortingWorkflow(cut,{...spec,categories:[{name:'A',criteria:'no mass bounds'}]},'grading','planner')).rejects.toThrow();
 const wf=await startSortingWorkflow(cut,spec,'grading','planner');
 const {saveSortingAllocation}=await import('./sortingAllocation');
 await expect(saveSortingAllocation(cut,spec,{id:'legacy-run',buckets:[{categoryName:'A',count:100}],rejected:0},'operator')).rejects.toThrow();
 expect(await db.sortRuns.count()).toBe(0);
 expect(await db.sortingWorkflows.get(wf.id)).toBeDefined();
});

it('rolls back a failed station/final write and allows safe retry',async()=>{
 const wf=await startSortingWorkflow(cut,spec,'grading','planner');
 const fail=()=>{throw Error('TEST-workflow-storage-failed');};
 db.sortingWorkflows.hook('updating',fail);
 try{await expect(recordSortingStation(wf.id,visual)).rejects.toThrow('TEST-workflow-storage-failed');}
 finally{db.sortingWorkflows.hook('updating').unsubscribe(fail);}
 expect((await db.sortingWorkflows.get(wf.id))?.stages).toEqual([]);
 await recordSortingStation(wf.id,visual);
 await recordSortingStation(wf.id,thickness);
 await recordSortingStation(wf.id,gradedMass);
 db.sortingWorkflows.hook('updating',fail);
 try{await expect(completeSortingWorkflow(wf.id,'final-1')).rejects.toThrow('TEST-workflow-storage-failed');}
 finally{db.sortingWorkflows.hook('updating').unsubscribe(fail);}
 expect(await db.sortRuns.count()).toBe(0);
 expect((await db.sortingWorkflows.get(wf.id))?.finalizedSortRunId).toBeUndefined();
 expect((await completeSortingWorkflow(wf.id,'final-1')).id).toBe('final-1');
});

it('does not merge distinct mass grades when Assembly has no grade-specific intake yet',async()=>{
 const workflow=await startSortingWorkflow(cut,spec,'grading','planner');
 await recordSortingStation(workflow.id,visual);
 await recordSortingStation(workflow.id,thickness);
 await recordSortingStation(workflow.id,gradedMass);
 const final=await completeSortingWorkflow(workflow.id,'graded-for-assembly');
 const {takeAssemblySource}=await import('./assemblyIntake');
 await expect(takeAssemblySource(final,'assembler','assembly-intake')).rejects.toThrow(/сорт|категор|grade/i);
 expect(await db.assemblyRuns.count()).toBe(0);
});
it('passes station-bound summaries through packet validation without inventing measurement averages',async()=>{
 const workflow=await startSortingWorkflow(cut,spec,'grading','planner');
 await recordSortingStation(workflow.id,visual);
 await recordSortingStation(workflow.id,thickness);
 await recordSortingStation(workflow.id,gradedMass);
 const saved=await completeSortingWorkflow(workflow.id,'for-receipt');
 const {receiveSortingAllocation}=await import('./sortingAllocation');
 await db.sortRuns.delete(saved.id);
 await db.sortingWorkflows.delete(workflow.id); // new receiver: source snapshots travel with the packet
 await expect(receiveSortingAllocation({...saved,rejected:7})).rejects.toThrow();
 await expect(receiveSortingAllocation({...saved,buckets:[{categoryName:'A',count:63},{categoryName:'B',count:29}]})).rejects.toThrow();
 expect(await receiveSortingAllocation(saved)).toEqual(saved);
});
