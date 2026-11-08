import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { saveServerManagedTask } from './atomicTasks';
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
describe('server-managed task offline writes', () => {
  beforeEach(async () => {
    await db.open();
    await db.transaction('rw', db.tasks, db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
      await db.tasks.clear();
      await db.hybridTaskOutbox.clear();
      await db.hybridTaskRevisions.clear();
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
  it('rejects invalid device identity without persisting task', async () => {
    await expect(saveServerManagedTask(task(), 'not-a-uuid')).rejects.toThrow('deviceId must be a UUID');
    expect(await db.tasks.get(taskId)).toBeUndefined();
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });
});
