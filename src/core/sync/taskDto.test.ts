import { describe, expect, it } from 'vitest';
import { TaskPriority, TaskStatus, type Task } from '../types';
import { decodeTask, encodeTask, type TaskPayloadV1 } from './taskDto';

const id = '11111111-1111-4111-8111-111111111111';
const person = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-01-01T00:00:00Z');
function fixture(): Task {
  return {
    id, title: 'Example note', description: 'Test only',
    status: TaskStatus.CREATED, priority: TaskPriority.MEDIUM,
    createdBy: person, assignedTo: '', createdAt: at, updatedAt: at,
    comments: [{ id: crypto.randomUUID(), taskId: id, authorId: person, text: 'Note', createdAt: at }],
    attachments: [{ id: crypto.randomUUID(), taskId: id, fileName: 'note.txt',
      fileType: 'text/plain', data: 'example', createdAt: at }],
  };
}
describe('task JSON boundary', () => {
  it('round-trips valid notes and explicitly copies nested fields', () => {
    const original = fixture();
    const payload = encodeTask(original);
    Object.assign(payload.comments[0], { unexpected: 'do not store' });
    Object.assign(payload.attachments[0], { unexpected: 'do not store' });
    expect(decodeTask(id, payload)).toEqual(original);
  });

  it('rejects malformed remote text and collections', () => {
    const payload = encodeTask(fixture());
    for (const changed of [
      null, [], { ...payload, title: {} }, { ...payload, description: false },
      { ...payload, comments: {} }, { ...payload, attachments: 'invalid' },
      { ...payload, createdBy: [person] },
      { ...payload, comments: [{ ...payload.comments[0], text: {} }] },
      { ...payload, attachments: [{ ...payload.attachments[0], data: [] }] },
      { ...payload, comments: [null] },
    ]) {
      expect(() => decodeTask(id, changed as unknown as TaskPayloadV1)).toThrow();
    }
  });
});
