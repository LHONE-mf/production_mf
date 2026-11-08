import { describe, expect, it } from 'vitest';
import { validateTaskCreator, validateTaskComments, validateTaskAttachments } from './task-authorization.js';
import type { Principal } from './auth.js';
import type { TaskPayloadV1 } from './task-schema.js';

const actor: Principal = { id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', role: 'master' };
const payload = { createdBy: actor.id, createdAt: '2026-11-08T00:00:00.000Z' } as TaskPayloadV1;
describe('task creator policy', () => {
  it('allows a new task created by its authenticated actor', () => {
    expect(validateTaskCreator(actor, payload)).toBeNull();
  });
  it('rejects creator impersonation on new tasks', () => {
    expect(validateTaskCreator(actor, { ...payload, createdBy: '33333333-3333-4333-8333-333333333333' })).toBe('creator_must_match_actor');
  });
  it('allows updates preserving original creator and creation time', () => {
    expect(validateTaskCreator(actor, payload, payload)).toBeNull();
  });
  it('rejects reassignment of creator', () => {
    expect(validateTaskCreator(actor, { ...payload, createdBy: actor.id }, { ...payload, createdBy: '33333333-3333-4333-8333-333333333333' })).toBe('creator_is_immutable');
  });
  it('rejects changing creation timestamp', () => {
    expect(validateTaskCreator(actor, { ...payload, createdAt: '2026-11-09T00:00:00.000Z' }, payload)).toBe('creator_is_immutable');
  });
});

describe('task comment integrity', () => {
  const comment = { id: '55555555-5555-4555-8555-555555555555', taskId: '66666666-6666-4666-8666-666666666666', authorId: actor.id, text: 'Reviewed', createdAt: '2026-11-08T00:00:00.000Z' };
  it('allows comments authored by the authenticated actor', () => {
    expect(validateTaskComments(actor, { ...payload, comments: [comment] })).toBeNull();
  });
  it('rejects spoofed comment authors', () => {
    expect(validateTaskComments(actor, { ...payload, comments: [{ ...comment, authorId: '77777777-7777-4777-8777-777777777777' }] })).toBe('comment_author_must_match_actor');
  });
  it('rejects removal or editing of existing comments', () => {
    expect(validateTaskComments(actor, { ...payload, comments: [] }, { ...payload, comments: [comment] })).toBe('comment_is_immutable');
    expect(validateTaskComments(actor, { ...payload, comments: [{ ...comment, text: 'Changed' }] }, { ...payload, comments: [comment] })).toBe('comment_is_immutable');
  });
  it('rejects duplicate comment identifiers', () => {
    expect(validateTaskComments(actor, { ...payload, comments: [comment, comment] })).toBe('duplicate_comment_id');
  });
});

describe('task attachment integrity', () => {
  const attachment = { id: '55555555-5555-4555-8555-555555555555', taskId: '66666666-6666-4666-8666-666666666666', fileName: 'report.txt', fileType: 'text/plain', data: 'report', createdAt: '2026-11-08T00:00:00.000Z' };
  it('allows adding an attachment', () => {
    expect(validateTaskAttachments({ ...payload, attachments: [attachment] })).toBeNull();
  });
  it('rejects deleting an existing attachment', () => {
    expect(validateTaskAttachments({ ...payload, attachments: [] }, { ...payload, attachments: [attachment] })).toBe('attachment_is_immutable');
  });
  it('rejects changing existing attachment contents', () => {
    expect(validateTaskAttachments({ ...payload, attachments: [{ ...attachment, data: 'modified' }] }, { ...payload, attachments: [attachment] })).toBe('attachment_is_immutable');
  });
  it('rejects duplicate attachment IDs', () => {
    expect(validateTaskAttachments({ ...payload, attachments: [attachment, attachment] })).toBe('duplicate_attachment_id');
  });
});
