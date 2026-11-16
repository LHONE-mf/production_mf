import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { freezeInventoryIssue, prepareInventoryIssue, sendInventoryIssue, inventoryIssueProposals, type InventoryIssue, type InventoryIssueContext, type InventoryIssueIntent } from './inventoryIssues';
import { inventoryOutbox, inventoryScopeKey, type InventoryStockSnapshot } from './inventoryOutbox';
const scope = { serverUrl: 'https://inventory.example', organizationId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222', deviceId: '33333333-3333-4333-8333-333333333333' };
const session = { serverUrl: scope.serverUrl, accessToken: 'A'.repeat(43), deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: scope.deviceId, deviceProofExpiresAt: Date.now() + 300000 };
const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const context: InventoryIssueContext = { ...scope, warehouseLevel: 'operator', epoch, postingEnabled: true };
const intent: InventoryIssueIntent = { kind: 'request', operationId: '44444444-4444-4444-8444-444444444444', deviceId: scope.deviceId, issueId: '55555555-5555-4555-8555-555555555555', materialId: '66666666-6666-4666-8666-666666666666', productionBatchId: '77777777-7777-4777-8777-777777777777', stepNumber: 1, recipientId: '88888888-8888-4888-8888-888888888888', quantity: 500, reason: 'Original batch request', evidence: 'Original documented requirement' };
const issue: InventoryIssue = { id: intent.issueId, materialId: intent.materialId, productionBatchId: intent.productionBatchId, stepNumber: 1, workshopId: 'slurry-cathode', recipientId: intent.recipientId, requestedBy: scope.actorId, quantity: 500, unit: 'mg', state: 'requested', revision: 1, stockId: null, source: null, approvalOperationId: null, approvedStockRevision: null, approvedBy: null, approvedDeviceId: null, dispatchOperationId: null, receiptOperationId: null };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(async () => { await inventoryOutbox.delete(); await inventoryOutbox.open(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('freezes a token-free request offline, survives reopen, manually retries the same lost-ACK intent and retains acceptance', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Offline'); }));
  const row = await freezeInventoryIssue(scope, 'local', context, intent, { unit: 'mg', workshopId: 'slurry-cathode' }); expect(fetch).not.toHaveBeenCalled();
  inventoryOutbox.close(); await inventoryOutbox.open(); expect((await inventoryIssueProposals(scope, 'local'))[0]).toEqual(row);
  const posts: string[] = []; vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith('/context')) return response(context);
    posts.push(String(init?.body)); if (posts.length === 1) throw Error('Lost issue ACK');
    return response({ status: 'duplicate', operationId: intent.operationId, issue });
  }));
  await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('Lost issue ACK'); expect((await inventoryIssueProposals(scope, 'local'))[0].fields.state).toBe('pending');
  await sendInventoryIssue(session, scope, 'local', row.key); expect(posts[0]).toBe(posts[1]); const accepted = (await inventoryIssueProposals(scope, 'local'))[0]; expect(accepted.fields.state).toBe('accepted'); expect(JSON.parse(accepted.fields.acknowledgement).issue).toEqual(issue); expect(JSON.stringify(accepted)).not.toContain(session.accessToken); expect(JSON.stringify(accepted)).not.toContain(session.deviceProofToken);
  expect(await inventoryIssueProposals({ ...scope, actorId: intent.recipientId }, 'local')).toHaveLength(0);
});
it('validates exact reservation quantity and stock metadata, retains a lost ACK, and archives/cache-accepts atomically', async () => {
  const manager: InventoryIssueContext = { ...context, warehouseLevel: 'manager' };
  const base: InventoryStockSnapshot = { stockId: '99999999-9999-4999-8999-999999999999', materialId: issue.materialId, locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', manufacturerLot: 'SAME-MAKER-LOT', unit: 'mg', quality: 'released', onHand: 1000, reserved: 100, available: 900, revision: 2 };
  const action: InventoryIssueIntent = { operationId: crypto.randomUUID(), deviceId: scope.deviceId, issueId: issue.id, kind: 'reserve', expectedIssueRevision: 1, stockId: base.stockId, expectedStockRevision: 2, reason: 'Owned batch reservation', evidence: 'Requirement 42' };
  const reservedIssue: InventoryIssue = { ...issue, state: 'reserved', revision: 2, stockId: base.stockId, source: { stockId: base.stockId, materialId: base.materialId, locationId: base.locationId, manufacturerLot: base.manufacturerLot, unit: base.unit, quality: base.quality } };
  let rawStock = { ...base, reserved: 601, available: 399, revision: 3 }, managerActive = false;
  const post = vi.fn(); vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith('/context')) return response(managerActive ? manager : context);
    if (url.pathname === '/inventory/stream') return response({ ...scope, epoch, postingEnabled: true, sequence: 0 });
    post(init?.body); expect(JSON.parse(String(init?.body)).issueId).toBeUndefined(); return response({ status: 'duplicate', operationId: action.operationId, issue: reservedIssue, stock: rawStock });
  }));
  await expect(freezeInventoryIssue(scope, 'local', context, action, { issue, stock: base })).rejects.toThrow('Manager');
  const row = await freezeInventoryIssue(scope, 'local', manager, action, { issue, stock: base });
  await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('утрачены'); expect(post).not.toHaveBeenCalled(); managerActive = true;
  await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('stock acknowledgement'); expect(await inventoryOutbox.stocks.count()).toBe(0);
  rawStock = { ...base, reserved: 600, available: 400, revision: 3 };
  await inventoryOutbox.acknowledgements.add({ operationId: action.operationId, scopeKey: inventoryScopeKey(scope), epoch, kind: 'issue_reserve', stockId: base.stockId, request: { ...action, evidence: 'Conflicting retained evidence' }, base, stock: rawStock, receivedAt: Date.now() });
  await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('Conflicting retained'); expect(await inventoryOutbox.stocks.count()).toBe(0); expect((await inventoryIssueProposals(scope, 'local'))[0].fields.state).toBe('pending');
  await inventoryOutbox.acknowledgements.delete(action.operationId); await sendInventoryIssue(session, scope, 'local', row.key);
  expect((await inventoryOutbox.stocks.toArray())[0]).toMatchObject(rawStock); expect((await inventoryOutbox.acknowledgements.get(action.operationId))?.kind).toBe('issue_reserve'); expect((await inventoryIssueProposals(scope, 'local'))[0].fields.state).toBe('accepted');
});
it('accepts an exact dispatch retry after original stock expires without inferring consumption or a second debit', async () => {
  const now = Date.now(), manager: InventoryIssueContext = { ...context, warehouseLevel: 'chief' }, approvalId = crypto.randomUUID();
  const base: InventoryStockSnapshot = { stockId: '99999999-9999-4999-8999-999999999999', materialId: issue.materialId, locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', manufacturerLot: 'TRACEABLE', unit: 'mg', quality: 'released', onHand: 1000, reserved: 600, available: 400, revision: 3, expiresAt: new Date(now + 30000).toISOString() };
  const approved: InventoryIssue = { ...issue, state: 'approved', revision: 3, stockId: base.stockId, source: { stockId: base.stockId, materialId: base.materialId, locationId: base.locationId, manufacturerLot: base.manufacturerLot, unit: base.unit, quality: base.quality, expiresAt: base.expiresAt }, approvalOperationId: approvalId, approvedStockRevision: 3, approvedBy: scope.actorId, approvedDeviceId: scope.deviceId };
  const action: InventoryIssueIntent = { operationId: crypto.randomUUID(), deviceId: scope.deviceId, issueId: issue.id, kind: 'dispatch', expectedIssueRevision: 3, expectedStockRevision: 3, reason: 'Actual physical handoff', evidence: 'Signed handoff' };
  const row = await freezeInventoryIssue(scope, 'local', manager, action, { issue: approved, stock: base });
  vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname.endsWith('/context') ? response(manager) : url.pathname === '/inventory/stream' ? response({ ...scope, epoch, postingEnabled: true, sequence: 0 }) : response({ status: 'duplicate', operationId: action.operationId, issue: { ...approved, state: 'dispatched', revision: 4, dispatchOperationId: action.operationId }, stock: { ...base, onHand: 500, reserved: 100, available: 400, revision: 4 } })));
  await sendInventoryIssue(session, scope, 'local', row.key);
  expect((await inventoryOutbox.stocks.toArray())[0]).toMatchObject({ onHand: 500, reserved: 100, available: 400 });
  expect((await inventoryIssueProposals(scope, 'local'))[0].fields.acknowledgement).not.toContain('consumed');
});
it('rejects forged acceptance and retains original history, conflicts and privileged intent without rebinding', async () => {
  const row = await freezeInventoryIssue(scope, 'local', context, intent, { unit: 'mg', workshopId: 'slurry-cathode' });
  let currentEpoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status = 201, rawIssue = { ...issue, quantity: 501 };
  const posts: string[] = []; vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith('/context')) return response({ ...context, epoch: currentEpoch }); posts.push(String(init?.body)); return response({ status: 'confirmed', operationId: intent.operationId, issue: rawIssue }, status);
  }));
  await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('История'); expect(posts).toHaveLength(0);
  currentEpoch = epoch; await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow('acknowledgement'); expect((await inventoryIssueProposals(scope, 'local'))[0].fields.state).toBe('pending');
  rawIssue = issue; status = 409; await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow();
  expect((await inventoryIssueProposals(scope, 'local'))[0].fields).toMatchObject({ state: 'conflict', epoch, request: row.fields.request });
  status = 201; await expect(sendInventoryIssue(session, scope, 'local', row.key)).rejects.toThrow(); expect(posts).toHaveLength(2);
});
it('never prepares a privileged action from an issue card belonging to a previous history epoch',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response({...context,warehouseLevel:'manager',epoch:crypto.randomUUID()})));
  const action:InventoryIssueIntent={kind:'approve',operationId:crypto.randomUUID(),deviceId:scope.deviceId,issueId:issue.id,expectedIssueRevision:1,expectedStockRevision:2,reason:'Old screen',evidence:'Must not rebind'};
  await expect(prepareInventoryIssue(session,scope,'local',action,{issue},epoch)).rejects.toThrow('перепривязано');
  expect(await inventoryOutbox.receivingDrafts.count()).toBe(0);expect(fetch).toHaveBeenCalledTimes(1);
});

