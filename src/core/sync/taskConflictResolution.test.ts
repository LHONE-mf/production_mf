import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { TaskPriority, TaskStatus, type Task } from '../types';
import { saveServerManagedTask } from './atomicTasks';
import { pushAtomicTasks, pullAtomicTasks } from './atomicClient';
import { archiveConflictAndUseServer } from './taskConflictResolution';
import { encodeTask } from './taskDto';

const deviceId = '22222222-2222-4222-8222-222222222222';
const taskId = '11111111-1111-4111-8111-111111111111';
function task(title = 'Offline changes'): Task {
  return {
    id: taskId, title, description: 'Local production note', status: TaskStatus.ASSIGNED,
    priority: TaskPriority.MEDIUM,
    assignedTo: '33333333-3333-4333-8333-333333333333',
    createdBy: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-11-08T10:00:00.000Z'),
    updatedAt: new Date('2026-11-08T12:00:00.000Z'),
    comments: [], attachments: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('manual task conflict resolution', () => {
  beforeEach(async () => {
    await db.open();
    await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, db.hybridTaskResolutions, db.hybridSyncMetadata, async () => {
      await db.tasks.clear();
      await db.hybridTaskOutbox.clear();
      await db.hybridTaskRevisions.clear();
      await db.hybridTaskResolutions.clear();
      await db.hybridSyncMetadata.clear();
    });
  });
  it('archives every local operation and the complete original task before adopting the server snapshot', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const firstId = await saveServerManagedTask(task('First offline edit'), deviceId);
    const secondId = await saveServerManagedTask(task('Final offline edit'), deviceId);
    await db.hybridTaskOutbox.update(firstId, { state: 'conflict', actualRevision: 5 });
    const server = encodeTask({ ...task('Remote workshop edit'), status: TaskStatus.CHECKED });
    const archiveId = await archiveConflictAndUseServer(taskId, 5, server);
    expect((await db.tasks.get(taskId))?.title).toBe('Remote workshop edit');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(5);
    expect(await db.hybridTaskOutbox.where('entityId').equals(taskId).count()).toBe(0);
    const archive = await db.hybridTaskResolutions.get(archiveId);
    expect(archive?.decision).toBe('use_server');
    expect(archive?.localTask.title).toBe('Final offline edit');
    expect(archive?.localOperations.map(op => op.operationId)).toEqual([firstId, secondId]);
    expect(archive?.localOperations.map(op => op.payload.title)).toEqual(['First offline edit', 'Final offline edit']);
    expect(archive?.localOperations.map(op => op.state)).toEqual(['conflict', 'pending']);
    expect(archive?.serverRevision).toBe(5);
    db.close();
    await db.open();
    expect((await db.hybridTaskResolutions.get(archiveId))?.localOperations).toHaveLength(2);
    const nextId = await saveServerManagedTask(task('Future edit'), deviceId);
    expect((await db.hybridTaskOutbox.get(nextId))?.expectedRevision).toBe(5);
  });
  it('reconnects and advances the pull cursor after a device conflict is archived', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
    const localId = await saveServerManagedTask(task('Device B offline edit'), deviceId);
    const session = {
      serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
      deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
      deviceProofExpiresAt: Date.now() + 300_000,
    };
    const server = encodeTask(task('Accepted from device A'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        results: [{ operationId: localId, status: 'conflict', actualRevision: 2 }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        changes: [{ sequence: '11', entity_id: taskId, entity_type: 'task',
          revision: 2, payload: server }],
        nextCursor: 11, hasMore: false,
      }) });
    vi.stubGlobal('fetch', fetchMock);
    expect((await pushAtomicTasks(session)).conflicts).toBe(1);
    expect((await db.hybridTaskOutbox.get(localId))?.state).toBe('conflict');

    const archiveId = await archiveConflictAndUseServer(taskId, 2, server);
    db.close();
    await db.open();
    expect((await db.hybridTaskResolutions.get(archiveId))?.localTask.title)
      .toBe('Device B offline edit');

    expect((await pullAtomicTasks(session)).received).toBe(1);
    expect((await db.hybridSyncMetadata.get('taskCursor'))?.value).toBe(11);
    expect((await db.tasks.get(taskId))?.title).toBe('Accepted from device A');
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(2);
    expect(await db.hybridTaskOutbox.count()).toBe(0);
    expect(await db.hybridTaskResolutions.count()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('refuses resolution if server revision is stale and preserves every local edit', async () => {
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 3 });
    const firstId = await saveServerManagedTask(task(), deviceId);
    await db.hybridTaskOutbox.update(firstId, { state: 'conflict', actualRevision: 4 });
    await expect(archiveConflictAndUseServer(taskId, 3, encodeTask(task('Stale'))))
      .rejects.toThrow('not newer');
    expect(await db.hybridTaskResolutions.count()).toBe(0);
    expect((await db.hybridTaskOutbox.get(firstId))?.state).toBe('conflict');
    expect((await db.tasks.get(taskId))?.title).toBe('Offline changes');
  });
  it('does not discard queued edits without a conflict or when a rejected operation also exists', async () => {
    const firstId = await saveServerManagedTask(task(), deviceId);
    const secondId = await saveServerManagedTask(task('Another edit'), deviceId);
    const remote = encodeTask(task('Server'));
    await expect(archiveConflictAndUseServer(taskId, 2, remote)).rejects.toThrow('No unresolved');
    await db.hybridTaskOutbox.update(firstId, { state: 'conflict', actualRevision: 2 });
    await db.hybridTaskOutbox.update(secondId, { state: 'rejected', rejectionReason: 'workshop_access_denied' });
    await expect(archiveConflictAndUseServer(taskId, 2, remote)).rejects.toThrow('Resolve rejected');
    expect(await db.hybridTaskOutbox.count()).toBe(2);
    expect(await db.hybridTaskResolutions.count()).toBe(0);
  });
});
