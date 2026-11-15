import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hybridOutbox, type PendingTaskOperation } from './hybridOutbox';
import { pullTaskChanges, pushPendingTasks } from './hybridClient';

const deviceId = '22222222-2222-4222-8222-222222222222';
const taskId = '11111111-1111-4111-8111-111111111111';
const operationId = '33333333-3333-4333-8333-333333333333';
const session = {
  serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
  deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
  deviceProofExpiresAt: Date.now() + 300_000,
};

function pending(id = operationId): PendingTaskOperation {
  return {
    operationId: id, deviceId, entityType: 'task', entityId: taskId,
    operationType: 'upsert', expectedRevision: 0,
    payload: {} as PendingTaskOperation['payload'],
    queuedAt: Date.now(), state: 'pending',
  };
}
function mockResponse(value: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => value }));
}

beforeEach(async () => {
  await hybridOutbox.open();
  await hybridOutbox.transaction('rw', hybridOutbox.operations, hybridOutbox.metadata, async () => {
    await hybridOutbox.operations.clear();
    await hybridOutbox.metadata.clear();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('legacy hybrid sync queue safety', () => {
  it('preserves the entire pending operation on malformed push responses', async () => {
    await hybridOutbox.operations.add(pending());
    for (const results of [
      [],
      [{ operationId: '44444444-4444-4444-8444-444444444444', status: 'accepted', revision: 1 }],
      [{ operationId, status: 'accepted' }],
      [{ operationId, status: 'conflict' }],
      [{ operationId, status: 'unexpected' }],
    ]) {
      mockResponse({ results });
      await expect(pushPendingTasks(session)).rejects.toThrow('Invalid sync response');
      expect(await hybridOutbox.operations.get(operationId)).toMatchObject({ state: 'pending' });
    }
  });

  it('preserves rejected tasks and commits a complete push reply in one transaction', async () => {
    const conflictId = '44444444-4444-4444-8444-444444444444';
    const acceptedId = '55555555-5555-4555-8555-555555555555';
    await hybridOutbox.operations.bulkAdd([pending(), pending(conflictId), pending(acceptedId)]);
    mockResponse({ results: [
      { operationId, status: 'rejected', reason: 'invalid_assignee' },
      { operationId: conflictId, status: 'conflict', actualRevision: 4 },
      { operationId: acceptedId, status: 'accepted', revision: 1 },
    ] });
    await expect(pushPendingTasks(session)).resolves.toEqual({ accepted: 1, conflicts: 1, rejected: 1 });
    expect(await hybridOutbox.operations.get(operationId)).toMatchObject({ state: 'rejected', rejectionReason: 'invalid_assignee' });
    expect(await hybridOutbox.operations.get(conflictId)).toMatchObject({ state: 'conflict', actualRevision: 4 });
    expect(await hybridOutbox.operations.get(acceptedId)).toBeUndefined();
  });

  it('rejects non-HTTPS and credentialed server URLs before sending offline tasks', async () => {
    await hybridOutbox.operations.add(pending());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const serverUrl of ['ftp://localhost', 'http://sync.example.com', 'https://user:pass@sync.example.com', 'https://sync.example.com/api']) {
      await expect(pushPendingTasks({ ...session, serverUrl })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await hybridOutbox.operations.get(operationId)).toMatchObject({ state: 'pending' });
  });

  it('never calls the consumer or advances the cursor for incomplete or unordered pull replies', async () => {
    await hybridOutbox.metadata.put({ key: 'taskCursor', value: 10 });
    const consume = vi.fn(async () => {});
    for (const response of [
      { changes: [], nextCursor: 11, hasMore: false },
      { changes: [{ sequence: 11, entity_id: taskId }], nextCursor: 12, hasMore: false },
      { changes: [{ sequence: 10, entity_id: taskId }], nextCursor: 10, hasMore: false },
      { changes: [], nextCursor: 10, hasMore: 'false' },
    ]) {
      mockResponse(response);
      await expect(pullTaskChanges(session, consume)).rejects.toThrow('Invalid sync response');
      expect((await hybridOutbox.metadata.get('taskCursor'))?.value).toBe(10);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('advances the cursor only after the consumer has successfully applied changes', async () => {
    await hybridOutbox.metadata.put({ key: 'taskCursor', value: 10 });
    const change = { sequence: 11, entity_id: taskId, entity_type: 'task', revision: 1, payload: {} };
    mockResponse({ changes: [change], nextCursor: 11, hasMore: false });
    await expect(pullTaskChanges(session, async () => { throw new Error('local write failed'); })).rejects.toThrow('local write failed');
    expect((await hybridOutbox.metadata.get('taskCursor'))?.value).toBe(10);
    const applied = vi.fn(async () => {});
    await expect(pullTaskChanges(session, applied)).resolves.toEqual({ received: 1, hasMore: false });
    expect(applied).toHaveBeenCalledWith([change]);
    expect((await hybridOutbox.metadata.get('taskCursor'))?.value).toBe(11);
  });
});
