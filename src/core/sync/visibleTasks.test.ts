import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { TaskPriority, TaskStatus, type Task } from '../types';
import { encodeTask } from './taskDto';
import { provisionOfflineTaskEditLease } from './offlineTaskLease';
import { listVisibleTasks } from './visibleTasks';

const deviceId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const orgId = '55555555-5555-4555-8555-555555555555';
const assignedId = '66666666-6666-4666-8666-666666666666';
const outsideId = '77777777-7777-4777-8777-777777777777';
const localId = 'demo-task-001';

function task(id: string, assignedTo = actorId, createdBy = otherId): Task {
  const now = new Date('2026-11-10T08:00:00Z');
  return {
    id, title: id, description: 'Confidential manufacturing task',
    status: TaskStatus.ASSIGNED, priority: TaskPriority.MEDIUM,
    assignedTo, createdBy, createdAt: now, updatedAt: now,
    comments: [], attachments: [],
  };
}

beforeEach(async () => {
  await db.open();
  await db.transaction('rw', [db.tasks, db.hybridTaskRevisions,
    db.hybridTaskOutbox, db.hybridTaskEditLeases], async () => {
    await db.tasks.clear();
    await db.hybridTaskRevisions.clear();
    await db.hybridTaskOutbox.clear();
    await db.hybridTaskEditLeases.clear();
  });
});

describe('screen-visible task scope', () => {
  it('hides cached server tasks without a grant and enforces an assigned worker snapshot across restart', async () => {
    await db.tasks.bulkPut([task(localId), task(assignedId), task(outsideId, otherId)]);
    await db.hybridTaskRevisions.bulkPut([
      { entityId: assignedId, revision: 1 }, { entityId: outsideId, revision: 2 },
    ]);
    expect((await listVisibleTasks()).map(item => item.id)).toEqual([localId]);
    await provisionOfflineTaskEditLease({
      deviceId, actorId, organizationId: orgId, role: 'worker',
      expiresAt: Date.now() + 120_000,
      authorizedTaskIds: [assignedId, outsideId],
    });
    expect((await listVisibleTasks()).map(item => item.id).sort()).toEqual([assignedId, localId].sort());
    db.close();
    await db.open();
    expect((await listVisibleTasks()).map(item => item.id).sort()).toEqual([assignedId, localId].sort());
    // A server refresh revoking assignment hides it without erasing history.
    await db.hybridTaskEditLeases.update('active', { authorizedTaskIds: [] });
    expect((await listVisibleTasks()).map(item => item.id)).toEqual([localId]);
    expect(await db.tasks.get(assignedId)).toBeDefined();
    await db.hybridTaskEditLeases.update('active', { expiresAt: Date.now() - 1 });
    expect((await listVisibleTasks()).map(item => item.id)).toEqual([localId]);
  });

  it('reveals own queued creation, but not another actor\'s unapproved creation', async () => {
    const ownId = '88888888-8888-4888-8888-888888888888';
    const foreignId = '99999999-9999-4999-8999-999999999999';
    const own = task(ownId, actorId, actorId);
    const foreign = task(foreignId, actorId, otherId);
    await db.tasks.bulkPut([own, foreign]);
    for (const [id, row] of [[ownId, own], [foreignId, foreign]] as const) {
      await db.hybridTaskOutbox.add({
        operationId: crypto.randomUUID(), deviceId,
        entityType: 'task', entityId: id, operationType: 'upsert',
        expectedRevision: 0, payload: encodeTask(row),
        queuedAt: Date.now(), state: 'pending',
      });
    }
    await provisionOfflineTaskEditLease({
      deviceId, actorId, organizationId: orgId, role: 'chief',
      expiresAt: Date.now() + 120_000, authorizedTaskIds: [],
    });
    expect((await listVisibleTasks()).map(item => item.id)).toEqual([ownId]);
    await db.hybridTaskEditLeases.clear();
    expect(await listVisibleTasks()).toEqual([]);
    expect(await db.hybridTaskOutbox.count()).toBe(2);
  });
});
