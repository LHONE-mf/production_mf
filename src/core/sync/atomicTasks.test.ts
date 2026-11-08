import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { saveServerManagedTask } from './atomicTasks';
import { pushAtomicTasks, pullAtomicTasks } from './atomicClient';
import { TaskPriority, TaskStatus, type Task } from '../types';

const deviceId = '22222222-2222-4222-8222-222222222222';
const taskId = '11111111-1111-4111-8111-111111111111';
function task(): Task {
  return {
    id: taskId, title: 'Offline task', description: '',
    status: TaskStatus.ASSIGNED, priority: TaskPriority.MEDIUM,
    assignedTo: '33333333-3333-4333-8333-333333333333',
    createdBy: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-11-08T10:00:00Z'), updatedAt: new Date('2026-11-08T10:00:00Z'),
    comments: [], attachments: [],
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('server-managed task offline writes', () => {
  beforeEach(async () => {
    await db.open();
    await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridSyncMetadata, async () => {
      await db.tasks.clear();
      await db.hybridTaskOutbox.clear();
      await db.hybridTaskRevisions.clear();
      await db.hybridSyncMetadata.clear();
    });
  });
  it('atomically saves an offline task and a pending operation', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const changed = { ...task(), status: TaskStatus.IN_PROGRESS, updatedAt: new Date('2026-11-08T11:00:00Z') };
    const operationId = await saveServerManagedTask(changed, deviceId);
    expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.IN_PROGRESS);
    expect(await db.hybridTaskOutbox.get(operationId)).toMatchObject({
      entityId: taskId, deviceId, expectedRevision: 3, state: 'pending',
      payload: { status: TaskStatus.IN_PROGRESS },
    });
  });
  it('rolls back a task update if a previous edit is still pending', async () => {
    await db.tasks.put(task());
    await saveServerManagedTask({ ...task(), status: TaskStatus.IN_PROGRESS }, deviceId);
    await expect(saveServerManagedTask({ ...task(), status: TaskStatus.COMPLETED }, deviceId)).rejects.toThrow('previous task edit');
    expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.IN_PROGRESS);
    expect(await db.hybridTaskOutbox.count()).toBe(1);
  });
  it('does not send or discard queued tasks without a matching unexpired device proof', async () => {
    await saveServerManagedTask(task(), deviceId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = { serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43) };
    for (const overrides of [
      {},
      { deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: '55555555-5555-4555-8555-555555555555', deviceProofExpiresAt: Date.now() + 300_000 },
      { deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId, deviceProofExpiresAt: Date.now() - 1000 },
    ]) {
      await expect(pushAtomicTasks({ ...session, ...overrides })).rejects.toThrow('Fresh device proof');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.hybridTaskOutbox.count()).toBe(1);
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
  });

  it('preserves pending edits when a push response is incomplete or duplicated', async () => {
    const operationId = await saveServerManagedTask(task(), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    for (const results of [
      [],
      [{ operationId, status: 'accepted', revision: 1 }, { operationId, status: 'accepted', revision: 2 }],
      [{ operationId, status: 'accepted', revision: -1 }],
      [{ operationId, status: 'accepted', revision: 3 }],
      [{ operationId, status: 'duplicate', revision: 2 }],
      [{ operationId, status: 'unknown' }],
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ results }),
      }));
      await expect(pushAtomicTasks(session)).rejects.toThrow('Invalid sync response');
      expect(await db.hybridTaskOutbox.get(operationId)).toMatchObject({ state: 'pending' });
      expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    }
  });
  it('sends a device-bound proof and clears the outbox only after server acknowledgment', async () => {
    const operationId = await saveServerManagedTask(task(), deviceId);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ operationId, status: 'accepted', revision: 1 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await pushAtomicTasks({
      serverUrl: 'https://sync.example.com',
      accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43),
      deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    });
    expect(result.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['x-device-proof']).toBe('B'.repeat(43));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operations[0].deviceId).toBe(deviceId);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
  });
  it('does not advance the durable pull cursor when the server skips unseen changes', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
    for (const response of [
      { changes: [], nextCursor: 11, hasMore: false },
      { changes: [{ sequence: '11', entity_id: taskId }], nextCursor: 12, hasMore: false },
      { changes: [{ sequence: '10', entity_id: taskId }], nextCursor: 10, hasMore: false },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
      await expect(pullAtomicTasks(session)).rejects.toThrow('Invalid sync response');
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(10);
      expect(await db.tasks.get(taskId)).toBeUndefined();
    }
  });
  it('rejects invalid device identity without persisting task', async () => {
    await expect(saveServerManagedTask(task(), 'not-a-uuid')).rejects.toThrow('deviceId must be a UUID');
    expect(await db.tasks.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });
});
