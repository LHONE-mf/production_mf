import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../../core/db';
import type {CalenderRun} from '../../core/types';
import {saveCalenderResult,saveCalenderAssignment} from './calenderJournal';
const run:CalenderRun={id:'run',rollId:'run',gapsMm:[0.35],totalLengthM:10,thicknessAfterUm:80,hasDefects:false,workerId:'operator',createdAt:1,updatedAt:1};
const draft={gaps:'0,35; 0.28',totalLen:'12',thickAfter:'75',hasDef:false,defects:'',notes:'Measured result'};
beforeEach(async()=>{await db.open();await db.calenderRuns.add(run);});
afterEach(async()=>{db.close();await db.delete();});
it('commits a measured result and journal together and retains them after reopen',async()=>{
  const saved=await saveCalenderResult(run,draft,'operator','journal');
  expect(saved).toMatchObject({gapsMm:[0.35,0.28],totalLengthM:12,thicknessAfterUm:75});
  db.close();await db.open();expect(await db.calenderRuns.get('run')).toEqual(saved);
  expect(await db.journal.get('journal')).toMatchObject({params:{'Результат прокатки':'run','Толщина после, мкм':75}});
});
it('rolls back both writes if journal storage fails, then accepts retry',async()=>{
  const fail=()=>{throw new Error('Test journal failure');};db.journal.hook('creating',fail);
  try{await expect(saveCalenderResult(run,draft,'operator','journal')).rejects.toThrow('Test journal failure');}
  finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(await db.calenderRuns.get('run')).toEqual(run);expect(await db.journal.count()).toBe(0);
  await saveCalenderResult(run,draft,'operator','journal');expect(await db.journal.count()).toBe(1);
});
it('rejects concurrent and stale edits without rewriting the saved measurements',async()=>{
  const attempts=await Promise.allSettled([saveCalenderResult(run,draft,'operator','a'),saveCalenderResult(run,{...draft,thickAfter:'70'},'other','b')]);
  expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await db.journal.count()).toBe(1);
  const saved=await db.calenderRuns.get('run');
  await expect(saveCalenderResult(run,draft,'operator','c')).rejects.toThrow('изменена');
  expect(await db.calenderRuns.get('run')).toEqual(saved);
});
it.each([{gaps:'0,35 broken'},{gaps:'0'},{gaps:'-1'},{totalLen:''},{totalLen:'-2'},{thickAfter:'Infinity'}])('rejects invalid measurements %j without writing',async change=>{
  await expect(saveCalenderResult(run,{...draft,...change},'operator','bad')).rejects.toThrow();
  expect(await db.calenderRuns.get('run')).toEqual(run);expect(await db.journal.count()).toBe(0);
});
it('keeps assignments in IndexedDB without changing legacy cache or measured results',async()=>{
  localStorage.setItem('lip_calender_params_v1','{"legacy":{"targetThicknessUm":18}}');
  const roll={id:'run',mixName:'Measured roll',segLengthsM:[10],createdAt:1};
  await saveCalenderAssignment(roll,{targetThicknessUm:70,heating:false,edgeTrim:false},'tech');
  expect(await db.calenderRuns.get('run')).toMatchObject({totalLengthM:10,thicknessAfterUm:80,params:{targetThicknessUm:70}});
  expect(localStorage.getItem('lip_calender_params_v1')).toContain('18');
  await expect(saveCalenderResult(run,draft,'operator','stale')).rejects.toThrow('изменена');
  localStorage.removeItem('lip_calender_params_v1');
});
