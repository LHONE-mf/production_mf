import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {StageId,UserRole,type JournalEntry} from '../types';
import {saveStorageEvent,receiveStorageJournal,toStorageJournal,inspectStorageJournal,type StorageReceipt,type StorageLocation} from './storageReceipts';
import {applyPacket} from '../../transfer/apply';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let receipt:StorageReceipt;
beforeEach(async()=>{
 await db.open();await db.users.add({id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()});
 receipt={version:1,kind:'receipt',id:'storage:receipt',material:'Declared powder',materialReference:'MAT-7',supplier:'Supplier A',lotCode:'LOT-1',quantity:2.125,unit:'kg',location:'Shelf 7',evidence:'Received against document 17, recorded package weighing',actorId:'worker',actorRole:UserRole.WORKER,recordedAt:Date.now()};
});
afterEach(async()=>{db.close();await db.delete();});
const location=(r:StorageReceipt):StorageLocation=>({version:1,kind:'location',id:'storage:location',receiptId:r.id,previousEventId:r.id,fromLocation:r.location,location:'Shelf 8',evidence:'Observed placement at shelf 8',actorId:r.actorId,actorRole:r.actorRole,recordedAt:r.recordedAt+1});
it('saves one attributed receipt/journal, preserves legacy notes and reopens the exact append-only location history',async()=>{
 const old:JournalEntry={id:'legacy-note',stage:StageId.STORAGE,workerId:'old',createdAt:new Date(1),summary:'Historical note'};await db.journal.add(old);
 await saveStorageEvent(receipt,'worker');const moved=location(receipt);await saveStorageEvent(moved,'worker');db.close();await db.open();
 expect(await saveStorageEvent(receipt,'worker')).toEqual(receipt);expect(await saveStorageEvent(moved,'worker')).toEqual(moved);
 const register=inspectStorageJournal(await db.journal.toArray());expect(register.problems).toHaveLength(0);expect(register.lots).toHaveLength(1);expect(register.lots[0].history).toEqual([receipt,moved]);expect(register.lots[0].location).toBe('Shelf 8');expect(await db.journal.get(old.id)).toEqual(old);expect(await db.journal.get(receipt.id)).toEqual(toStorageJournal(receipt));
});
it('rejects missing/zero/negative/nonfinite quantities, fractional pieces, unsupported units, missing evidence and changed same-ID intent',async()=>{
 for(const patch of [{quantity:undefined},{quantity:0},{quantity:-1},{quantity:NaN},{quantity:Infinity},{quantity:1.1,unit:'pieces'},{unit:'tonnes'},{evidence:''},{material:''},{lotCode:''},{location:''},{actorRole:'foreign'},{recordedAt:0}])await expect(saveStorageEvent({...receipt,...patch} as StorageReceipt,'worker')).rejects.toThrow();
 expect(await db.journal.count()).toBe(0);await saveStorageEvent(receipt,'worker');await expect(saveStorageEvent({...receipt,quantity:3},'worker')).rejects.toThrow();expect(await db.journal.get(receipt.id)).toEqual(toStorageJournal(receipt));
});
it('rolls failed journal creation back and serializes competing receipt identities, with supplier uncertainty kept ambiguous',async()=>{
 const fail=()=>{throw Error('Storage write failed');};db.journal.hook('creating',fail);
 try{await expect(saveStorageEvent(receipt,'worker')).rejects.toThrow('Storage write failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.journal.count()).toBe(0);const results=await Promise.allSettled([saveStorageEvent(receipt,'worker'),saveStorageEvent({...receipt,id:'storage:other',lotCode:' lot-1 '},'worker')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await expect(saveStorageEvent({...receipt,id:'storage:unknown',supplier:undefined},'worker')).rejects.toThrow();await saveStorageEvent({...receipt,id:'storage:other-supplier',supplier:'Supplier B'},'worker');expect(inspectStorageJournal(await db.journal.toArray()).lots).toHaveLength(2);
});
it('rejects stale location branches, altered source/unit fields, inactive actors and competing successors',async()=>{
 await saveStorageEvent(receipt,'worker');const move=location(receipt);const results=await Promise.allSettled([saveStorageEvent(move,'worker'),saveStorageEvent({...move,id:'storage:competing',location:'Shelf 9'},'worker')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await expect(saveStorageEvent({...move,id:'storage:stale'},'worker')).rejects.toThrow();await expect(saveStorageEvent({...move,id:'storage:altered',quantity:4} as StorageLocation,'worker')).rejects.toThrow();
 await db.users.update('worker',{isActive:false});await expect(saveStorageEvent(receipt,'worker')).rejects.toThrow();
});
it('rejects missing parent, false prior location, earlier timestamp and altered journal envelopes without creating history',async()=>{
 await expect(saveStorageEvent(location(receipt),'worker')).rejects.toThrow();await saveStorageEvent(receipt,'worker');
 for(const patch of [{fromLocation:'Invented'},{recordedAt:receipt.recordedAt-1},{previousEventId:'unknown'}])await expect(saveStorageEvent({...location(receipt),...patch},'worker')).rejects.toThrow();
 await expect(receiveStorageJournal({...toStorageJournal(location(receipt)),workerId:'forged'},StageId.STORAGE,UserRole.MASTER,'master')).rejects.toThrow();expect(await db.journal.count()).toBe(1);
});
it('routes signed journal and forced packets through immutable history checks, including stripped markers',async()=>{
 const packet=(payload:unknown,type:'journal'|'forced-push'='journal')=>({v:1 as const,type,payload,stage:StageId.STORAGE,from:'master',role:UserRole.MASTER,forced:type==='forced-push',ts:Date.now()});
 const row=toStorageJournal(receipt);expect((await applyPacket(packet(row))).ok).toBe(true);expect((await applyPacket(packet(row,'forced-push'))).ok).toBe(false);
 for(const payload of [{...row,params:undefined},{...row,summary:'Altered'},{...row,params:{storageEvent:JSON.stringify({...receipt,quantity:9})}}])for(const type of ['journal','forced-push'] as const)expect((await applyPacket(packet(payload,type))).ok).toBe(false);
 expect((await applyPacket({...packet(toStorageJournal(location(receipt))),stage:StageId.SLURRY})).ok).toBe(false);expect(await db.journal.get(receipt.id)).toEqual(row);
});
it('keeps malformed or conflicting historical markers for review rather than promoting them to a trusted register',async()=>{
 await db.journal.add({...toStorageJournal(receipt),params:{storageEvent:'broken'}});const read=inspectStorageJournal(await db.journal.toArray());expect(read.lots).toHaveLength(0);expect(read.problems).toHaveLength(1);
 await expect(saveStorageEvent({...receipt,id:'storage:new',lotCode:'OTHER'},'worker')).rejects.toThrow();expect(await db.journal.count()).toBe(1);
});
