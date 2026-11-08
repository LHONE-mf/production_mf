import type { Principal } from './auth.js';
import type { TaskPayloadV1 } from './task-schema.js';

/** A creator is immutable. A newly created task must be attributed to its authenticated author. */
export function validateTaskCreator(principal: Principal, incoming: TaskPayloadV1, existing?: TaskPayloadV1): string | null {
  if (!existing && incoming.createdBy !== principal.id) return 'creator_must_match_actor';
  if (existing && (incoming.createdBy !== existing.createdBy || incoming.createdAt !== existing.createdAt)) {
    return 'creator_is_immutable';
  }
  return null;
}

/** Existing comments cannot be edited or deleted through a whole-task upsert. */
export function validateTaskComments(principal: Principal, incoming: TaskPayloadV1, existing?: TaskPayloadV1): string | null {
  const previous = new Map((existing?.comments ?? []).map(comment => [comment.id, comment]));
  const next = new Map(incoming.comments.map(comment => [comment.id, comment]));
  if (next.size !== incoming.comments.length) return 'duplicate_comment_id';
  for (const comment of existing?.comments ?? []) {
    const current = next.get(comment.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(comment)) return 'comment_is_immutable';
  }
  for (const comment of incoming.comments) {
    if (!previous.has(comment.id) && comment.authorId !== principal.id) return 'comment_author_must_match_actor';
  }
  return null;
}
