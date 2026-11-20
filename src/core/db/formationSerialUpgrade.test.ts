import Dexie from 'dexie';
import {afterEach,expect,it} from 'vitest';
import {db} from './index';
import {exportLocalBackup,restoreLocalBackup} from './localBackup';
import {UserRole} from '../types';
import {inventoryOutbox} from '../sync/inventoryOutbox';
afterEach(async()=>{db.close();await db.delete();inventoryOutbox.close();await inventoryOutbox.delete();});
it('adds the serial identity store to populated v22 while preserving every original main row and separate outbox',async()=>{
 db.close();await db.delete();const old=new Dexie(db.name),tables=db.tables.filter(t=>!['formationSerialIdentities','cellOutputClaims'].includes(t.name));
 old.version(22).stores(Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));
 const before=new Map<string,unknown[]>();await old.open();
 for(const table of old.tables){const key=table.schema.primKey.keyPath as string;await table.add({id:'retained-'+table.name,[key]:key==='sequence'?22:'retained-'+table.name,original:{state:'pending',scope:'original device',payload:['keep',0]},createdAt:new Date(123)});before.set(table.name,await table.toArray());}old.close();
 await inventoryOutbox.open();const proposal={key:'original-receipt',revision:1,operationId:'original-id',fields:{state:'pending',request:'original immutable body',epoch:'original-epoch'}};await inventoryOutbox.receivingDrafts.add(proposal);
 await db.open();expect(db.verno).toBe(24);expect(await db.formationSerialIdentities.count()).toBe(0);
 for(const[name,rows]of before)expect(await db.table(name).toArray(),name).toEqual(rows);
 expect(inventoryOutbox.verno).toBe(8);expect(await inventoryOutbox.receivingDrafts.get(proposal.key)).toEqual(proposal);
});
it('accepts a checksum-verified v22 local-only archive without requiring a new serial identity or changing original observations',async()=>{
 await db.open();await db.users.add({id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date(123)});
 const original={id:'original-formation',batchName:'Preserved historical observation',cellsIn:10,cellsOut:7,serialRange:{prefix:'ORIGINAL-',start:10,end:19}};await db.formationRuns.add(original as never);
 const archive=JSON.parse(await exportLocalBackup());archive.schemaVersion=22;archive.payload.tables=archive.payload.tables.filter(([name]:[string,unknown])=>!['formationSerialIdentities','cellOutputClaims'].includes(name));
 archive.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(archive.payload)))),b=>b.toString(16).padStart(2,'0')).join('');
 db.close();await db.delete();await restoreLocalBackup(JSON.stringify(archive));expect(await db.formationRuns.get(original.id)).toEqual(original);expect(await db.formationSerialIdentities.count()).toBe(0);
});
