import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { db } from './index';
import { TaskPriority, TaskStatus, type Task } from '../types';

const taskId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';

afterEach(async () => {
  db.close();
  await db.delete();
});

/**
 * Recreate the relevant stores of a v17 installation (before the lease/inbox
 * migrations). Upgrading must add stores without clearing old manufacturing
 * data, queued edits, cursors or archived conflict evidence.
 */
it('preserves v17 local production records through the v18–v20 additive upgrades', async () => {
  db.close();
  await db.delete();
  const legacy = new Dexie('LiIonProductionDB');
  legacy.version(17).stores({
    tasks: 'id, status, assignedTo, createdBy, priority, updatedAt, stage',
    journal: 'id, stage, workerId, taskId, createdAt',
    hybridTaskOutbox: 'operationId, entityId, state, queuedAt',
    hybridTaskRevisions: 'entityId',
    hybridSyncMetadata: 'key',
    hybridTaskResolutions: 'id, entityId, archivedAt',
  });
  const task: Task = {
    id: taskId, title: 'Pre-upgrade work', description: 'Retain this record',
    status: TaskStatus.ASSIGNED, priority: TaskPriority.HIGH,
    assignedTo: '33333333-3333-4333-8333-333333333333',
    createdBy: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-11-08T10:00:00Z'),
    updatedAt: new Date('2026-11-08T10:00:00Z'),
    comments: [], attachments: [],
  };
  try {
    await legacy.open();
    await legacy.table('tasks').put(task);
    await legacy.table('journal').put({
      id: 'legacy-production-record', stage: 'coating',
      workerId: task.assignedTo, taskId: task.id, createdAt: new Date('2026-11-08T10:00:00Z'),
    });
    await legacy.table('hybridTaskOutbox').put({
      operationId: '55555555-5555-4555-8555-555555555555',
      deviceId, entityType: 'task', entityId: taskId, operationType: 'upsert',
      expectedRevision: 2, queuedAt: 1, state: 'conflict',
      actualRevision: 3, payload: { title: task.title },
    });
    await legacy.table('hybridTaskRevisions').put({ entityId: taskId, revision: 2 });
    await legacy.table('hybridSyncMetadata').put({ key: 'taskCursor', value: 17 });
    await legacy.table('hybridTaskResolutions').put({
      id: '66666666-6666-4666-8666-666666666666', entityId: taskId,
      archivedAt: 123456, decision: 'use_server',
      localTask: task, localOperations: [], serverRevision: 2,
      serverPayload: { title: task.title },
    });
  } finally {
    legacy.close();
  }

  await db.open();
  expect(db.verno).toBe(20);
  expect(await db.localFormDrafts.count()).toBe(0);
  expect((await db.tasks.get(taskId))?.title).toBe('Pre-upgrade work');
  expect((await db.journal.get('legacy-production-record'))?.stage).toBe('coating');
  expect((await db.hybridTaskOutbox.where('entityId').equals(taskId).first())?.state).toBe('conflict');
  expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(2);
  expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(17);
  expect((await db.hybridTaskResolutions.where('entityId').equals(taskId).first())?.decision).toBe('use_server');
  expect(await db.hybridTaskEditLeases.count()).toBe(0);
  expect(await db.hybridTaskDeferred.count()).toBe(0);

  await db.hybridTaskDeferred.put({
    sequence: 18, entityId: taskId,
    change: { sequence: '18', operation_id: '77777777-7777-4777-8777-777777777777',
      entity_type: 'task', entity_id: taskId, revision: 3,
      payload: { schemaVersion: 1, title: task.title } as never },
  });
  db.close();
  await db.open();
  expect((await db.hybridTaskDeferred.get(18))?.entityId).toBe(taskId);
  expect((await db.tasks.get(taskId))?.title).toBe('Pre-upgrade work');
});
