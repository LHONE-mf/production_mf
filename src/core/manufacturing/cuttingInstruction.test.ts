import {afterEach,beforeEach,expect,it} from 'vitest';
import {db} from '../db';
import {UserRole} from '../types';
import {saveCuttingInstruction,validateCuttingIncoming} from './cuttingInstruction';
const actor={id:'tech',role:UserRole.TECHNOLOGIST};
const input={electrodeType:'prismatic' as const,electrodeLengthMm:100,electrodeWidthMm:50,webWidthMm:120};
beforeEach(async()=>{await db.open();await db.rollSpecs.add({id:'roll',mixName:'Measured roll',segLengthsM:[10],createdAt:1});
 await db.calenderRuns.add({id:'source',rollId:'roll',gapsMm:[0.35],totalLengthM:10,thicknessAfterUm:80,hasDefects:false,workerId:'operator',createdAt:1,updatedAt:1});});
afterEach(async()=>{db.close();await db.delete();});
it('persists explicit instruction, source and author across reopen and concurrent retries',async()=>{
 const [saved,retry]=await Promise.all([saveCuttingInstruction('source',1,input,actor),saveCuttingInstruction('source',1,input,actor)]);
 expect(saved).toEqual(retry);expect(saved).toMatchObject({...input,instruction:{recordedBy:'tech',calenderUpdatedAt:1},calender:{totalLengthM:10}});
 db.close();await db.open();expect(await db.cuttingRolls.get('source')).toEqual(saved);expect(await db.cuttingRolls.count()).toBe(1);
 await expect(saveCuttingInstruction('source',1,{...input,electrodeWidthMm:60},actor)).rejects.toThrow('другое');
 expect(await db.cuttingRolls.get('source')).toEqual(saved);
});
it.each([{electrodeLengthMm:0},{webWidthMm:NaN},{electrodeWidthMm:121},{electrodeType:'unknown'}])('rejects invalid instructions %j',async change=>{
 await expect(saveCuttingInstruction('source',1,{...input,...change} as typeof input,actor)).rejects.toThrow();expect(await db.cuttingRolls.count()).toBe(0);
});
it('rejects worker, stale and defective sources without creating a handover',async()=>{
 await expect(saveCuttingInstruction('source',1,input,{...actor,role:UserRole.WORKER})).rejects.toThrow();
 await expect(saveCuttingInstruction('source',2,input,actor)).rejects.toThrow('изменён');
 await db.calenderRuns.update('source',{hasDefects:true});await expect(saveCuttingInstruction('source',1,input,actor)).rejects.toThrow();
 expect(await db.cuttingRolls.count()).toBe(0);
});
it('validates received provenance rather than trusting a new packet tag',async()=>{
 const saved=await saveCuttingInstruction('source',1,input,actor);
 expect(()=>validateCuttingIncoming({...saved,instruction:{...saved.instruction!,calenderUpdatedAt:2}})).toThrow();
 expect(()=>validateCuttingIncoming({...saved,electrodeType:'invalid' as 'strip'})).toThrow();
 expect(()=>validateCuttingIncoming({...saved,calender:{...saved.calender!,workerId:''}})).toThrow();
});

it('rolls back a failed handover write and retains the source for retry',async()=>{
 const fail=()=>{throw new Error('Instruction storage unavailable');};db.cuttingRolls.hook('creating',fail);
 try{await expect(saveCuttingInstruction('source',1,input,actor)).rejects.toThrow('storage unavailable');}
 finally{db.cuttingRolls.hook('creating').unsubscribe(fail);}
 expect(await db.cuttingRolls.count()).toBe(0);expect((await db.calenderRuns.get('source'))?.updatedAt).toBe(1);
 await saveCuttingInstruction('source',1,input,actor);expect(await db.cuttingRolls.count()).toBe(1);
});
