import { describe, expect, it } from 'vitest';
import { taskPayloadV1 } from './task-schema.js';

const id = '11111111-1111-4111-8111-111111111111';
const payload = {
  schemaVersion: 1, title: 'Formation batch 42', description: 'Run validated formation recipe',
  status: 'assigned', priority: 'high', assignedTo: id, createdBy: id,
  createdAt: '2026-11-07T06:00:00.000Z', updatedAt: '2026-11-07T06:05:00.000Z',
  dueDate: null, techCardId: null, stage: 'formation', workshopId: null,
  comments: [{ id, taskId: id, authorId: id, text: 'Ready', createdAt: '2026-11-07T06:00:00.000Z' }],
  attachments: [],
};

describe('task sync DTO v1', () => {
  it('accepts complete production tasks', () => {
    expect(taskPayloadV1.parse(payload)).toEqual(payload);
  });
  it.each(['created','assigned','in_progress','checked','completed','rejected'])('preserves status %s', status => {
    expect(taskPayloadV1.safeParse({ ...payload, status }).success).toBe(true);
  });
  it('rejects legacy lossy three-field operations', () => {
    expect(taskPayloadV1.safeParse({ title: 'Old', status: 'pending', assigneeId: null }).success).toBe(false);
  });
  it('rejects unknown fields and versions', () => {
    expect(taskPayloadV1.safeParse({ ...payload, schemaVersion: 2 }).success).toBe(false);
    expect(taskPayloadV1.safeParse({ ...payload, hidden: true }).success).toBe(false);
  });
  it('rejects invalid dates, oversized attachment data, and invalid user IDs', () => {
    expect(taskPayloadV1.safeParse({ ...payload, updatedAt: 'yesterday' }).success).toBe(false);
    expect(taskPayloadV1.safeParse({ ...payload, assignedTo: 'worker-001' }).success).toBe(false);
    expect(taskPayloadV1.safeParse({ ...payload, attachments: [{id, taskId:id, fileName:'x',fileType:'text/plain',data:'a'.repeat(1000001),createdAt:payload.createdAt}] }).success).toBe(false);
  });
  it('rejects oversized comment collections before expanding per-item validation errors', () => {
    const result = taskPayloadV1.safeParse({...payload,
      comments:Array.from({length:1001}, () => ({unexpected:'invalid comment'})),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({code:'too_big',path:['comments']});
    }
    // The legitimate boundary is unchanged; valid historical tasks still parse.
    expect(taskPayloadV1.safeParse({...payload,
      comments:Array.from({length:1000}, () => payload.comments[0]),
    }).success).toBe(true);
  });

  it('preserves PostgreSQL UUID spellings accepted by the existing v1 contract', () => {
    expect(taskPayloadV1.safeParse({...payload,
      assignedTo:'11111111-1111-1111-1111-111111111111',
    }).success).toBe(true);
  });
});
