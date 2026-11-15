import {beforeEach,afterEach,it,expect} from 'vitest';
import {db} from './index';
import {UserRole} from '../types';
import {loadLocalDraft,saveLocalDraft} from './localFormDrafts';
beforeEach(async()=>{await db.open();await db.users.bulkAdd(['one','two'].map(id=>({id,login:id,fullName:id,password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()})));});
afterEach(async()=>{db.close();await db.delete();});
it('retains raw blanks/decimal commas and frozen retry identity across close/open, isolated by actor and room',async()=>{
 const payload={version:1,raw:['','0','2,125'],attempt:{id:'stable-attempt',createdAt:17}};
 const first=await saveLocalDraft('one','slurry',0,payload);db.close();await db.open();expect(await loadLocalDraft('one','slurry')).toEqual(first);
 expect(await loadLocalDraft('two','slurry')).toBeUndefined();expect(await loadLocalDraft('one','storage')).toBeUndefined();expect((await loadLocalDraft('one','slurry'))?.payload).toEqual(payload);expect(await db.journal.count()).toBe(0);
});
it('acknowledges a lost-reply retry but rejects competing intent and stale writers even after explicit clearing',async()=>{
 const first=await saveLocalDraft('one','slurry',0,{raw:'first'});expect(await saveLocalDraft('one','slurry',0,{raw:'first'})).toEqual(first);
 const writes=await Promise.allSettled([saveLocalDraft('one','slurry',1,{raw:'tab A'}),saveLocalDraft('one','slurry',1,{raw:'tab B'})]);expect(writes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const cleared=await saveLocalDraft('one','slurry',2,null);expect(cleared.revision).toBe(3);await expect(saveLocalDraft('one','slurry',0,{raw:'stale'})).rejects.toThrow();expect((await loadLocalDraft('one','slurry'))?.payload).toBeNull();
});
it('retains the last durable draft on storage failure and rejects inactive, malformed and unknown-version writes without deleting data',async()=>{
 const before=await saveLocalDraft('one','storage',0,{raw:'kept'});const fail=()=>{throw Error('Draft disk failure');};db.localFormDrafts.hook('updating',fail);
 try{await expect(saveLocalDraft('one','storage',1,{raw:'new'})).rejects.toThrow('Draft disk failure');}finally{db.localFormDrafts.hook('updating').unsubscribe(fail);}
 expect(await loadLocalDraft('one','storage')).toEqual(before);await db.users.update('one',{isActive:false});await expect(saveLocalDraft('one','storage',1,null)).rejects.toThrow();await db.users.update('one',{isActive:true});
 await db.localFormDrafts.update(before.key,{version:99 as 1});await expect(loadLocalDraft('one','storage')).rejects.toThrow();await expect(saveLocalDraft('one','storage',1,null)).rejects.toThrow();expect((await db.localFormDrafts.get(before.key))?.payload).toEqual(before.payload);
});
