import { db } from '../db';
import type { HybridSession, RemoteTaskChange } from './hybridClient';
import { TaskPriority, TaskStatus, type Task } from '../types';

function urlFor(session: HybridSession, path: string) {
  const origin = new URL(session.serverUrl);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('HTTPS required');
  return new URL(path, origin).toString();
}
async function send(session: HybridSession, path: string, init?: RequestInit) {
  const response = await fetch(urlFor(session, path), { ...init, headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' } });
  if (!response.ok) throw new Error('Sync HTTP ' + response.status);
  return response.json();
}

/** Acknowledgements and revision metadata are committed atomically. */
export async function pushAtomicTasks(session: HybridSession) {
  const pending = (await db.hybridTaskOutbox.where('state').equals('pending').sortBy('queuedAt')).slice(0, 50);
  if (!pending.length) return { accepted: 0, conflicts: 0 };
  const operations = pending.map(({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }) => ({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }));
  const response = await send(session, '/sync/push', { method: 'POST', body: JSON.stringify({ operations }) });
  let accepted = 0, conflicts = 0;
  await db.transaction('rw', db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
    for (const result of response.results as Array<{operationId:string;status:string;revision?:number;actualRevision?:number}>) {
      const item = pending.find(op => op.operationId === result.operationId);
      if (!item) continue;
      const current = await db.hybridTaskOutbox.get(item.operationId);
      if (!current) continue;
      if ((result.status === 'accepted' || result.status === 'duplicate') && Number.isInteger(result.revision) && result.revision! > 0) {
        await db.hybridTaskRevisions.put({ entityId: item.entityId, revision: result.revision! });
        await db.hybridTaskOutbox.delete(item.operationId);
        accepted++;
      } else if (result.status === 'conflict') {
        await db.hybridTaskOutbox.update(item.operationId, { state: 'conflict', actualRevision: result.actualRevision });
        conflicts++;
      }
    }
  });
  return { accepted, conflicts };
}

/**
 * Incoming changes are committed together with the cursor. Existing local task records
 * are never overwritten by this prototype: a conflicting local record requires migration.
 */
export async function pullAtomicTasks(session: HybridSession) {
  const cursor = (await db.hybridSyncMetadata.get('taskCursor'))?.value ?? 0;
  const response = await send(session, '/sync/pull?cursor=' + cursor + '&limit=100');
  const changes = response.changes as RemoteTaskChange[];
  await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridSyncMetadata, async () => {
    for (const change of changes) {
      if (change.entity_type !== 'task') throw new Error('Unexpected sync entity');
      const queued = await db.hybridTaskOutbox.where('entityId').equals(change.entity_id).count();
      if (queued) throw new Error('Pending local edit blocks remote task ' + change.entity_id);
      const current = await db.tasks.get(change.entity_id);
      const knownRevision = (await db.hybridTaskRevisions.get(change.entity_id))?.revision ?? 0;
      if (current && knownRevision === 0) throw new Error('Unmanaged local task ID collision');
      if (knownRevision >= change.revision) continue;
      if (current && knownRevision !== change.revision - 1) throw new Error('Revision gap: full reconciliation required');
      const status = change.payload.status === 'pending' ? TaskStatus.ASSIGNED : change.payload.status === 'in_progress' ? TaskStatus.IN_PROGRESS : TaskStatus.COMPLETED;
      const task: Task = current ? { ...current, title: change.payload.title, status, assignedTo: change.payload.assigneeId ?? '', updatedAt: new Date() } : {
        id: change.entity_id, title: change.payload.title, description: '', status,
        priority: TaskPriority.MEDIUM, assignedTo: change.payload.assigneeId ?? '',
        createdBy: '', createdAt: new Date(), updatedAt: new Date(), comments: [], attachments: [],
      };
      await db.tasks.put(task);
      await db.hybridTaskRevisions.put({ entityId: task.id, revision: change.revision });
    }
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: Number(response.nextCursor) });
  });
  return { received: changes.length, hasMore: Boolean(response.hasMore) };
}
