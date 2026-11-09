import { db } from '../db';
import type { Task } from '../types';
import type { PendingTaskOperation } from './hybridOutbox';
import { decodeTask, type TaskPayloadV1 } from './taskDto';

/** Locally retained evidence of discarded queue entries during an explicit resolution.
 * Archive entries are never synchronized automatically or removed by this workflow. */
export interface ArchivedTaskConflict {
  id: string;
  entityId: string;
  archivedAt: number;
  decision: 'use_server';
  localTask: Task;
  localOperations: PendingTaskOperation[];
  serverRevision: number;
  serverPayload: TaskPayloadV1;
}

/** Explicitly adopt an inspected server snapshot while preserving all local edits.
 * The caller must re-fetch and verify the current server revision immediately
 * before choosing this action. A single Dexie transaction archives everything
 * before removing queued operations or replacing the local task. */
export async function archiveConflictAndUseServer(
  entityId: string, revision: number, payload: TaskPayloadV1,
): Promise<string> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid server task revision');
  const serverTask = decodeTask(entityId, payload);
  if (!Number.isFinite(serverTask.updatedAt.getTime()) ||
      !Number.isFinite(serverTask.createdAt.getTime())) throw new Error('Invalid server task dates');
  return db.transaction('rw',
    db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridTaskResolutions,
    async () => {
      const localTask = await db.tasks.get(entityId);
      const queued = await db.hybridTaskOutbox.where('entityId').equals(entityId).sortBy('queuedAt');
      if (!localTask || !queued.some(op => op.state === 'conflict')) {
        throw new Error('No unresolved task conflict remains');
      }
      if (queued.some(op => op.state === 'rejected')) {
        throw new Error('Resolve rejected task operations separately');
      }
      // Never resolve against a snapshot older than the revision reported by
      // the server when the conflict was detected. Such a snapshot could
      // discard local edits while leaving the task behind the server.
      if (queued.some(op => op.state === 'conflict' &&
          Number.isSafeInteger(op.actualRevision) && op.actualRevision! > revision)) {
        throw new Error('Server snapshot predates the reported conflict revision');
      }
      const knownRevision = (await db.hybridTaskRevisions.get(entityId))?.revision ?? 0;
      if (revision <= knownRevision) throw new Error('Server revision is not newer than the local revision');
      const id = crypto.randomUUID();
      await db.hybridTaskResolutions.add({
        id, entityId, archivedAt: Date.now(), decision: 'use_server',
        localTask, localOperations: queued, serverRevision: revision, serverPayload: payload,
      });
      await db.tasks.put(serverTask);
      await db.hybridTaskRevisions.put({ entityId, revision });
      await db.hybridTaskOutbox.bulkDelete(queued.map(op => op.operationId));
      return id;
    },
  );
}
