import { describe, expect, it } from 'vitest';
import { validateTaskCreator } from './task-authorization.js';
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
