import { db } from '../db';
import type { Task } from '../types';
import { requireOfflineTaskEditLease } from './offlineTaskLease';

/**
 * Shared tasks can remain in IndexedDB after server access is revoked. All
 * screens showing task titles, descriptions or aggregate task counts must use
 * this view instead of reading db.tasks directly.
 *
 * A still-valid, server-provisioned, device-bound offline lease supplies the
 * visibility snapshot. Local-only demo records retain their existing behavior.
 * Never delete hidden records: rejected offline edits may need recovery.
 */
export async function listVisibleTasks(): Promise<Task[]> {
  return db.transaction('r',
    [db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox, db.hybridTaskEditLeases],
    async () => {
      const [tasks, revisions, queued] = await Promise.all([
        db.tasks.toArray(),
        db.hybridTaskRevisions.toArray(),
        db.hybridTaskOutbox.toArray(),
      ]);
      const serverIds = new Set([
        ...revisions.map(record => record.entityId),
        ...queued.map(record => record.entityId),
      ]);
      const newlyCreated = new Set(
        queued.filter(op => op.expectedRevision === 0).map(op => op.entityId),
      );
      // Invalid/expired grants reveal zero server-owned records. A failed
      // grant check must never turn into an unfiltered task list.
      const lease = await requireOfflineTaskEditLease().catch(() => null);
      const allowed = new Set(lease?.authorizedTaskIds ?? []);
      return tasks.filter(task => {
        if (!serverIds.has(task.id)) return true;
        if (!lease) return false;
        if (!allowed.has(task.id) &&
            !(newlyCreated.has(task.id) && task.createdBy === lease.actorId)) return false;
        return lease.role !== 'worker' || task.assignedTo === lease.actorId;
      });
    },
  );
}
