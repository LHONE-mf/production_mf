import Dexie from 'dexie';
import {afterEach,it,expect} from 'vitest';
import {db} from './index';
import {UserRole} from '../types';
import {saveLocalDraft} from './localFormDrafts';
afterEach(async()=>{db.close();await db.delete();});
it('upgrades a v19 installation with production history and pending sync to v21 without changing any existing store row',async()=>{
 db.close();await db.delete();const legacy=new Dexie('LiIonProductionDB');
 // Reconstruct pre-v20 stores: v20 adds localFormDrafts, v21 adds sortingWorkflows.
 const stores=Object.fromEntries(db.tables.filter(t=>!['localFormDrafts','sortingWorkflows'].includes(t.name)).map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(index=>index.src)].join(',')]));
 legacy.version(19).stores(stores);const before:Record<string,unknown[]>={};
 try{
  await legacy.open();
  for(const table of legacy.tables){
   const key=table.schema.primKey.keyPath as string;
   await table.add({id:'retained-'+table.name,[key]:key==='sequence'?19:'retained-'+table.name,retained:'original production/sync payload',stage:'storage',params:{unmarkedLegacy:'preserve'},createdAt:new Date(123),payload:{raw:'unchanged'},state:'pending'});
   before[table.name]=await table.toArray();
  }
  await legacy.table('users').put({id:'actor',login:'actor',fullName:'Actor',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date(123)});before.users=await legacy.table('users').toArray();
 }finally{legacy.close();}
 await db.open();expect(db.verno).toBe(21);expect(await db.localFormDrafts.count()).toBe(0);expect(await db.sortingWorkflows.count()).toBe(0);
 for(const [name,rows]of Object.entries(before))expect(await db.table(name).toArray(),name).toEqual(rows);
 await saveLocalDraft('actor','slurry',0,{version:1,raw:['','0','2,125']});db.close();await db.open();expect(await db.localFormDrafts.count()).toBe(1);
 for(const [name,rows]of Object.entries(before))expect(await db.table(name).toArray(),name).toEqual(rows);
});
