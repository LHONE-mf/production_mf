import { isDeepStrictEqual } from 'node:util';
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

/** Existing attachments are immutable; replacements must be added as new audited records. */
export function validateTaskAttachments(incoming: TaskPayloadV1, existing?: TaskPayloadV1): string | null {
  const previous = new Map((existing?.attachments ?? []).map(attachment => [attachment.id, attachment]));
  const next = new Map(incoming.attachments.map(attachment => [attachment.id, attachment]));
  if (next.size !== incoming.attachments.length) return 'duplicate_attachment_id';
  for (const attachment of existing?.attachments ?? []) {
    const current = next.get(attachment.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(attachment)) return 'attachment_is_immutable';
  }
  return null;
}

/** Creation cannot happen after the last edit, and edits must not move the audit clock backwards. */
export function validateTaskTimestamps(incoming: TaskPayloadV1, existing?: TaskPayloadV1): string | null {
  const created = Date.parse(incoming.createdAt);
  const updated = Date.parse(incoming.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) return 'invalid_task_timestamps';
  if (existing && updated < Date.parse(existing.updatedAt)) return 'task_updated_at_regression';
  return null;
}

/**
 * Server-owned task workflow. A completed task is terminal; rejected work may
 * be reassigned for correction. Unchanged status allows ordinary field edits.
 * This policy does not grant access: device, role and task scope checks remain separate.
 */
const allowedStatusChanges: Record<TaskPayloadV1['status'], ReadonlySet<TaskPayloadV1['status']>> = {
  created: new Set(['assigned', 'rejected']),
  assigned: new Set(['created', 'in_progress', 'rejected']),
  in_progress: new Set(['checked', 'rejected']),
  checked: new Set(['in_progress', 'completed', 'rejected']),
  completed: new Set(),
  rejected: new Set(['assigned']),
};

export function validateTaskStatusTransition(incoming: TaskPayloadV1, existing?: TaskPayloadV1): string | null {
  if (!existing) return null;
  // Completion freezes the full task snapshot, not just its workflow status.
  // Retries are handled by the operation-ID ledger before this policy executes.
  if (existing.status === 'completed') {
    return isDeepStrictEqual(incoming, existing) ? null : 'completed_task_is_immutable';
  }
  if (incoming.status === existing.status) return null;
  return allowedStatusChanges[existing.status].has(incoming.status) ? null : 'invalid_task_status_transition';
}
