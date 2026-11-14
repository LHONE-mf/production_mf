import type { HybridSession } from './hybridClient';
import { inventoryRequest } from './inventoryClient';
import { validateInventoryStock, type InventoryScope, type InventoryStockSnapshot } from './inventoryOutbox';
import { issueIdValid, issueTextValid, validateIssue, type InventoryIssue, type InventoryIssueContext } from './inventoryIssueTypes';
export async function loadInventoryIssueContext(session: HybridSession, scope: InventoryScope): Promise<InventoryIssueContext> {
  const response = await inventoryRequest(session, scope, '/inventory/issues/context?' + new URLSearchParams({ deviceId: scope.deviceId }));
  if (!response.ok) throw Error('Доступ к выдаче не подтверждён: HTTP ' + response.status);
  const raw = await response.json();
  if (!raw || raw.organizationId !== scope.organizationId || raw.actorId !== scope.actorId || raw.deviceId !== scope.deviceId || !issueIdValid(raw.epoch) || typeof raw.postingEnabled !== 'boolean' || ![null, 'chief', 'manager', 'operator'].includes(raw.warehouseLevel)) throw Error('Invalid issue context');
  return { ...scope, epoch: raw.epoch, postingEnabled: raw.postingEnabled, warehouseLevel: raw.warehouseLevel };
}
export interface IssueBatch { id: string; batchCode: string; stepNumber: number; name: string; stage: string; workshopId: string }
export interface IssueOption { id: string; name: string; code?: string; unit?: InventoryStockSnapshot['unit'] }
export interface IssueLabels { materialName: string; materialCode: string; batchCode: string; recipientName: string }
export interface IssueHistory { operationId: string; sequence: number; kind: string; actorId: string; deviceId: string; reason: string; evidence: string; expectedRevision: number; resultingRevision: number; recordedAt: string }
async function page(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, path: string, extras: Record<string, string> = {}) {
  const response = await inventoryRequest(session, scope, path + '?' + new URLSearchParams({ deviceId: scope.deviceId, limit: '50', ...extras })); if (!response.ok) throw Error('Данные выдачи недоступны: HTTP ' + response.status);
  const raw = await response.json(); if (!raw || raw.epoch !== context.epoch || !Array.isArray(raw.items) || raw.items.length > 50 || typeof raw.hasMore !== 'boolean' || (raw.hasMore ? raw.items.length !== 50 || raw.nextAfter === null : raw.nextAfter !== null)) throw Error('История выдачи изменилась или страница неверна'); return raw as { items: unknown[]; hasMore: boolean; nextAfter: unknown; nextStep?: unknown; labels?: unknown };
}
export async function loadIssueBatches(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, after?: string, afterStep = 0) {
  if (after !== undefined && !issueIdValid(after) || !Number.isSafeInteger(afterStep) || afterStep < 0) throw Error('Invalid batch cursor');
  const raw = await page(session, scope, context, '/inventory/issue-batches', { ...(after ? { after } : {}), afterStep: String(afterStep) }); let previous = after ?? '', step = afterStep;
  for (const value of raw.items) { const r = value as IssueBatch; if (!r || !issueIdValid(r.id) || !issueTextValid(r.batchCode) || !issueTextValid(r.name) || !issueTextValid(r.stage) || !issueTextValid(r.workshopId) || !Number.isSafeInteger(r.stepNumber) || r.stepNumber < 1 || r.id < previous || (r.id === previous && r.stepNumber <= step)) throw Error('Invalid issue batch'); previous = r.id; step = r.stepNumber; }
  if (raw.hasMore && (raw.nextAfter !== previous || raw.nextStep !== step) || !raw.hasMore && raw.nextStep !== null) throw Error('Invalid batch continuation');
  return { items: raw.items as IssueBatch[], nextAfter: raw.hasMore ? previous : null, nextStep: raw.hasMore ? step : 0 };
}
export async function loadIssueOptions(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, batch: IssueBatch, resource: 'materials' | 'recipients', after?: string) {
  if (!issueIdValid(batch.id) || !Number.isSafeInteger(batch.stepNumber) || batch.stepNumber < 1 || after !== undefined && !issueIdValid(after)) throw Error('Invalid issue options scope');
  const raw = await page(session, scope, context, '/inventory/issue-options', { productionBatchId: batch.id, stepNumber: String(batch.stepNumber), resource, ...(after ? { after } : {}) }); let previous = after ?? '';
  for (const value of raw.items) { const r = value as IssueOption; if (!r || !issueIdValid(r.id) || r.id <= previous || !issueTextValid(r.name) || (resource === 'materials' && (!issueTextValid(r.code) || !['mg', 'ul', 'mm', 'pieces'].includes(r.unit ?? '')))) throw Error('Invalid issue option'); previous = r.id; }
  if (raw.hasMore && raw.nextAfter !== previous) throw Error('Invalid options continuation'); return { items: raw.items as IssueOption[], nextAfter: raw.hasMore ? previous : null };
}
export async function loadInventoryIssues(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, after?: string) {
  if (after !== undefined && !issueIdValid(after)) throw Error('Invalid issue cursor'); const raw = await page(session, scope, context, '/inventory/issues', after ? { after } : {}); let previous = after ?? '';
  for (const value of raw.items) { validateIssue(value); if (value.id <= previous) throw Error('Invalid issue order'); previous = value.id; }
  if (raw.hasMore && raw.nextAfter !== previous || !Array.isArray(raw.labels) || raw.labels.length !== raw.items.length) throw Error('Invalid issue continuation/labels');
  const labels: Record<string,IssueLabels> = {};
  for(const value of raw.labels){ const r=value as IssueLabels & {issueId:string}; if(!r||!issueIdValid(r.issueId)||!(raw.items as InventoryIssue[]).some(i=>i.id===r.issueId)||labels[r.issueId]||![r.materialName,r.materialCode,r.batchCode,r.recipientName].every(issueTextValid))throw Error('Invalid issue labels'); labels[r.issueId]={materialName:r.materialName,materialCode:r.materialCode,batchCode:r.batchCode,recipientName:r.recipientName}; }
  return { items: raw.items as InventoryIssue[], labels, nextAfter: raw.hasMore ? previous : null };
}
export async function loadIssueSources(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, issue: InventoryIssue, after?: string) {
  validateIssue(issue); if (after !== undefined && !issueIdValid(after)) throw Error('Invalid source cursor'); const raw = await page(session, scope, context, '/inventory/issue-sources', { issueId: issue.id, ...(after ? { after } : {}) }); let previous = after ?? '';
  for (const value of raw.items) { validateInventoryStock(value); if (value.materialId !== issue.materialId || value.unit !== issue.unit || value.stockId <= previous || ('eligible' in value && typeof value.eligible !== 'boolean')) throw Error('Invalid issue source'); previous = value.stockId; }
  if (raw.hasMore && raw.nextAfter !== previous) throw Error('Invalid source continuation'); return { items: raw.items as (InventoryStockSnapshot & {eligible?:boolean})[], nextAfter: raw.hasMore ? previous : null };
}
export async function loadIssueHistory(session: HybridSession, scope: InventoryScope, context: InventoryIssueContext, issueId: string, after = 0) {
  if (!issueIdValid(issueId) || !Number.isSafeInteger(after) || after < 0) throw Error('Invalid history cursor'); const raw = await page(session, scope, context, '/inventory/issues/' + issueId + '/history', { after: String(after) }); let previous = after;
  for (const value of raw.items) { const r = value as IssueHistory; if (!r || ![r.operationId, r.actorId, r.deviceId].every(issueIdValid) || !Number.isSafeInteger(r.sequence) || r.sequence <= previous || !['request', 'reserve', 'approve', 'dispatch', 'receive', 'cancel'].includes(r.kind) || !issueTextValid(r.reason) || !issueTextValid(r.evidence) || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 || r.resultingRevision !== r.expectedRevision + 1 || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt))) throw Error('Invalid issue history'); previous = r.sequence; }
  if (raw.hasMore && raw.nextAfter !== previous) throw Error('Invalid history continuation'); return { items: raw.items as IssueHistory[], nextAfter: raw.hasMore ? previous : null };
}
