import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {StageId,UserRole} from '../types';
import {saveStorageEvent,inspectStorageJournal,type StorageReceipt,type StorageLocation} from './storageReceipts';
import {exportStorageHistory,receiveStorageHistory} from './storageReceipts';
import {applyPacket} from '../../transfer/apply';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let receipt:StorageReceipt,move:StorageLocation;
beforeEach(async()=>{
 await db.open();await db.users.add({id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()});const now=Date.now()-10;
 receipt={version:1,kind:'receipt',id:'storage:receipt',material:'Declared powder',lotCode:'LOT-1',quantity:2.125,unit:'kg',location:'Shelf 1',evidence:'Recorded package weighing',actorId:'worker',actorRole:UserRole.WORKER,recordedAt:now};
 move={version:1,kind:'location',id:'storage:move',receiptId:receipt.id,previousEventId:receipt.id,fromLocation:receipt.location,location:'Shelf 2',evidence:'Observed location',actorId:'worker',actorRole:UserRole.WORKER,recordedAt:now+1};await saveStorageEvent(receipt,'worker');await saveStorageEvent(move,'worker');
});
afterEach(async()=>{db.close();await db.delete();});
it('exports only the exact saved complete history without journal writes and rejects stale or inactive export',async()=>{
 const before=await db.journal.toArray();const fail=()=>{throw Error('Export must be read-only');};db.journal.hook('creating',fail);
 let packet;
 try{packet=await exportStorageHistory([receipt,move],'worker');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(packet.entries.map(row=>row.id)).toEqual([receipt.id,move.id]);expect(packet.latestEventId).toBe(move.id);expect(await db.journal.toArray()).toEqual(before);
 await expect(exportStorageHistory([receipt],'worker')).rejects.toThrow();await expect(exportStorageHistory([{...receipt,quantity:9},move],'worker')).rejects.toThrow();await db.users.update('worker',{isActive:false});await expect(exportStorageHistory([receipt,move],'worker')).rejects.toThrow();
});
it('imports a first receipt and all place predecessors atomically, then preserves exact replay and newer local history',async()=>{
 const packet=await exportStorageHistory([receipt,move],'worker');await db.journal.clear();const fail=(_key:unknown,row:{id:string})=>{if(row.id===move.id)throw Error('History import interrupted');};db.journal.hook('creating',fail);
 try{await expect(receiveStorageHistory(packet,StageId.STORAGE,UserRole.WORKER,'worker')).rejects.toThrow('History import interrupted');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.journal.count()).toBe(0);await receiveStorageHistory(packet,StageId.STORAGE,UserRole.WORKER,'worker');expect(inspectStorageJournal(await db.journal.toArray()).lots[0].history).toEqual([receipt,move]);
 const next={...move,id:'storage:next',previousEventId:move.id,fromLocation:move.location,location:'Shelf 3',recordedAt:move.recordedAt+1};await saveStorageEvent(next,'worker');await receiveStorageHistory(packet,StageId.STORAGE,UserRole.WORKER,'worker');expect(await db.journal.count()).toBe(3);expect(inspectStorageJournal(await db.journal.toArray()).lots[0].location).toBe('Shelf 3');
});
it('rejects broken/truncated/reordered/mixed chains, altered envelopes, bad sender/stage and divergent successors',async()=>{
 const packet=await exportStorageHistory([receipt,move],'worker');
 for(const patch of [{entries:packet.entries.slice(0,1)},{entries:[...packet.entries].reverse()},{latestEventId:'missing'},{receiptId:'missing'},{entries:[packet.entries[0],{...packet.entries[1],workerId:'forged'}]},{exportedRole:'foreign'},{storageHistoryVersion:2}])await expect(receiveStorageHistory({...packet,...patch} as typeof packet,StageId.STORAGE,UserRole.WORKER,'worker')).rejects.toThrow();
 await expect(receiveStorageHistory(packet,StageId.SLURRY,UserRole.WORKER,'worker')).rejects.toThrow();await expect(receiveStorageHistory(packet,StageId.STORAGE,UserRole.WORKER,'other')).rejects.toThrow();
 await db.journal.delete(move.id);await saveStorageEvent({...move,id:'storage:competing',location:'Shelf 9'},'worker');await expect(receiveStorageHistory(packet,StageId.STORAGE,UserRole.MASTER,'master')).rejects.toThrow();expect(await db.journal.get(move.id)).toBeUndefined();expect(await db.journal.count()).toBe(2);
});
it('uses identical safeguards for typed and generic forced saved-history packets',async()=>{
 const payload=await exportStorageHistory([receipt,move],'worker');const packet=(type:'storage-history'|'forced-push')=>({v:1 as const,type,payload,stage:StageId.STORAGE,from:'master',role:UserRole.MASTER,forced:type==='forced-push',ts:Date.now()});
 for(const type of ['storage-history','forced-push'] as const)expect((await applyPacket(packet(type))).ok).toBe(type!=='forced-push');
 for(const type of ['storage-history','forced-push'] as const)expect((await applyPacket({...packet(type),payload:{...payload,entries:payload.entries.slice(1)}})).ok).toBe(false);
});
