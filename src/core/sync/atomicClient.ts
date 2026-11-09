import { db } from '../db';
import type { HybridSession, RemoteTaskChange } from './hybridClient';
import { decodeTask } from './taskDto';
import { requireFreshDeviceProof } from './deviceProofClient';

function urlFor(session: HybridSession, path: string) {
  const origin = new URL(session.serverUrl);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('HTTPS required');
  // The sync URL is an origin, never an arbitrary endpoint. Reject embedded
  // credentials, paths, query parameters and fragments before sending bearer tokens.
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Sync server URL must be an origin without credentials or path');
  return new URL(path, origin).toString();
}
async function send(session: HybridSession, path: string, init?: RequestInit) {
  const response = await fetch(urlFor(session, path), { ...init, headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error('Sync HTTP ' + response.status);
  return response.json();
}

/** Acknowledgements and revision metadata are committed atomically. */
export async function pushAtomicTasks(session: HybridSession) {
  const queued = await db.hybridTaskOutbox.toArray();
  const blockedTasks = new Set(
    queued.filter(op => op.state === 'conflict' || op.state === 'rejected').map(op => op.entityId),
  );
  // At most one in-flight operation per task. Later offline edits depend on
  // its acknowledgement and must never race past a conflict or rejection.
  const pendingAll = queued.filter(op => op.state === 'pending' && !blockedTasks.has(op.entityId))
    .sort((a, b) => a.queuedAt - b.queuedAt || a.operationId.localeCompare(b.operationId));
  const firstDevice = pendingAll[0]?.deviceId;
  const seenTasks = new Set<string>();
  const pending = pendingAll.filter(op => {
    if (op.deviceId !== firstDevice || seenTasks.has(op.entityId)) return false;
    seenTasks.add(op.entityId);
    return true;
  }).slice(0, 50);
  if (!pending.length) return { accepted: 0, conflicts: 0, rejected: 0 };
  const operations = pending.map(({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }) => ({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }));
  if (!session.deviceProofToken || session.deviceProofDeviceId !== pending[0].deviceId || !session.deviceProofExpiresAt || session.deviceProofExpiresAt <= Date.now() + 5000)
    throw new Error('Fresh device proof for queued task device required before pushing tasks');
  const response = await send(session, '/sync/push', { method: 'POST', headers: { 'x-device-proof': session.deviceProofToken }, body: JSON.stringify({ operations }) });
  let accepted = 0, conflicts = 0, rejected = 0;
  // Validate the entire acknowledgement before changing any local queue or revision state.
  // A truncated, duplicated or malformed server reply must leave offline edits intact.
  if (!Array.isArray(response.results) || response.results.length !== pending.length) throw new Error('Invalid sync response: incomplete results');
  const pendingIds = new Set(pending.map(op => op.operationId));
  const seen = new Set<string>();
  for (const result of response.results) {
    if (!result || typeof result.operationId !== 'string' || !pendingIds.has(result.operationId) || seen.has(result.operationId))
      throw new Error('Invalid sync response: unexpected or duplicate operation');
    seen.add(result.operationId);
    if (result.status === 'accepted' || result.status === 'duplicate') {
      const queued = pending.find(op => op.operationId === result.operationId)!;
      if (!Number.isSafeInteger(result.revision) || result.revision < 1 ||
          result.revision !== (queued.expectedRevision ?? 0) + 1)
        throw new Error('Invalid sync response: revision does not match queued precondition');
    } else if (result.status === 'conflict') {
      if (!Number.isSafeInteger(result.actualRevision) || result.actualRevision < 0) throw new Error('Invalid sync response: conflict revision');
    } else if (result.status === 'rejected') {
      if (result.actualRevision !== undefined &&
          (!Number.isSafeInteger(result.actualRevision) || result.actualRevision < 0))
        throw new Error('Invalid sync response: rejection revision');
    } else throw new Error('Invalid sync response: status');
  }
  await db.transaction('rw', db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
    for (const result of response.results as Array<{operationId:string;status:string;revision?:number;actualRevision?:number;reason?:string}>) {
      const item = pending.find(op => op.operationId === result.operationId);
      if (!item) continue;
      const current = await db.hybridTaskOutbox.get(item.operationId);
      if (!current) continue;
      if (current.state !== 'pending') continue;
      // The response acknowledges the exact snapshot sent over the network.
      // If an operation was changed while in flight, retain it rather than
      // deleting or rejecting an unacknowledged local edit.
      if (current.deviceId !== item.deviceId || current.entityId !== item.entityId ||
          current.entityType !== item.entityType || current.operationType !== item.operationType ||
          current.expectedRevision !== item.expectedRevision ||
          JSON.stringify(current.payload) !== JSON.stringify(item.payload)) {
        throw new Error('Queued task operation changed during sync; acknowledgement not applied');
      }
      if ((result.status === 'accepted' || result.status === 'duplicate') && Number.isInteger(result.revision) && result.revision! > 0) {
        // A delayed acknowledgement must never roll back a newer revision that
        // was recorded while this request was in flight.
        const known = (await db.hybridTaskRevisions.get(item.entityId))?.revision ?? 0;
        if (result.revision! > known) {
          await db.hybridTaskRevisions.put({ entityId: item.entityId, revision: result.revision! });
        }
        await db.hybridTaskOutbox.delete(item.operationId);
        accepted++;
      } else if (result.status === 'rejected') {
        // Keep the operation for diagnosis and retry only after the cause is resolved.
        // Do not silently discard a locally saved assignment.
        await db.hybridTaskOutbox.update(item.operationId, { state: 'rejected', actualRevision: result.actualRevision, rejectionReason: result.reason || 'server_rejected' });
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
  const proof = requireFreshDeviceProof(session);
  const cursor = (await db.hybridSyncMetadata.get('taskCursor'))?.value ?? 0;
  const response = await send(session, '/sync/pull?cursor=' + cursor + '&limit=100&deviceId=' + encodeURIComponent(proof.deviceId), {
    headers: { 'x-device-proof': proof.token },
  });
  if (!Array.isArray(response.changes) || !Number.isSafeInteger(Number(response.nextCursor)) || Number(response.nextCursor) < cursor) {
    throw new Error('Invalid sync response: changes or cursor');
  }
  const changes = response.changes as RemoteTaskChange[];
  const nextCursor = Number(response.nextCursor);
  // The cursor is a durable checkpoint. Never advance it past changes actually
  // delivered by the server, or a malformed response could silently skip tasks.
  if (changes.length > 100 || typeof response.hasMore !== 'boolean' ||
      (changes.length === 0 && nextCursor !== cursor) ||
      (changes.length > 0 && nextCursor !== Number(changes[changes.length - 1].sequence))) {
    throw new Error('Invalid sync response: cursor does not match delivered changes');
  }
  let previousSequence = cursor;
  for (const change of changes) {
    if (!Number.isSafeInteger(Number(change.sequence)) || Number(change.sequence) <= previousSequence ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.entity_id)) {
      throw new Error('Invalid sync response: unordered changes or task ID');
    }
    previousSequence = Number(change.sequence);
  }
  await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridSyncMetadata, async () => {
    // Two manual pulls can overlap. A slow, older response must not replace
    // the cursor (or records) committed by a newer response in the meantime.
    const durableCursor = (await db.hybridSyncMetadata.get('taskCursor'))?.value ?? 0;
    if (durableCursor !== cursor) throw new Error('Concurrent task pull: cursor advanced; retry');
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
