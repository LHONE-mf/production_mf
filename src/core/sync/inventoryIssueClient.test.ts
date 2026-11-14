import { afterEach, expect, it, vi } from 'vitest';
import { loadInventoryIssueContext, loadIssueBatches, loadIssueOptions, loadInventoryIssues, loadIssueHistory } from './inventoryIssueClient';
import type { InventoryIssueContext } from './inventoryIssueTypes';
const scope = { serverUrl: 'https://inventory.example', organizationId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', deviceId: '33333333-3333-4333-8333-333333333333' };
const session = { serverUrl: scope.serverUrl, accessToken: 'A'.repeat(43), deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: scope.deviceId, deviceProofExpiresAt: Date.now() + 300000 };
const context: InventoryIssueContext = { ...scope, warehouseLevel: null, epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', postingEnabled: true };
const batch = { id: '44444444-4444-4444-8444-444444444444', batchCode: 'Real batch code', stepNumber: 1, name: 'Slurry', stage: 'slurry', workshopId: 'slurry' };
const mock = (raw: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(raw))));
afterEach(() => vi.unstubAllGlobals());
it('binds production context to the exact actor/device/tenant and rejects malformed or mixed-history pages', async () => {
  mock({ ...context, actorId: batch.id }); await expect(loadInventoryIssueContext(session, scope)).rejects.toThrow('context');
  mock(context); expect(await loadInventoryIssueContext(session, scope)).toMatchObject({ warehouseLevel: null, actorId: scope.actorId });
  mock({ epoch: context.epoch, items: [batch], hasMore: false, nextAfter: null, nextStep: null }); expect((await loadIssueBatches(session, scope, context)).items).toEqual([batch]);
  mock({ epoch: crypto.randomUUID(), items: [batch], hasMore: false, nextAfter: null, nextStep: null }); await expect(loadIssueBatches(session, scope, context)).rejects.toThrow('История');
  mock({ epoch: context.epoch, items: [batch, batch], hasMore: false, nextAfter: null, nextStep: null }); await expect(loadIssueBatches(session, scope, context)).rejects.toThrow('batch');
  mock({ epoch: context.epoch, items: [batch], hasMore: true, nextAfter: batch.id, nextStep: 1 }); await expect(loadIssueBatches(session, scope, context)).rejects.toThrow();
});
it('rejects unsafe units, forged history attribution and missing labels before displaying a server response', async () => {
  mock({ epoch: context.epoch, items: [{ id: batch.id, name: 'Powder', code: 'P', unit: 'kg' }], hasMore: false, nextAfter: null }); await expect(loadIssueOptions(session, scope, context, batch, 'materials')).rejects.toThrow('option');
  mock({ epoch: context.epoch, items: [{ id: batch.id, name: 'Assigned operator' }], hasMore: false, nextAfter: null }); expect((await loadIssueOptions(session, scope, context, batch, 'recipients')).items[0].name).toBe('Assigned operator');
  mock({ epoch: context.epoch, items: [{ operationId: batch.id, sequence: 1, kind: 'receive', actorId: 'forged', deviceId: scope.deviceId, reason: 'Receipt', evidence: 'Signed', expectedRevision: 4, resultingRevision: 5, recordedAt: new Date().toISOString() }], hasMore: false, nextAfter: null }); await expect(loadIssueHistory(session, scope, context, batch.id)).rejects.toThrow('history');
  mock({ epoch: context.epoch, items: [], hasMore: false, nextAfter: null }); await expect(loadInventoryIssues(session, scope, context)).rejects.toThrow('labels');
});
