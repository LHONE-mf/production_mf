import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { TaskPriority, TaskStatus, UserRole, type SyncPacket, type Task } from '../core/types';
import { encodeTask } from '../core/sync/taskDto';
import { applyPacket } from './apply';

// The transport signing policy is tested separately. Exercise only the
// already-authenticated QR/BLE dispatch and its Dexie ownership boundary.
vi.mock('../core/security', () => ({ verifyPacketSig: vi.fn(async () => true) }));

const taskId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
function task(id = taskId): Task {
  const now = new Date('2026-11-10T08:00:00Z');
  return {
    id, title: 'Protected server assignment', description: 'Before import',
    priority: TaskPriority.MEDIUM, status: TaskStatus.ASSIGNED,
    assignedTo: actorId, createdBy: actorId,
    createdAt: now, updatedAt: now, comments: [], attachments: [],
  };
}
function packet(type: SyncPacket['type'], payload: unknown, forced = false): SyncPacket {
  return {
    v: 1, type, payload, from: actorId,
    ts: Date.parse('2026-11-10T10:00:00Z'),
    forced, role: UserRole.MASTER, sig: 'test-only-transport-signature',
  };
}

beforeEach(async () => {
  await db.open();
  await db.transaction('rw', [db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox], async () => {
    await db.tasks.clear();
    await db.hybridTaskRevisions.clear();
    await db.hybridTaskOutbox.clear();
  });
});

describe('legacy packet boundary for authoritative server tasks', () => {
  it('rejects task, result, and forced packets for a known server revision across restart', async () => {
    await db.tasks.put(task());
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 4 });
    const attempted = [
      packet('task', { ...task(), title: 'QR replacement', updatedAt: new Date('2026-11-10T10:00:00Z') }),
      packet('result', { taskId, status: TaskStatus.COMPLETED }),
      packet('forced-push', { ...task(), title: 'Forced replacement' }, true),
    ];
    for (const incoming of attempted) {
      const result = await applyPacket(incoming);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Серверное задание');
      expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
      expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.ASSIGNED);
    }
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(4);
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
  });

  it('protects a first-upload task identified only by its pending outbox operation', async () => {
    const row = task();
    await db.tasks.put(row);
    await db.hybridTaskOutbox.add({
      operationId: crypto.randomUUID(), deviceId, entityType: 'task',
      entityId: taskId, operationType: 'upsert', expectedRevision: 0,
      payload: encodeTask(row), queuedAt: Date.now(), state: 'pending',
    });
    expect((await applyPacket(packet('task', { ...row, title: 'Unsafe overwrite' }))).ok).toBe(false);
    expect((await applyPacket(packet('forced-push', { ...row, title: 'Unsafe forced overwrite' }, true))).ok).toBe(false);
    expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
    expect(await db.hybridTaskOutbox.count()).toBe(1);
  });

  it('keeps the existing local-only QR task workflow available', async () => {
    const localTask = task('local-demo-task');
    await db.tasks.put(localTask);
    expect((await applyPacket(packet('task', { ...localTask, title: 'Legacy QR edit',
      updatedAt: new Date('2026-11-10T09:00:00Z') }))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.title).toBe('Legacy QR edit');
    expect((await applyPacket(packet('result', { taskId: localTask.id, status: TaskStatus.CHECKED }))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.status).toBe(TaskStatus.CHECKED);
    expect((await applyPacket(packet('forced-push', { ...localTask, title: 'Legacy forced edit' }, true))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.title).toBe('Legacy forced edit');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });
});

describe('explicit cutting instruction receipt',()=>{
  it('retains frozen instructions across duplicate and competing forced packets',async()=>{
    const id='cut-instruction-receipt';await db.cuttingRolls.delete(id);
    const payload={id,electrodeType:'prismatic',electrodeLengthMm:100,electrodeWidthMm:50,webWidthMm:120,
      roll:{id:'roll-receipt',mixName:'Fixture',segLengthsM:[10],createdAt:1},
      calender:{id,rollId:'roll-receipt',gapsMm:[0.35],totalLengthM:10,thicknessAfterUm:80,hasDefects:false,workerId:actorId,createdAt:1,updatedAt:1},
      thicknessAfterUm:80,instruction:{recordedBy:actorId,recordedAt:1,calenderUpdatedAt:1},createdAt:1};
    expect((await applyPacket({...packet('cutting-roll',payload),role:UserRole.WORKER})).ok).toBe(false);
    const attempts=await Promise.all([applyPacket(packet('cutting-roll',payload)),applyPacket(packet('cutting-roll',{...payload,electrodeWidthMm:60},true))]);
    expect(attempts.filter(r=>r.ok)).toHaveLength(1);
    const stored=await db.cuttingRolls.get(id);expect(stored).toBeDefined();
    expect((await applyPacket(packet('cutting-roll',stored))).ok).toBe(true);
    expect((await applyPacket(packet('cutting-roll',{...stored,electrodeLengthMm:200},true))).ok).toBe(false);
    expect((await applyPacket(packet('cutting-roll',{...stored,instruction:undefined},true))).ok).toBe(false);
    expect(await db.cuttingRolls.get(id)).toEqual(stored);
    await db.cuttingRolls.delete(id);
  });
});
