import { db } from '../db';
import type { Task } from '../types';
import { encodeTask } from './taskDto';
import type { PendingTaskOperation } from './hybridOutbox';

function requireUuid(id: string, field: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(field + ' must be a UUID. Demo records cannot be synchronized.');
  }
}

/**
 * Opt-in write path for server-managed tasks only.
 * One transaction guarantees that a local task edit cannot be committed without its outbox entry.
 * Repeated edits create consecutive, immutable revision-checked operations. Never
 * rewrite an existing operation: it may have reached the server already.
 * Existing demo/local tasks are deliberately not enrolled automatically.
 */
export async function saveServerManagedTask(task: Task, deviceId: string): Promise<string> {
  requireUuid(task.id, 'task.id');
  requireUuid(deviceId, 'deviceId');
  if (task.assignedTo) requireUuid(task.assignedTo, 'task.assignedTo');
  const payload = encodeTask(task);
  return db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
    const outstanding = await db.hybridTaskOutbox.where('entityId').equals(task.id).toArray();
    // Keep every edit as a distinct immutable operation. An in-flight request may
    // already contain an earlier snapshot, so overwriting its payload/ID is unsafe.
    if (outstanding.some(op => op.state !== 'pending' || op.deviceId !== deviceId))
      throw new Error('Resolve the previous task edit or device mismatch first');
    const revision = (await db.hybridTaskRevisions.get(task.id))?.revision ?? 0;
    // A UUID alone does not establish server ownership. Never silently enroll
    // or replace an existing local-only task that has no server revision or queue.
    if (revision === 0 && outstanding.length === 0 && await db.tasks.get(task.id)) {
      throw new Error('Existing local-only task cannot be enrolled automatically');
    }
    const expectedRevision = revision + outstanding.length;
    if (!Number.isSafeInteger(expectedRevision)) throw new Error('Task revision overflow');
    const queuedAt = Math.max(Date.now(), ...outstanding.map(op => op.queuedAt + 1));
    const operationId = crypto.randomUUID();
    const operation: PendingTaskOperation = {
      operationId, deviceId, entityType: 'task', entityId: task.id,
      operationType: 'upsert', expectedRevision,
      payload,
      queuedAt, state: 'pending',
    };
    await db.tasks.put(task);
    await db.hybridTaskOutbox.add(operation);
    return operationId;
  });
}

export async function countHybridPending() {
  return db.hybridTaskOutbox.where('state').equals('pending').count();
}
export async function listHybridConflicts() {
  return db.hybridTaskOutbox.where('state').equals('conflict').toArray();
}
