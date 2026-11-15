import type { HybridSession } from './hybridClient';
import type { InventoryScope } from './inventoryOutbox';
import { inventoryRequest } from './inventoryClient';
import { issueIdValid, type InventoryIssueContext } from './inventoryIssueTypes';
import { validateReturnChoice, validateSettlement, validateOutcome, type InventoryReturnChoice, type InventoryOutcome } from './inventoryOutcomeTypes';
export async function loadInventoryReturnChoices(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, after?: string) {
  if (after !== undefined && !issueIdValid(after)) throw Error('Invalid return cursor');
  const response = await inventoryRequest(session, scope, '/inventory/returns?' + new URLSearchParams({ deviceId: scope.deviceId, limit: '50', ...(after ? { after } : {}) })); if (!response.ok) throw Error('Источники возврата недоступны: HTTP ' + response.status);
  const raw = await response.json(); if (!raw || raw.epoch !== context.epoch || !Array.isArray(raw.items) || raw.items.length > 50 || typeof raw.hasMore !== 'boolean') throw Error('История или область возврата изменилась'); let previous = after ?? '';
  for (const item of raw.items) { validateReturnChoice(item); if (item.issue.id <= previous) throw Error('Invalid return order'); previous = item.issue.id; }
  if (raw.hasMore ? raw.items.length !== 50 || raw.nextAfter !== previous : raw.nextAfter !== null) throw Error('Invalid return continuation'); return { items: raw.items as InventoryReturnChoice[], nextAfter: raw.hasMore ? previous : null };
}
export async function loadInventoryOutcomes(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, issueId: string, after = 0) {
  if (!issueIdValid(issueId) || !Number.isSafeInteger(after) || after < 0) throw Error('Invalid outcome cursor');
  const response = await inventoryRequest(session, scope, '/inventory/issues/' + issueId + '/outcomes?' + new URLSearchParams({ deviceId: scope.deviceId, limit: '50', after: String(after) })); if (!response.ok) throw Error('История возврата недоступна: HTTP ' + response.status);
  const raw = await response.json(); if (!raw || raw.epoch !== context.epoch || !Array.isArray(raw.items) || raw.items.length > 50 || typeof raw.hasMore !== 'boolean') throw Error('Invalid outcome page'); validateSettlement(raw.settlement); let previous = after;
  for (const item of raw.items) { validateOutcome(item); if (item.issueId !== issueId || item.sequence === undefined || item.sequence <= previous) throw Error('Invalid outcome history'); previous = item.sequence; }
  if (raw.hasMore ? raw.items.length !== 50 || raw.nextAfter !== previous : raw.nextAfter !== null) throw Error('Invalid outcome continuation'); return { items: raw.items as InventoryOutcome[], settlement: raw.settlement, nextAfter: raw.hasMore ? previous : null };
}
