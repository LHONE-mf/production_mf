import {afterEach,describe,expect,it} from 'vitest';
import {db} from './index';
import {exportLocalBackup,restoreLocalBackup} from './localBackup';

afterEach(async()=>{db.close();await db.delete();});

describe('local backup/restore safety',()=>{
  it('preserves saved manufacturing records, drafts, dates and binary attachments through an exact offline round trip',async()=>{
    await db.open();
    const when=new Date('2026-11-12T07:00:00Z');
    const binary=new Uint8Array([0,9,255]).buffer;
    await db.table('users').put({id:'chief',login:'chief',fullName:'Operator',password:'pbkdf2$dummy',role:'chief',isActive:true,createdAt:when});
    await db.table('journal').put({id:'entry',stage:'storage',workerId:'chief',createdAt:when,params:{actual:0,unknown:null,bytes:binary}});
    await db.table('localFormDrafts').put({key:'chief:slurry',actorId:'chief',scope:'slurry',revision:1,payload:{raw:['','0','1,25']}});
    const saved=await exportLocalBackup();
    expect(saved).toContain('production-mf-local-backup');
    await db.transaction('rw',db.tables,async()=>{for(const table of db.tables)await table.clear();});
    await restoreLocalBackup(saved);
    expect(await db.users.count()).toBe(1);
    expect((await db.table('journal').get('entry')).createdAt).toEqual(when);
    expect(Array.from(new Uint8Array((await db.table('journal').get('entry')).params.bytes))).toEqual([0,9,255]);
    expect((await db.table('localFormDrafts').get('chief:slurry')).payload.raw).toEqual(['','0','1,25']);
  });

  it('rejects altered archives without writing a partial restore',async()=>{
    await db.open();
    await db.table('journal').put({id:'source',stage:'storage',createdAt:new Date(),workerId:'chief'});
    const saved=await exportLocalBackup();
    await db.journal.clear();
    const tampered=saved.replace('source','altered');
    await expect(restoreLocalBackup(tampered)).rejects.toThrow();
    expect(await db.journal.count()).toBe(0);
  });

  it('refuses to overwrite any existing local record',async()=>{
    await db.open();
    await db.table('journal').put({id:'source',stage:'storage',createdAt:new Date(),workerId:'chief'});
    const saved=await exportLocalBackup();
    await expect(restoreLocalBackup(saved)).rejects.toThrow();
    expect(await db.journal.count()).toBe(1);
  });

  it('never activates or transfers an old server task lease or queued sync operations',async()=>{
    await db.open();
    await db.table('hybridTaskOutbox').put({operationId:'pending',entityId:'t1',state:'pending',queuedAt:1});
    const saved=await exportLocalBackup();
    await db.hybridTaskOutbox.clear();
    await expect(restoreLocalBackup(saved)).rejects.toThrow(/синхрон|server/i);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });

  it('rejects unrecognized or incomplete backup formats instead of guessing',async()=>{
    await db.open();
    await expect(restoreLocalBackup('{"version":1}')).rejects.toThrow();
    await expect(restoreLocalBackup('not json')).rejects.toThrow();
    expect(await db.tables.reduce(async (p,table)=>(await p)+(await table.count()),Promise.resolve(0))).toBe(0);
  });
});
