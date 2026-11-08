import type { TaskPayloadV1 } from './taskDto';
import { hybridOutbox, pendingTaskOperations } from './hybridOutbox';

export interface HybridSession {
  /** HTTPS origin of a trusted server. Never store bearer tokens in this module. */
  serverUrl: string;
  accessToken: string;
  /** Short-lived proof returned after a signed device challenge. Never persist it. */
  deviceProofToken?: string;
  deviceProofDeviceId?: string;
  deviceProofExpiresAt?: number;
}
export interface RemoteTaskChange {
  sequence: string | number;
  operation_id: string;
  entity_type: 'task';
  entity_id: string;
  revision: number;
  payload: TaskPayloadV1;
}
export type TaskChangeConsumer = (changes: RemoteTaskChange[]) => Promise<void>;

function endpoint(session: HybridSession, path: string): string {
  const base = new URL(session.serverUrl);
  if (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))
    throw new Error('Hybrid sync requires HTTPS outside localhost');
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== ''))
    throw new Error('Hybrid sync requires a server origin without credentials or path');
  return new URL(path, base).toString();
}
async function request(session: HybridSession, path: string, init?: RequestInit) {
  const response = await fetch(endpoint(session, path), {
    ...init,
    headers: { 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`Sync request failed: HTTP ${response.status}`);
  return response.json();
}

/** Never removes a queued mutation until the server acknowledges it. */
export async function pushPendingTasks(session: HybridSession) {
  const pendingAll = await pendingTaskOperations();
  const pending = pendingAll.filter(op => op.deviceId === pendingAll[0]?.deviceId).slice(0, 50);
  if (!pending.length) return { accepted: 0, conflicts: 0, rejected: 0 };
  if (!session.deviceProofToken || session.deviceProofDeviceId !== pending[0].deviceId || !session.deviceProofExpiresAt || session.deviceProofExpiresAt <= Date.now() + 5000)
    throw new Error('Fresh device proof for queued task device required before pushing tasks');
  const response = await request(session, '/sync/push', {
    method: 'POST',
    headers: { 'x-device-proof': session.deviceProofToken },
    body: JSON.stringify({ operations: pending.map(({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload }) => ({ operationId, deviceId, entityType, entityId, operationType, expectedRevision, payload })) }),
  });
  // A partial, duplicated or malformed acknowledgment must not discard offline edits.
  if (!Array.isArray(response.results) || response.results.length !== pending.length)
    throw new Error('Invalid sync response: incomplete results');
  const pendingIds = new Set(pending.map(op => op.operationId));
  const seen = new Set<string>();
  for (const result of response.results) {
    if (!result || typeof result.operationId !== 'string' ||
        !pendingIds.has(result.operationId) || seen.has(result.operationId))
      throw new Error('Invalid sync response: unexpected or duplicate operation');
    seen.add(result.operationId);
    if (result.status === 'accepted' || result.status === 'duplicate') {
      if (!Number.isSafeInteger(result.revision) || result.revision < 1)
        throw new Error('Invalid sync response: revision');
    } else if (result.status === 'conflict') {
      if (!Number.isSafeInteger(result.actualRevision) || result.actualRevision < 0)
        throw new Error('Invalid sync response: conflict revision');
    } else if (result.status !== 'rejected') {
      throw new Error('Invalid sync response: status');
    }
  }
  let accepted = 0, conflicts = 0, rejected = 0;
  await hybridOutbox.transaction('rw', hybridOutbox.operations, async () => {
    for (const result of response.results as Array<{ operationId: string; status: string; actualRevision?: number; reason?: string }>) {
      // A concurrent manual resolution may have changed the outbox while the request ran.
      const current = await hybridOutbox.operations.get(result.operationId);
      if (!current || current.state !== 'pending') continue;
      if (result.status === 'accepted' || result.status === 'duplicate') {
        await hybridOutbox.operations.delete(result.operationId);
        accepted++;
      } else if (result.status === 'conflict') {
        await hybridOutbox.operations.update(result.operationId, { state: 'conflict', actualRevision: result.actualRevision, rejectionReason: undefined });
        conflicts++;
      } else {
        await hybridOutbox.operations.update(result.operationId, { state: 'rejected', actualRevision: undefined, rejectionReason: result.reason || 'server_rejected' });
        rejected++;
      }
    }
  });
  return { accepted, conflicts, rejected };
}

/** Apply remote changes first; only then advance the durable cursor. */
export async function pullTaskChanges(session: HybridSession, applyChanges: TaskChangeConsumer) {
  const cursor = (await hybridOutbox.metadata.get('taskCursor'))?.value ?? 0;
  const response = await request(session, `/sync/pull?cursor=${cursor}&limit=100`);
  if (!Array.isArray(response.changes) || response.changes.length > 100 ||
      typeof response.hasMore !== 'boolean' ||
      !Number.isSafeInteger(Number(response.nextCursor)) || Number(response.nextCursor) < cursor)
    throw new Error('Invalid sync response: changes or cursor');
  const changes = response.changes as RemoteTaskChange[];
  const nextCursor = Number(response.nextCursor);
  if ((changes.length === 0 && nextCursor !== cursor) ||
      (changes.length > 0 && nextCursor !== Number(changes[changes.length - 1].sequence)))
    throw new Error('Invalid sync response: cursor does not match changes');
  let previousSequence = cursor;
  for (const change of changes) {
    if (!change || !Number.isSafeInteger(Number(change.sequence)) || Number(change.sequence) <= previousSequence ||
        change.entity_type !== 'task' || !Number.isSafeInteger(change.revision) || change.revision < 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.entity_id))
      throw new Error('Invalid sync response: unordered or invalid task change');
    previousSequence = Number(change.sequence);
  }
  // Consumer errors leave the durable cursor unchanged for a retry.
  await applyChanges(changes);
  await hybridOutbox.metadata.put({ key: 'taskCursor', value: nextCursor });
  return { received: changes.length, hasMore: response.hasMore };
}
