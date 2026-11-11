import { afterEach, describe, expect, it } from 'vitest';
import { db, initializeDatabase, clearLocalDatabase } from './index';
import { AuthService } from '../../modules/auth/services/AuthService';
import { verifyPassword } from '../security';
import { UserRole, TaskPriority, TaskStatus } from '../types';

afterEach(async()=>{
  db.close();
  await db.delete();
});

describe('clean manufacturing first-run',()=>{
  it('does not populate example users, batches, journals, tasks or templates on a fresh device or restart',async()=>{
    expect(await initializeDatabase()).toBe(false);
    for(const table of db.tables)expect(await table.count(),table.name).toBe(0);
    db.close();
    expect(await initializeDatabase()).toBe(false);
    for(const table of db.tables)expect(await table.count(),table.name).toBe(0);
  });

  it('automatically purges a legacy demo-only device, including cached server task changes',async()=>{
    await db.open();
    await db.users.bulkPut([{
      id:'chief-001',login:'chief',fullName:'Demo Chief',password:'admin123',
      role:UserRole.CHIEF,createdAt:new Date(),isActive:true,
    },{
      id:'master-001',login:'master',fullName:'Demo Master',password:'master123',
      role:UserRole.MASTER,createdAt:new Date(),isActive:true,
    }]);
    await db.tasks.put({
      id:'task-001',title:'Demo job',description:'sample',status:TaskStatus.CREATED,
      priority:TaskPriority.LOW,assignedTo:'master-001',createdBy:'chief-001',
      createdAt:new Date(),updatedAt:new Date(),comments:[],attachments:[],
    });
    await db.table('mixComponents').put({
      id:'mc-lfp',name:'Example LFP',kind:'active',updatedAt:1,
    });
    await db.table('journal').put({
      id:'jr-001',workerId:'master-001',stage:'slurry',
      summary:'Sample mixing',createdAt:new Date(),
    });
    await db.table('hybridTaskOutbox').put({
      operationId:'test-outbox',entityId:'task-001',state:'pending',queuedAt:1,
    });
    expect(await initializeDatabase()).toBe(true);
    for(const table of db.tables)expect(await table.count(),table.name).toBe(0);
    expect(await initializeDatabase()).toBe(false);
    for(const table of db.tables)expect(await table.count(),table.name).toBe(0);
  });

  it('does not silently purge an installation containing a real local user',async()=>{
    await db.open();
    await db.users.bulkPut([{
      id:'chief-001',login:'chief',fullName:'Demo Chief',password:'admin123',
      role:UserRole.CHIEF,createdAt:new Date(),isActive:true,
    },{
      id:'real-admin',login:'operator',fullName:'Real local chief',password:'placeholder',
      role:UserRole.CHIEF,createdAt:new Date(),isActive:true,
    }]);
    expect(await initializeDatabase()).toBe(false);
    expect(await db.users.count()).toBe(2);
    // Legacy plaintext passwords on preserved installations are migrated.
    expect((await db.users.get('real-admin'))?.password.startsWith('pbkdf2$')).toBe(true);
  });

  it('creates only one user-selected first local chief with a salted password hash',async()=>{
    await initializeDatabase();
    const chief=await AuthService.createFirstLocalAdmin({
      fullName:'Production Chief',login:'Chief.Real',
      password:'unique-long-local-pass',
    });
    expect(chief.login).toBe('chief.real');
    expect(chief.role).toBe(UserRole.CHIEF);
    expect(chief.id).not.toBe('chief-001');
    expect(chief.password.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('unique-long-local-pass',chief.password)).toBe(true);
    expect(await AuthService.login('chief.real','unique-long-local-pass')).toMatchObject({
      id:chief.id,role:UserRole.CHIEF,
    });
    await expect(AuthService.createFirstLocalAdmin({
      fullName:'Another Chief',login:'other',password:'another-long-local-pass',
    })).rejects.toThrow('Первый пользователь уже создан');
    expect(await db.users.count()).toBe(1);
    expect(await db.tasks.count()).toBe(0);
    db.close();
    expect(await initializeDatabase()).toBe(false);
    expect(await db.users.count()).toBe(1);
  });

  it('rejects invalid initial identity and reset removes all local tables without re-seeding',async()=>{
    await initializeDatabase();
    await expect(AuthService.createFirstLocalAdmin({
      fullName:'A',login:'a',password:'short',
    })).rejects.toThrow();
    expect(await db.users.count()).toBe(0);
    await AuthService.createFirstLocalAdmin({
      fullName:'Actual Admin',login:'actual',password:'1234567890strong',
    });
    await db.table('mixComponents').put({id:'component-1',name:'Actual test',kind:'binder',updatedAt:1});
    await clearLocalDatabase();
    for(const table of db.tables)expect(await table.count(),table.name).toBe(0);
    expect(await initializeDatabase()).toBe(false);
    expect(await db.users.count()).toBe(0);
  });

  it('hashes subsequently added local users before storing them',async()=>{
    await initializeDatabase();
    const id=await AuthService.createUser({
      login:'worker-local',fullName:'Operator',password:'worker-long-secret',
      role:UserRole.WORKER,isActive:true,
    });
    const user=await db.users.get(id);
    expect(user?.password).not.toBe('worker-long-secret');
    expect(await verifyPassword('worker-long-secret',user!.password)).toBe(true);
    await AuthService.updateUser(id,{password:'replacement-secret'});
    expect(await verifyPassword('replacement-secret',(await db.users.get(id))!.password)).toBe(true);
  });
});
