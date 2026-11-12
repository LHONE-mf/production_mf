import {afterEach,describe,expect,it} from 'vitest';
import {Blob as NativeBlob} from 'node:buffer';
import {db} from './index';
import {exportLocalBackup,inspectLocalBackup,restoreLocalBackup} from './localBackup';

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
  it('round-trips a real Blob attachment with its MIME type',async()=>{
    // happy-dom's Blob is not recognized by Node's structuredClone in fake-indexeddb.
    // Use the native WHATWG Blob so this checks binary bytes, not a test-only clone artifact.
    const originalBlob=globalThis.Blob;
    globalThis.Blob=NativeBlob as unknown as typeof Blob;
    try {
    await db.open();
    await db.table('users').put({id:'chief',login:'chief',fullName:'Operator',password:'hash',role:'chief',isActive:true});
    await db.table('journal').put({id:'blob',stage:'storage',workerId:'chief',params:{
      attachment:new Blob([new Uint8Array([0,128,255])],{type:'application/octet-stream'}),
    }});
    const saved=await exportLocalBackup();
    await db.transaction('rw',db.tables,async()=>{for(const table of db.tables)await table.clear();});
    await restoreLocalBackup(saved);
    const attachment=(await db.table('journal').get('blob')).params.attachment as Blob;
    expect(attachment).toBeInstanceOf(Blob);
    expect(attachment.type).toBe('application/octet-stream');
    expect(Array.from(new Uint8Array(await attachment.arrayBuffer()))).toEqual([0,128,255]);
    } finally {
      globalThis.Blob=originalBlob;
    }
  });

  it('verifies a saved backup on a nonempty device without changing any local records',async()=>{
    await db.open();
    await db.table('users').put({id:'chief',login:'chief',fullName:'Operator',password:'hash',role:'chief',isActive:true});
    await db.table('journal').put({id:'receipt',stage:'storage',workerId:'chief'});
    const saved=await exportLocalBackup();
    const report=await inspectLocalBackup(saved);
    expect(report.createdAt).toMatch(/^2026-/);
    expect(report.tableCount).toBe(db.tables.length);
    expect(report.recordCount).toBe(2);
    expect(report.userCount).toBe(1);
    expect(await db.users.count()).toBe(1);
    expect(await db.journal.get('receipt')).toMatchObject({id:'receipt',stage:'storage'});
    // Inspection must not import an archive over existing records.
    await expect(restoreLocalBackup(saved)).rejects.toThrow(/пустую/i);
  });

  it('rejects tampering and server-sync archives during non-destructive file verification',async()=>{
    await db.open();
    await db.table('users').put({id:'chief',login:'chief',fullName:'Operator',password:'hash',role:'chief',isActive:true});
    await db.table('journal').put({id:'receipt',stage:'storage',workerId:'chief'});
    const good=await exportLocalBackup();
    await expect(inspectLocalBackup(good.replace('receipt','tampered'))).rejects.toThrow(/сумм/i);
    await db.table('hybridTaskOutbox').put({operationId:'pending',entityId:'t1',state:'pending',queuedAt:1});
    const unsafe=await exportLocalBackup();
    await expect(inspectLocalBackup(unsafe)).rejects.toThrow(/синхрон|server/i);
    expect(await db.table('journal').count()).toBe(1);
    expect(await db.table('hybridTaskOutbox').count()).toBe(1);
  });

  it('rolls back the entire restore if a row violates an IndexedDB key constraint',async()=>{
    await db.open();
    await db.table('users').put({id:'chief',login:'chief',fullName:'Operator',password:'hash',role:'chief',isActive:true});
    await db.table('journal').bulkPut([
      {id:'one',stage:'storage',workerId:'chief'},
      {id:'two',stage:'storage',workerId:'chief'},
    ]);
    const saved=await exportLocalBackup();
    const archive=JSON.parse(saved);
    const journals=archive.payload.tables.find(([name]:[string,unknown])=>name==='journal')[1];
    // Keep a valid checksum: simulate a structurally well-formed archive whose
    // two journal rows collide on the same primary key during bulkAdd.
    journals[1]=journals[0];
    const digest=await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(archive.payload)));
    archive.sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    await db.transaction('rw',db.tables,async()=>{for(const table of db.tables)await table.clear();});
    await expect(restoreLocalBackup(JSON.stringify(archive))).rejects.toThrow();
    expect(await db.users.count()).toBe(0);
    expect(await db.journal.count()).toBe(0);
  });

});
