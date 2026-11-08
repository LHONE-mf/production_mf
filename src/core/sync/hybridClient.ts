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
  if (base.protocol !== 'https:' && !(base.hostname === 'localhost' || base.hostname === '127.0.0.1')) {
    throw new Error('Hybrid sync requires HTTPS outside localhost');
  }
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
  let accepted = 0, conflicts = 0, rejected = 0;
  for (const result of response.results as Array<{operationId:string;status:string;actualRevision?:number}>) {
    if (!pending.some(p => p.operationId === result.operationId)) continue;
    if (result.status === 'accepted' || result.status === 'duplicate') {
      await hybridOutbox.operations.delete(result.operationId);
      accepted++;
    } else if (result.status === 'conflict') {
      await hybridOutbox.operations.update(result.operationId, { state: 'conflict', actualRevision: result.actualRevision });
      conflicts++;
    } else rejected++;
  }
  return { accepted, conflicts, rejected };
}

/** Apply remote changes first; only then advance the durable cursor. */
export async function pullTaskChanges(session: HybridSession, applyChanges: TaskChangeConsumer) {
  const cursor = (await hybridOutbox.metadata.get('taskCursor'))?.value ?? 0;
  const response = await request(session, `/sync/pull?cursor=${cursor}&limit=100`);
  const changes = response.changes as RemoteTaskChange[];
  await applyChanges(changes);
  await hybridOutbox.metadata.put({ key: 'taskCursor', value: Number(response.nextCursor) });
  return { received: changes.length, hasMore: Boolean(response.hasMore) };
}