it('freezes tape application and operation attribution offline and refuses altered metadata acknowledgements',async()=>{
 const tapeSpecification={application:'coating_support' as const,widthMm:'12.50',thicknessUm:'25.00',reference:'Synthetic drawing'};
 const tapeIntent={...intent,tapeSpecification,operationReference:'Synthetic Coating card',quantity:2};
 const row=await freezeInventoryIssue(scope,'local',context,tapeIntent,{unit:'rolls',workshopId:'coating'});
 inventoryOutbox.close();await inventoryOutbox.open();
 const expected=JSON.parse(row.fields.expected);let wrong=true;const posts:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/context'))return response(context);
  posts.push(String(init?.body));return response({status:'duplicate',operationId:intent.operationId,issue:{...expected,operationReference:wrong?'Different operation':tapeIntent.operationReference}});
 }));
 await expect(sendInventoryIssue(session,scope,'local',row.key)).rejects.toThrow('acknowledgement');
 expect((await inventoryIssueProposals(scope,'local'))[0].fields.state).toBe('pending');wrong=false;
 await sendInventoryIssue(session,scope,'local',row.key);expect(posts[0]).toBe(posts[1]);
 expect(JSON.parse(posts[0])).toMatchObject({tapeSpecification,operationReference:tapeIntent.operationReference});
 await expect(freezeInventoryIssue(scope,'local',context,{...tapeIntent,operationId:crypto.randomUUID(),operationReference:undefined},{unit:'rolls',workshopId:'coating'})).rejects.toThrow();
});
