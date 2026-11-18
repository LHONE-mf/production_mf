import { describe, expect, it } from 'vitest';
import { StageId, TaskPriority, TaskStatus, type Task } from '../types';
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
interface MutableNested {
  comments: Array<{ text: string }>;
  attachments: Array<{ fileName: string; fileType: string; data: string }>;
}
const incompatibleChildren: Array<[string, (record: MutableNested) => void]> = [
  ['more than 1000 comments', record => { record.comments = Array.from({ length: 1001 }, () => ({ ...record.comments[0] })); }],
  ['more than 30 attachments', record => { record.attachments = Array.from({ length: 31 }, () => ({ ...record.attachments[0] })); }],
  ['comment text longer than 10000 characters', record => { record.comments[0].text = 'x'.repeat(10_001); }],
  ['attachment data longer than 1000000 characters', record => { record.attachments[0].data = 'x'.repeat(1_000_001); }],
  ['attachment filename longer than 255 characters', record => { record.attachments[0].fileName = 'x'.repeat(256); }],
  ['attachment media type longer than 120 characters', record => { record.attachments[0].fileType = 'x'.repeat(121); }],
];

describe('task JSON boundary', () => {
  it('round-trips valid notes and explicitly copies nested fields', () => {
    const original = fixture();
    const payload = encodeTask(original);
    Object.assign(payload.comments[0], { unexpected: 'do not store' });
    Object.assign(payload.attachments[0], { unexpected: 'do not store' });
    expect(decodeTask(id, payload)).toEqual(original);
  });

  it('rejects invalid stage and workshop fields before queuing a task', () => {
    for (const changes of [
      { stage: 'unknown-room' }, { stage: 42 }, { workshopId: 7 },
      { workshopId: 'w'.repeat(121) },
    ]) {
      expect(() => encodeTask({ ...fixture(), ...changes } as Task)).toThrow();
    }
    expect(encodeTask({ ...fixture(), stage: StageId.SORTING, workshopId: 'room-1' }))
      .toMatchObject({ stage: 'sorting', workshopId: 'room-1' });
  });

  it('rejects invalid remote stage and workshop fields instead of storing them', () => {
    const payload = encodeTask(fixture());
    for (const changes of [
      { stage: 'unknown-room' }, { stage: { id: 'sorting' } },
      { workshopId: ['room-1'] }, { workshopId: 'w'.repeat(121) },
    ]) {
      expect(() => decodeTask(id, { ...payload, ...changes } as TaskPayloadV1)).toThrow();
    }
  });

  it.each(incompatibleChildren)('rejects %s before offline serialization', (_name, corrupt) => {
    const task = fixture();
    corrupt(task);
    expect(() => encodeTask(task)).toThrow();
  });

  it.each(incompatibleChildren)('rejects %s from a remote task snapshot', (_name, corrupt) => {
    const payload = encodeTask(fixture());
    corrupt(payload);
    expect(() => decodeTask(id, payload)).toThrow();
  });

  it('rejects falsey malformed nullable fields from remote server snapshots', () => {
    const base = encodeTask(fixture());
    for (const payload of [
      { ...base, assignedTo: false },
      { ...base, assignedTo: 0 },
      { ...base, assignedTo: '' },
      { ...base, techCardId: false },
      { ...base, techCardId: 0 },
      { ...base, techCardId: '' },
      { ...base, dueDate: false },
      { ...base, dueDate: 0 },
      { ...base, dueDate: '' },
    ]) {
      expect(() => decodeTask(id, payload as unknown as TaskPayloadV1)).toThrow('Invalid optional task field');
    }
  });

  it('refuses malformed optional task fields before encoding an offline operation', () => {
    for (const changed of [
      { assignedTo: false },
      { assignedTo: 0 },
      { techCardId: false },
      { techCardId: 0 },
      { dueDate: false },
      { dueDate: 0 },
    ]) {
      expect(() => encodeTask({ ...fixture(), ...changed } as unknown as Task))
        .toThrow('Invalid optional task field');
    }
  });

  it.each([
    ['unsupported status', { status: 'on_hold' as TaskStatus }],
    ['update earlier than creation', { updatedAt: new Date('2025-12-31T23:59:59Z') }],
  ])('rejects %s at the shared outbound JSON boundary', (_case, fields) => {
    expect(() => encodeTask({ ...fixture(), ...fields })).toThrow('Invalid task');
  });

  it.each([
    ['empty title', { title: '' }],
    ['oversized title', { title: 'x'.repeat(301) }],
    ['oversized description', { description: 'x'.repeat(20_001) }],
    ['unknown priority', { priority: 'urgent' }],
  ])('rejects %s at the outbound task JSON boundary', (_name, changes) => {
    expect(() => encodeTask({ ...fixture(), ...changes } as Task)).toThrow('Invalid task');
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
