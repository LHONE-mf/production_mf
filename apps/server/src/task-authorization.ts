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
