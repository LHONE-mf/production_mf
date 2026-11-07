import { db } from '../db';
import type { HybridSession, RemoteTaskChange } from './hybridClient';
import { decodeTask } from './taskDto';

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
  if (!pending.length) return { accepted: 0, conflicts: 0, rejected: 0 };
  const operations = pending.map(({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }) => ({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }));
  const response = await send(session, '/sync/push', { method: 'POST', body: JSON.stringify({ operations }) });
  let accepted = 0, conflicts = 0, rejected = 0;
  await db.transaction('rw', db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
    if (!Array.isArray(response.results)) throw new Error('Invalid sync response: missing results');
    for (const result of response.results as Array<{operationId:string;status:string;revision?:number;actualRevision?:number;reason?:string}>) {
      const item = pending.find(op => op.operationId === result.operationId);
      if (!item) continue;
      const current = await db.hybridTaskOutbox.get(item.operationId);
      if (!current) continue;
      if ((result.status === 'accepted' || result.status === 'duplicate') && Number.isInteger(result.revision) && result.revision! > 0) {
        await db.hybridTaskRevisions.put({ entityId: item.entityId, revision: result.revision! });
        await db.hybridTaskOutbox.delete(item.operationId);
        accepted++;
      } else if (result.status === 'rejected') {
        // Keep the operation for diagnosis and retry only after the cause is resolved.
        // Do not silently discard a locally saved assignment.
        await db.hybridTaskOutbox.update(item.operationId, { state: 'conflict', actualRevision: undefined, rejectionReason: result.reason || 'server_rejected' });
        rejected++;
      } else if (result.status === 'conflict') {
        await db.hybridTaskOutbox.update(item.operationId, { state: 'conflict', actualRevision: result.actualRevision, rejectionReason: undefined });
        conflicts++;
      }
    }
  });
  return { accepted, conflicts, rejected };
}

/**
 * Incoming changes are committed together with the cursor. Existing local task records
 * are never overwritten by this prototype: a conflicting local record requires migration.
 */
export async function pullAtomicTasks(session: HybridSession) {
  const cursor = (await db.hybridSyncMetadata.get('taskCursor'))?.value ?? 0;
  const response = await send(session, '/sync/pull?cursor=' + cursor + '&limit=100');
  if (!Array.isArray(response.changes) || !Number.isSafeInteger(Number(response.nextCursor)) || Number(response.nextCursor) < cursor) {
    throw new Error('Invalid sync response: changes or cursor');
  }
  const changes = response.changes as RemoteTaskChange[];
  await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridSyncMetadata, async () => {
    for (const change of changes) {
      if (change.entity_type !== 'task' || !Number.isSafeInteger(change.revision) || change.revision < 1) throw new Error('Invalid sync entity or revision');
      const queued = await db.hybridTaskOutbox.where('entityId').equals(change.entity_id).count();
      if (queued) throw new Error('Pending local edit blocks remote task ' + change.entity_id);
      const current = await db.tasks.get(change.entity_id);
      const knownRevision = (await db.hybridTaskRevisions.get(change.entity_id))?.revision ?? 0;
      if (current && knownRevision === 0) throw new Error('Unmanaged local task ID collision');
      if (knownRevision >= change.revision) continue;
      if (knownRevision !== 0 && knownRevision !== change.revision - 1) throw new Error('Revision gap: full reconciliation required');
      const task = decodeTask(change.entity_id, change.payload);
      await db.tasks.put(task);
      await db.hybridTaskRevisions.put({ entityId: task.id, revision: change.revision });
    }
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: Number(response.nextCursor) });
  });
  return { received: changes.length, hasMore: Boolean(response.hasMore) };
}
