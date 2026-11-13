import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { saveServerManagedTask, editServerManagedTask, createServerManagedTask } from './atomicTasks';
import { provisionOfflineTaskEditLease, requireOfflineTaskEditLease } from './offlineTaskLease';
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
async function authorizeTaskEditing(role: 'chief' | 'master' | 'worker' = 'master') {
  await provisionOfflineTaskEditLease({
    deviceId, actorId: role === 'worker' ? task().assignedTo : task().createdBy,
    organizationId: '66666666-6666-4666-8666-666666666666',
    role, expiresAt: Date.now() + 120_000, authorizedTaskIds: [taskId],
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('server-managed task offline writes', () => {
  beforeEach(async () => {
    await db.open();
    await db.transaction('rw', [db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridSyncMetadata, db.hybridTaskEditLeases, db.hybridTaskDeferred], async () => {
      await db.tasks.clear();
      await db.hybridTaskOutbox.clear();
      await db.hybridTaskRevisions.clear();
      await db.hybridSyncMetadata.clear();
      await db.hybridTaskEditLeases.clear();
      await db.hybridTaskDeferred.clear();
    });
  });
  it('provisions a five-minute verified edit lease that survives an IndexedDB restart', async () => {
    const actorId = '44444444-4444-4444-8444-444444444444';
    await provisionOfflineTaskEditLease({
      deviceId, actorId, organizationId: '66666666-6666-4666-8666-666666666666',
      role: 'master', expiresAt: Date.now() + 120_000, authorizedTaskIds: [taskId],
    });
    expect((await requireOfflineTaskEditLease()).deviceId).toBe(deviceId);
    db.close();
    await db.open();
    expect((await requireOfflineTaskEditLease()).actorId).toBe(actorId);
    await db.hybridTaskEditLeases.update('active', { expiresAt: Date.now() - 1 });
    await expect(requireOfflineTaskEditLease()).rejects.toThrow('Подтвердите устройство');
    await expect(provisionOfflineTaskEditLease({
      deviceId, actorId, organizationId: '66666666-6666-4666-8666-666666666666',
      role: 'master', expiresAt: Date.now() + 36_000_000, authorizedTaskIds: [taskId],
    })).rejects.toThrow('Invalid offline task edit authorization');
    await provisionOfflineTaskEditLease({
      deviceId, actorId, organizationId: '66666666-6666-4666-8666-666666666666',
      role: 'master', expiresAt: Date.now() + 7 * 3_600_000, authorizedTaskIds: [taskId],
    });
    db.close();
    await db.open();
    expect((await requireOfflineTaskEditLease()).deviceId).toBe(deviceId);
  });

  it('edits the latest server task and queues consecutive status/field edits atomically', async () => {
    await authorizeTaskEditing();
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    await db.tasks.put(task());
    await editServerManagedTask(taskId, { title: 'Updated offline', priority: TaskPriority.HIGH });
    await editServerManagedTask(taskId, { status: TaskStatus.IN_PROGRESS });
    const stored = await db.tasks.get(taskId);
    expect(stored).toMatchObject({ title: 'Updated offline', priority: TaskPriority.HIGH, status: TaskStatus.IN_PROGRESS });
    expect(stored?.createdBy).toBe(task().createdBy);
    const operations = await db.hybridTaskOutbox.where('entityId').equals(taskId).sortBy('queuedAt');
    expect(operations.map(op => op.expectedRevision)).toEqual([3, 4]);
    expect(operations.map(op => op.payload.title)).toEqual(['Updated offline', 'Updated offline']);
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Updated offline');
    expect(await db.hybridTaskOutbox.where('entityId').equals(taskId).count()).toBe(2);
  });

  it('refuses forbidden status jumps without changing tasks or queued operations', async () => {
    await authorizeTaskEditing();
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
    await db.tasks.put(task());
    await expect(editServerManagedTask(taskId, { status: TaskStatus.COMPLETED }))
      .rejects.toThrow('Invalid server task status transition');
    expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.ASSIGNED);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });

  it('enforces worker-only status edits inside the durable write layer', async () => {
    await authorizeTaskEditing('worker');
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
    await db.tasks.put(task());
    await expect(editServerManagedTask(taskId, { title: 'Forbidden task rewrite' }))
      .rejects.toThrow('Workers may only update assigned task progress');
    await expect(editServerManagedTask(taskId, { status: TaskStatus.COMPLETED }))
      .rejects.toThrow('Workers may only update assigned task progress');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    await editServerManagedTask(taskId, { status: TaskStatus.IN_PROGRESS });
    await editServerManagedTask(taskId, { status: TaskStatus.CHECKED });
    expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.CHECKED);
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    await db.hybridTaskEditLeases.update('active', { expiresAt: Date.now() - 1 });
    await expect(editServerManagedTask(taskId, { status: TaskStatus.IN_PROGRESS }))
      .rejects.toThrow('Подтвердите устройство');
    expect(await db.hybridTaskOutbox.count()).toBe(2);
  });

  it('creates a server-owned assigned task and safely edits it before the first upload', async () => {
    await authorizeTaskEditing('master');
    const firstOperationId = await createServerManagedTask({
      title: 'New production assignment', description: 'Coating setup',
      priority: TaskPriority.HIGH, assignedTo: task().assignedTo, workshopId: 'assembly',
    });
    const queued = await db.hybridTaskOutbox.get(firstOperationId);
    expect(queued).toMatchObject({
      deviceId, expectedRevision: 0, state: 'pending',
      payload: { title: 'New production assignment', createdBy: task().createdBy, status: TaskStatus.ASSIGNED },
    });
    const newTaskId = queued!.entityId;
    expect((await db.tasks.get(newTaskId))?.createdBy).toBe(task().createdBy);
    expect(await db.hybridTaskRevisions.get(newTaskId)).toBeUndefined();
    await editServerManagedTask(newTaskId, { title: 'Edited before initial sync' });
    expect((await db.tasks.get(newTaskId))?.title).toBe('Edited before initial sync');
    const operations = await db.hybridTaskOutbox.where('entityId').equals(newTaskId).sortBy('queuedAt');
    expect(operations.map(op => op.expectedRevision)).toEqual([0, 1]);
    expect(operations.map(op => op.payload.title)).toEqual([
      'New production assignment', 'Edited before initial sync',
    ]);
    db.close();
    await db.open();
    expect((await db.tasks.get(newTaskId))?.title).toBe('Edited before initial sync');
    expect(await db.hybridTaskOutbox.where('entityId').equals(newTaskId).count()).toBe(2);
  });

  it('never creates a shared task for a worker or an unproven device', async () => {
    const fields = { title: 'Not authorized', description: '', priority: TaskPriority.MEDIUM, workshopId: 'assembly' };
    await expect(createServerManagedTask(fields)).rejects.toThrow('Подтвердите устройство');
    await authorizeTaskEditing('worker');
    await expect(createServerManagedTask(fields)).rejects.toThrow('Workers cannot create server tasks');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect(await db.tasks.count()).toBe(0);
  });

  it('requires a valid workshop for shared assignments without touching local-only tasks', async () => {
    await authorizeTaskEditing('master');
    await expect(createServerManagedTask({
      title: 'Needs workshop', description: '', priority: TaskPriority.MEDIUM, assignedTo: task().assignedTo,
    })).rejects.toThrow('Invalid server task fields or missing workshop');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });

  it('refuses to enroll an existing local-only UUID task without overwriting it', async () => {
    const original = { ...task(), title: 'Local-only workshop note' };
    await db.tasks.put(original);
    await expect(saveServerManagedTask({ ...original, title: 'Remote enrollment attempt' }, deviceId))
      .rejects.toThrow('Existing local-only task cannot be enrolled automatically');
    expect((await db.tasks.get(taskId))?.title).toBe('Local-only workshop note');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Local-only workshop note');
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
  it('preserves repeated offline edits as distinct, ordered revision-checked operations', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const first = { ...task(), status: TaskStatus.IN_PROGRESS, updatedAt: new Date('2026-11-08T11:00:00Z') };
    const second = { ...task(), status: TaskStatus.CHECKED, updatedAt: new Date('2026-11-08T12:00:00Z') };
    const firstId = await saveServerManagedTask(first, deviceId);
    const secondId = await saveServerManagedTask(second, deviceId);
    expect(firstId).not.toBe(secondId);
    expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.CHECKED);
    const operations = await db.hybridTaskOutbox.where('entityId').equals(taskId).sortBy('queuedAt');
    expect(operations.map(op => op.expectedRevision)).toEqual([3, 4]);
    expect(operations.map(op => op.payload.status)).toEqual([TaskStatus.IN_PROGRESS, TaskStatus.CHECKED]);
    expect(operations[1].queuedAt).toBeGreaterThan(operations[0].queuedAt);
    expect(operations.every(op => op.state === 'pending')).toBe(true);
    // Both operations survive closing and reopening IndexedDB.
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.where('entityId').equals(taskId).count()).toBe(2);
  });
  it('does not create new edits over conflicts, rejected operations or another device queue', async () => {
    const firstId = await saveServerManagedTask(task(), deviceId);
    await expect(saveServerManagedTask(task(), '55555555-5555-4555-8555-555555555555'))
      .rejects.toThrow('device mismatch');
    await db.hybridTaskOutbox.update(firstId, { state: 'conflict', actualRevision: 7 });
    await expect(saveServerManagedTask({ ...task(), title: 'Do not overwrite conflict' }, deviceId))
      .rejects.toThrow('Resolve the previous task edit');
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
    expect(await db.hybridTaskOutbox.count()).toBe(1);
  });
  it('sends consecutive offline edits only after each predecessor is acknowledged', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const firstId = await saveServerManagedTask(
      { ...task(), status: TaskStatus.IN_PROGRESS, updatedAt: new Date('2026-11-08T11:00:00Z') }, deviceId);
    const secondId = await saveServerManagedTask(
      { ...task(), status: TaskStatus.CHECKED, updatedAt: new Date('2026-11-08T12:00:00Z') }, deviceId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { operationId: firstId, status: 'accepted', revision: 4 },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
        { operationId: secondId, status: 'accepted', revision: 5 },
      ] }) });
    vi.stubGlobal('fetch', fetchMock);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    expect((await pushAtomicTasks(session)).accepted).toBe(1);
    expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(4);
    expect((await pushAtomicTasks(session)).accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const operations = fetchMock.mock.calls.map(call => JSON.parse(call[1].body).operations);
    expect(operations.map(batch => batch.map((op: {expectedRevision: number}) => op.expectedRevision)))
      .toEqual([[3], [4]]);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(5);
  });
  it.each(['conflict', 'rejected'] as const)(
    'retains later offline edits without sending them after a %s response',
    async status => {
      const firstId = await saveServerManagedTask(
        { ...task(), status: TaskStatus.IN_PROGRESS, updatedAt: new Date('2026-11-08T11:00:00Z') }, deviceId);
      const secondId = await saveServerManagedTask(
        { ...task(), status: TaskStatus.CHECKED, updatedAt: new Date('2026-11-08T12:00:00Z') }, deviceId);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ results: [{
          operationId: firstId, status,
          ...(status === 'conflict' ? { actualRevision: 7 } : { reason: 'workshop_access_denied' }),
        }] }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      const result = await pushAtomicTasks(session);
      expect(result[status === 'conflict' ? 'conflicts' : 'rejected']).toBe(1);
      expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe(status);
      expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
      expect((await pushAtomicTasks(session)).accepted).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.CHECKED);
      expect(await db.hybridTaskOutbox.count()).toBe(2);
    },
  );
  it('preserves a rejected offline edit and its dependent edits across restart and blocks automatic replay', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const firstId = await saveServerManagedTask(
      { ...task(), title: 'First rejected edit' }, deviceId);
    const secondId = await saveServerManagedTask(
      { ...task(), title: 'Second unsent edit' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      results: [{ operationId: firstId, status: 'rejected', reason: 'workshop_access_denied' }],
    }) });
    vi.stubGlobal('fetch', fetchMock);
    expect((await pushAtomicTasks(session)).rejected).toBe(1);
    expect(await db.hybridTaskOutbox.get(firstId)).toMatchObject({
      state: 'rejected', rejectionReason: 'workshop_access_denied',
      payload: { title: 'First rejected edit' }, expectedRevision: 3,
    });
    expect(await db.hybridTaskOutbox.get(secondId)).toMatchObject({
      state: 'pending', payload: { title: 'Second unsent edit' }, expectedRevision: 4,
    });
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Second unsent edit');
    expect((await db.hybridTaskOutbox.get(firstId))?.rejectionReason).toBe('workshop_access_denied');
    expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(3);
    expect((await pushAtomicTasks(session)).accepted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(saveServerManagedTask({ ...task(), title: 'Unsafe third edit' }, deviceId))
      .rejects.toThrow('Resolve the previous task edit');
    expect(await db.hybridTaskOutbox.count()).toBe(2);
  });

  it('retains a server-reported rejection revision across restart for safe recovery', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const operationId = await saveServerManagedTask({ ...task(), title: 'Keep this edit' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      results: [{ operationId, status: 'rejected', actualRevision: 8, reason: 'workshop_access_denied' }],
    }) }));
    expect((await pushAtomicTasks(session)).rejected).toBe(1);
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.get(operationId)).toMatchObject({
      state: 'rejected', actualRevision: 8, rejectionReason: 'workshop_access_denied',
    });
    expect((await db.tasks.get(taskId))?.title).toBe('Keep this edit');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(3);
  });
  it('rejects a malformed rejection revision without touching offline edits', async () => {
    const operationId = await saveServerManagedTask(task(), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      results: [{ operationId, status: 'rejected', actualRevision: -1 }],
    }) }));
    await expect(pushAtomicTasks(session)).rejects.toThrow('Invalid sync response: rejection revision');
    expect((await db.hybridTaskOutbox.get(operationId))?.state).toBe('pending');
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
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
  it('rejects a partially valid multi-task acknowledgement without confirming either edit', async () => {
    const secondTaskId = '55555555-5555-4555-8555-555555555555';
    const firstId = await saveServerManagedTask(task(), deviceId);
    const secondId = await saveServerManagedTask({
      ...task(), id: secondTaskId, title: 'Independent offline task',
    }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({
        results: [
          { operationId: firstId, status: 'accepted', revision: 1 },
          { operationId: secondId, status: 'accepted', revision: 99 },
        ],
      }),
    }));
    await expect(pushAtomicTasks(session)).rejects.toThrow('Invalid sync response');
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
    expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(secondTaskId)).toBeUndefined();
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    expect((await db.tasks.get(secondTaskId))?.title).toBe('Independent offline task');
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
  it.each(['pending', 'conflict', 'rejected'] as const)(
    'never overwrites %s offline edits and durably defers the remote change',
    async state => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
      await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
      const operationId = await saveServerManagedTask(task(), deviceId);
      if (state !== 'pending') await db.hybridTaskOutbox.update(operationId, { state });
      const server = { ...task(), title: 'Remote conflicting edit' };
      const { encodeTask } = await import('./taskDto');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({
          changes: [{ sequence: '11', entity_id: taskId, entity_type: 'task',
            revision: 2, payload: encodeTask(server) }],
          nextCursor: 11, hasMore: false,
        }),
      }));
      expect((await pullAtomicTasks(session)).received).toBe(1);
      expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
      expect(await db.hybridTaskOutbox.get(operationId)).toMatchObject({ state });
      expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(11);
      expect((await db.hybridTaskDeferred.get(11))?.entityId).toBe(taskId);
      db.close();
      await db.open();
      expect(await db.hybridTaskOutbox.get(operationId)).toMatchObject({ state });
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(11);
      expect((await db.hybridTaskDeferred.get(11))?.change.revision).toBe(2);
    },
  );

  it('pulls unaffected tasks past a conflict and replays deferred changes after archive', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const secondId = '55555555-5555-4555-8555-555555555555';
    const { encodeTask } = await import('./taskDto');
    const { archiveConflictAndUseServer } = await import('./taskConflictResolution');
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
    const localOp = await saveServerManagedTask(task(), deviceId);
    await db.hybridTaskOutbox.update(localOp, { state: 'conflict', actualRevision: 2 });
    const serverPayload = encodeTask({ ...task(), title: 'Server conflict winner' });
    const otherPayload = encodeTask({ ...task(), id: secondId, title: 'Unrelated task' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        changes: [
          { sequence: '11', entity_id: taskId, entity_type: 'task', revision: 2, payload: serverPayload },
          { sequence: '12', entity_id: secondId, entity_type: 'task', revision: 1, payload: otherPayload },
        ], nextCursor: 12, hasMore: false,
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        changes: [], nextCursor: 12, hasMore: false,
      }) });
    vi.stubGlobal('fetch', fetchMock);
    expect((await pullAtomicTasks(session)).received).toBe(2);
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
    expect((await db.tasks.get(secondId))?.title).toBe('Unrelated task');
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(12);
    expect((await db.hybridTaskDeferred.get(11))?.change.revision).toBe(2);
    db.close();
    await db.open();
    expect((await db.hybridTaskDeferred.get(11))?.entityId).toBe(taskId);
    await archiveConflictAndUseServer(taskId, 2, serverPayload);
    expect((await db.tasks.get(taskId))?.title).toBe('Server conflict winner');
    expect(await db.hybridTaskResolutions.count()).toBeGreaterThan(0);
    expect((await pullAtomicTasks(session)).received).toBe(0);
    expect(await db.hybridTaskDeferred.count()).toBe(0);
    expect((await db.tasks.get(secondId))?.title).toBe('Unrelated task');
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(12);
  });

  it('applies both complete task snapshots when later entity skips hidden revisions', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const secondId = '55555555-5555-4555-8555-555555555555';
    const { encodeTask } = await import('./taskDto');
    await db.hybridTaskRevisions.put({ entityId: secondId, revision: 1 });
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 20 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({
        changes: [
          { sequence: '21', entity_id: taskId, entity_type: 'task',
            revision: 1, payload: encodeTask(task()) },
          { sequence: '22', entity_id: secondId, entity_type: 'task',
            revision: 4, payload: encodeTask({ ...task(), id: secondId }) },
        ],
        nextCursor: 22, hasMore: false,
      }),
    }));
    expect((await pullAtomicTasks(session)).received).toBe(2);
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
    expect((await db.tasks.get(secondId))?.title).toBe('Offline task');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
    expect((await db.hybridTaskRevisions.get(secondId))?.revision).toBe(4);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(22);
    db.close();
    await db.open();
    expect((await db.hybridTaskRevisions.get(secondId))?.revision).toBe(4);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(22);
  });

  it('retains a changed queued operation when its earlier snapshot is acknowledged', async () => {
    const operationId = await saveServerManagedTask(task(), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let deliver!: (result: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const inFlight = pushAtomicTasks(session);
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    // Simulate an unexpected concurrent mutation of the durable queue.
    // An acknowledgement of the original payload cannot confirm this edit.
    await db.hybridTaskOutbox.update(operationId, {
      payload: { ...((await db.hybridTaskOutbox.get(operationId))!.payload), title: 'New offline title' },
    });
    deliver({ ok: true, json: async () => ({
      results: [{ operationId, status: 'accepted', revision: 1 }],
    }) });
    await expect(inFlight).rejects.toThrow('Queued task operation changed during sync');
    expect((await db.hybridTaskOutbox.get(operationId))?.state).toBe('pending');
    expect((await db.hybridTaskOutbox.get(operationId))?.payload.title).toBe('New offline title');
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    db.close();
    await db.open();
    expect((await db.hybridTaskOutbox.get(operationId))?.payload.title).toBe('New offline title');
  });

  it('rejects a partially malformed multi-task acknowledgement without clearing any offline edits', async () => {
    const secondTaskId = '55555555-5555-4555-8555-555555555555';
    const firstId = await saveServerManagedTask(task(), deviceId);
    const secondId = await saveServerManagedTask(
      { ...task(), id: secondTaskId, title: 'Other offline task' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      results: [
        { operationId: firstId, status: 'accepted', revision: 1 },
        { operationId: secondId, status: 'accepted', revision: 9 },
      ],
    }) }));
    await expect(pushAtomicTasks(session)).rejects.toThrow('revision does not match queued precondition');
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
    expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(secondTaskId)).toBeUndefined();
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    expect((await db.tasks.get(secondTaskId))?.title).toBe('Other offline task');
  });

  it('atomically rolls back a batch if one queued edit changes during push', async () => {
    const secondTaskId = '55555555-5555-4555-8555-555555555555';
    const firstId = await saveServerManagedTask(task(), deviceId);
    const secondId = await saveServerManagedTask(
      { ...task(), id: secondTaskId, title: 'Second offline task' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let deliver!: (result: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const inFlight = pushAtomicTasks(session);
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    await db.hybridTaskOutbox.update(secondId, {
      payload: { ...((await db.hybridTaskOutbox.get(secondId))!.payload), title: 'Changed while pushing' },
    });
    deliver({ ok: true, json: async () => ({
      results: [
        { operationId: firstId, status: 'accepted', revision: 1 },
        { operationId: secondId, status: 'accepted', revision: 1 },
      ],
    }) });
    await expect(inFlight).rejects.toThrow('Queued task operation changed during sync');
    // No partial acknowledgement: the first task must remain queued as well.
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
    expect((await db.hybridTaskOutbox.get(secondId))?.payload.title).toBe('Changed while pushing');
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(secondTaskId)).toBeUndefined();
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
    expect((await db.hybridTaskOutbox.get(secondId))?.payload.title).toBe('Changed while pushing');
  });

  it('does not partially acknowledge a batch if an in-flight operation disappears', async () => {
    const secondTaskId = '55555555-5555-4555-8555-555555555555';
    const firstId = await saveServerManagedTask(task(), deviceId);
    const secondId = await saveServerManagedTask(
      { ...task(), id: secondTaskId, title: 'Another task' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let deliver!: (result: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const inFlight = pushAtomicTasks(session);
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    await db.hybridTaskOutbox.delete(secondId);
    deliver({ ok: true, json: async () => ({
      results: [
        { operationId: firstId, status: 'accepted', revision: 1 },
        { operationId: secondId, status: 'accepted', revision: 1 },
      ],
    }) });
    await expect(inFlight).rejects.toThrow('disappeared or changed state during sync');
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(secondTaskId)).toBeUndefined();
    db.close();
    await db.open();
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('pending');
  });

  it('preserves a newly queued dependent edit while its predecessor is in flight', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const firstId = await saveServerManagedTask(
      { ...task(), title: 'First edit' }, deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let deliver!: (result: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const inFlight = pushAtomicTasks(session);
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    const secondId = await saveServerManagedTask(
      { ...task(), title: 'Second edit saved during upload' }, deviceId);
    expect((await db.hybridTaskOutbox.get(secondId))?.expectedRevision).toBe(4);
    deliver({ ok: true, json: async () => ({
      results: [{ operationId: firstId, status: 'accepted', revision: 4 }],
    }) });
    expect((await inFlight).accepted).toBe(1);
    expect(await db.hybridTaskOutbox.get(firstId)).toBeUndefined();
    expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
    expect((await db.tasks.get(taskId))?.title).toBe('Second edit saved during upload');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(4);
    db.close();
    await db.open();
    expect((await db.hybridTaskOutbox.get(secondId))?.payload.title)
      .toBe('Second edit saved during upload');
    expect((await db.tasks.get(taskId))?.title).toBe('Second edit saved during upload');
  });

  it.each(['conflict', 'rejected'] as const)(
    'retains a dependent edit saved during upload when predecessor becomes %s',
    async status => {
      await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
      const firstId = await saveServerManagedTask(
        { ...task(), title: 'First edit in flight' }, deviceId);
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      let deliver!: (result: unknown) => void;
      const fetchMock = vi.fn(() => new Promise(resolve => { deliver = resolve; }));
      vi.stubGlobal('fetch', fetchMock);
      const inFlight = pushAtomicTasks(session);
      await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
      const secondId = await saveServerManagedTask(
        { ...task(), title: 'Dependent edit must survive' }, deviceId);
      deliver({ ok: true, json: async () => ({
        results: [{
          operationId: firstId, status,
          ...(status === 'conflict'
            ? { actualRevision: 5 }
            : { actualRevision: 5, reason: 'workshop_access_denied' }),
        }],
      }) });
      const result = await inFlight;
      expect(result[status === 'conflict' ? 'conflicts' : 'rejected']).toBe(1);
      expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe(status);
      expect((await db.hybridTaskOutbox.get(secondId))?.state).toBe('pending');
      expect((await db.tasks.get(taskId))?.title).toBe('Dependent edit must survive');
      expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(3);
      expect((await pushAtomicTasks(session)).accepted).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      db.close();
      await db.open();
      expect((await db.hybridTaskOutbox.get(firstId))?.actualRevision).toBe(5);
      expect((await db.hybridTaskOutbox.get(secondId))?.payload.title)
        .toBe('Dependent edit must survive');
      expect((await db.tasks.get(taskId))?.title).toBe('Dependent edit must survive');
    },
  );

  it('handles overlapping pushes of the same operation without duplicate local writes', async () => {
    const operationId = await saveServerManagedTask(task(), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let respondFirst!: (result: unknown) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { respondFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        results: [{ operationId, status: 'duplicate', revision: 1 }],
      }) });
    vi.stubGlobal('fetch', fetchMock);
    const slow = pushAtomicTasks(session);
    await vi.waitFor(() => expect(respondFirst).toBeTypeOf('function'));
    expect((await pushAtomicTasks(session)).accepted).toBe(1);
    respondFirst({ ok: true, json: async () => ({
      results: [{ operationId, status: 'accepted', revision: 1 }],
    }) });
    await expect(slow).rejects.toThrow('Queued task operation disappeared or changed state during sync');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
    db.close();
    await db.open();
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
  });

  it('does not downgrade a task revision when an old push acknowledgement arrives late', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const operationId = await saveServerManagedTask(task(), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    let deliver!: (result: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { deliver = resolve; })));
    const inFlight = pushAtomicTasks(session);
    // Wait until the request is actually in flight before simulating a newer
    // durable revision written by another synchronized operation.
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 5 });
    deliver({ ok: true, json: async () => ({
      results: [{ operationId, status: 'accepted', revision: 4 }],
    }) });
    expect((await inFlight).accepted).toBe(1);
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(5);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });

  it.each([null, false, 42] as const)(
    'rejects malformed remote change %s without advancing checkpoint',
    async malformed => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 4 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({
          changes: [malformed], nextCursor: 5, hasMore: false,
        }),
      }));
      await expect(pullAtomicTasks(session)).rejects.toThrow('Invalid sync response: malformed change');
      expect(await db.tasks.count()).toBe(0);
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(4);
    },
  );

  it('rejects an empty pull page that falsely claims more changes', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 5 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ changes: [], nextCursor: 5, hasMore: true }),
    }));
    await expect(pullAtomicTasks(session)).rejects.toThrow('cursor does not match delivered changes');
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(5);
    db.close();
    await db.open();
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(5);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1] as const)(
    'refuses corrupted local pull cursor %s before making a network request',
    async cursor => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      await db.hybridSyncMetadata.put({ key: 'taskCursor', value: cursor });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(pullAtomicTasks(session)).rejects.toThrow('Invalid locally stored task cursor');
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value)
        .toEqual(cursor);
    },
  );

  it.each([null, '0', false, '', 0.5, -1] as const)(
    'rejects malformed pull cursor %s without touching offline task state',
    async nextCursor => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      const operationId = await saveServerManagedTask(task(), deviceId);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ changes: [], nextCursor, hasMore: false }),
      }));
      await expect(pullAtomicTasks(session)).rejects.toThrow('Invalid sync response: changes or cursor');
      expect(await db.hybridSyncMetadata.get('taskCursor')).toBeUndefined();
      expect((await db.hybridTaskOutbox.get(operationId))?.state).toBe('pending');
      expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
    },
  );

  it('does not roll back a newer pull cursor when an older network response arrives late', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
    const { encodeTask } = await import('./taskDto');
    let respondOlder!: (response: unknown) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { respondOlder = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        changes: [{ sequence: '12', entity_id: taskId, entity_type: 'task',
          revision: 1, payload: encodeTask(task()) }],
        nextCursor: 12, hasMore: false,
      }) });
    vi.stubGlobal('fetch', fetchMock);
    const slow = pullAtomicTasks(session);
    await vi.waitFor(() => expect(respondOlder).toBeTypeOf('function'));
    expect((await pullAtomicTasks(session)).received).toBe(1);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(12);
    respondOlder({ ok: true, json: async () => ({
      changes: [{ sequence: '11', entity_id: taskId, entity_type: 'task',
        revision: 1, payload: encodeTask({ ...task(), title: 'Stale version' }) }],
      nextCursor: 11, hasMore: false,
    }) });
    await expect(slow).rejects.toThrow('Concurrent task pull');
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(12);
    expect((await db.tasks.get(taskId))?.title).toBe('Offline task');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(1);
  });

  it.each(['1e1', ' 10', '010', '+10', '10.0'] as const)(
    'rejects noncanonical remote sequence %s without advancing the cursor',
    async sequence => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      const { encodeTask } = await import('./taskDto');
      await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 9 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({
          changes: [{ sequence, entity_id: taskId, entity_type: 'task',
            revision: 1, payload: encodeTask(task()) }],
          nextCursor: 10, hasMore: false,
        }),
      }));
      await expect(pullAtomicTasks(session)).rejects.toThrow('unordered changes or task ID');
      expect(await db.tasks.get(taskId)).toBeUndefined();
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(9);
    },
  );

  it('rolls back earlier remote tasks when a later change in the same pull is malformed', async () => {
    const secondTaskId = '55555555-5555-4555-8555-555555555555';
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const { encodeTask } = await import('./taskDto');
    const badPayload = encodeTask({ ...task(), id: secondTaskId });
    badPayload.updatedAt = 'invalid-date';
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({
        changes: [
          { sequence: '11', entity_id: taskId, entity_type: 'task',
            revision: 1, payload: encodeTask(task()) },
          { sequence: '12', entity_id: secondTaskId, entity_type: 'task',
            revision: 1, payload: badPayload },
        ],
        nextCursor: 12, hasMore: false,
      }),
    }));
    await expect(pullAtomicTasks(session)).rejects.toThrow('Invalid remote task date');
    expect(await db.tasks.get(taskId)).toBeUndefined();
    expect(await db.tasks.get(secondTaskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskRevisions.get(secondTaskId)).toBeUndefined();
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(10);
    db.close();
    await db.open();
    expect(await db.tasks.count()).toBe(0);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(10);
  });

  it.each(['invalid_creation_date', 'reversed_audit_clock', 'foreign_comment', 'invalid_attachment_date'] as const)(
    'rolls back remote task and cursor for malformed %s',
    async failure => {
      const session = {
        serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
        deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
        deviceProofExpiresAt: Date.now() + 300_000,
      };
      const { encodeTask } = await import('./taskDto');
      const payload = encodeTask(task());
      if (failure === 'invalid_creation_date') payload.createdAt = 'not-a-date';
      if (failure === 'reversed_audit_clock') payload.updatedAt = '2026-11-07T10:00:00.000Z';
      if (failure === 'foreign_comment') payload.comments = [{
        id: '66666666-6666-4666-8666-666666666666',
        taskId: '77777777-7777-4777-8777-777777777777',
        authorId: '44444444-4444-4444-8444-444444444444',
        text: 'Misattached', createdAt: '2026-11-08T10:00:00.000Z',
      }];
      if (failure === 'invalid_attachment_date') payload.attachments = [{
        id: '88888888-8888-4888-8888-888888888888',
        taskId, fileName: 'report.txt', fileType: 'text/plain',
        data: 'test', createdAt: 'invalid',
      }];
      await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 20 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({
          changes: [{ sequence: '21', entity_id: taskId, entity_type: 'task',
            revision: 1, payload }],
          nextCursor: 21, hasMore: false,
        }),
      }));
      await expect(pullAtomicTasks(session)).rejects.toThrow();
      expect(await db.tasks.get(taskId)).toBeUndefined();
      expect(await db.hybridTaskRevisions.get(taskId)).toBeUndefined();
      expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(20);
    },
  );

  it('applies a newer full snapshot despite a workshop-scoped revision gap and survives restart', async () => {
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const { encodeTask } = await import('./taskDto');
    await db.tasks.put(task());
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 2 });
    await db.hybridSyncMetadata.put({ key: 'taskCursor', value: 10 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({
        changes: [{ sequence: '15', entity_id: taskId, entity_type: 'task',
          revision: 5, payload: encodeTask({ ...task(), title: 'Authoritative scoped snapshot' }) }],
        nextCursor: 15, hasMore: false,
      }),
    }));
    expect((await pullAtomicTasks(session)).received).toBe(1);
    expect((await db.tasks.get(taskId))?.title).toBe('Authoritative scoped snapshot');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(5);
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Authoritative scoped snapshot');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(5);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(15);
  });

  it('rejects invalid device identity without persisting task', async () => {
    await expect(saveServerManagedTask(task(), 'not-a-uuid')).rejects.toThrow('deviceId must be a UUID');
    expect(await db.tasks.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });
});
