import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { TaskPriority, TaskStatus, type SyncPacket, type Task } from '../core/types';
import { encodeTask } from '../core/sync/taskDto';
import { encodePacket, decodePacket } from './packet';

vi.mock('../core/security', () => ({
  hasWorkshopKey: () => true,
  signPacket: async () => 'test-only-signature',
}));

const serverTaskId = '11111111-1111-4111-8111-111111111111';
const actorId = '33333333-3333-4333-8333-333333333333';
const deviceId = '22222222-2222-4222-8222-222222222222';

function task(id = serverTaskId): Task {
  const now = new Date('2026-11-10T08:00:00Z');
  return {
    id, title: 'Production operation', description: 'Offline record',
    status: TaskStatus.ASSIGNED, priority: TaskPriority.MEDIUM,
    assignedTo: actorId, createdBy: actorId, createdAt: now, updatedAt: now,
    comments: [], attachments: [],
  };
}
function packet(type: SyncPacket['type'], payload: unknown): SyncPacket {
  return { v: 1, type, payload, from: actorId, ts: Date.now() };
}

beforeEach(async () => {
  await db.open();
  await db.transaction('rw', [db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox], async () => {
    await db.tasks.clear();
    await db.hybridTaskRevisions.clear();
    await db.hybridTaskOutbox.clear();
  });
});

describe('legacy QR/Bluetooth task export boundary', () => {
  it('refuses server task, status result, and forced task export with a known revision', async () => {
    const row = task();
    await db.tasks.put(row);
    await db.hybridTaskRevisions.put({ entityId: serverTaskId, revision: 4 });
    for (const candidate of [
      packet('task', row),
      packet('result', { taskId: serverTaskId, status: TaskStatus.CHECKED }),
      packet('forced-push', row),
    ]) {
      await expect(encodePacket(candidate)).rejects.toThrow('Серверное задание');
    }
    expect((await db.hybridTaskRevisions.get(serverTaskId))?.revision).toBe(4);
  });

  it('refuses queued server task creation even before a revision exists', async () => {
    const row = task();
    await db.hybridTaskOutbox.put({
      operationId: crypto.randomUUID(), deviceId, entityType: 'task',
      entityId: row.id, operationType: 'upsert', expectedRevision: 0,
      payload: encodeTask(row), state: 'pending', queuedAt: Date.now(),
    });
    await expect(encodePacket(packet('task', row))).rejects.toThrow('Серверное задание');
    expect(await db.hybridTaskOutbox.count()).toBe(1);
    db.close();
    await db.open();
    await expect(encodePacket(packet('result', { taskId: row.id, status: TaskStatus.CHECKED })))
      .rejects.toThrow('Серверное задание');
  });

  it('still signs and exports a local-only task', async () => {
    const outgoing = packet('task', task('local-demo'));
    const encoded = await encodePacket(outgoing);
    expect(encoded.startsWith('LIP:')).toBe(true);
    expect(decodePacket(encoded)?.type).toBe('task');
    expect(decodePacket(encoded)?.sig).toBe('test-only-signature');
  });
});
