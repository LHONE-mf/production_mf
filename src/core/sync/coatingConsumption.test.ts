import {beforeEach, describe, it, expect, vi} from 'vitest';
import {db} from '../db';
import {UserRole} from '../types';
import {inventoryOutbox} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryIssueContext} from './inventoryIssueClient';
import {
  freezeCoatingConsumption,
  sendCoatingConsumption,
  coatingConsumptionProposals,
  copyCoatingSlurrySource,
  loadCoatingSlurry,
} from './coatingConsumption';
vi.mock('./inventoryClient', () => ({inventoryRequest: vi.fn()}));
vi.mock('./inventoryIssueClient', () => ({loadInventoryIssueContext: vi.fn()}));
const id = () => crypto.randomUUID(),
  scope = {serverUrl: 'https://factory.test', organizationId: id(), actorId: id(), deviceId: id()},
  epoch = id(),
  actor = 'local-coating-worker',
  at = new Date().toISOString(),
  batch = id();
function source() {
  const ingredientIssue = id(),
    materialId = id(),
    allocationId = id(),
    inputId = id();
  const consumed = {
    operationId: inputId,
    deviceId: id(),
    productionBatchId: batch,
    stepNumber: 1,
    source: {
      id: id(),
      recordedAt: 1000.5,
      recordedBy: 'slurry-local',
      recordedRole: 'worker',
      batchCode: 'ACTUAL',
      recipeId: null,
      recipeRevision: null,
      recipeName: 'Actual measured source',
      measurementNote: 'Scale',
      components: [{componentId: 'powder', componentVersion: 1, actualMg: 1000}],
    },
    allocations: [
      {
        operationId: allocationId,
        issueId: ingredientIssue,
        materialId,
        componentId: 'powder',
        quantity: 1000,
        expectedSettlementRevision: 1,
      },
    ],
    reason: 'Actual input',
    evidence: 'Scale',
    room: 'slurry',
    actorId: id(),
    recordedAt: at,
    warehouseEffect: 'none',
  };
  const outputId = id(),
    declarationId = id(),
    declaration = {
      operationId: declarationId,
      deviceId: id(),
      consumptionId: inputId,
      outputs: [{id: outputId, materialId, quantity: 900}],
      scrapMg: 0,
      measuredLossMg: 50,
      unknownMg: 50,
      basis: 'weighed-slurry-mass',
      specificationReference: 'Product card',
      observedAt: 1000,
      reason: 'Actual output',
      evidence: 'Net scale',
      productionBatchId: batch,
      stepNumber: 1,
      inputQuantity: 1000,
      source: {
        consumption: consumed,
        parents: [
          {
            issueId: ingredientIssue,
            sourceStockId: id(),
            materialId,
            manufacturerLot: 'Vendor lot',
            receiptOperationId: id(),
            componentId: 'powder',
            quantity: 1000,
            unit: 'mg',
            consumptionOperationId: allocationId,
          },
        ],
      },
      actorId: id(),
      recordedAt: at,
      qualityStatus: 'unreviewed',
      warehouseEffect: 'none',
    };
  const handoff = {
    operationId: id(),
    deviceId: id(),
    outputLotId: outputId,
    quantity: 400,
    expectedSourceRevision: 1,
    recipientId: scope.actorId,
    destinationStepNumber: 2,
    reason: 'Physical transfer',
    evidence: 'Counted container',
    productionBatchId: batch,
    sourceRoom: 'slurry',
    destinationRoom: 'coating',
    recipientWorkshopId: 'coating',
    sourceSnapshot: {
      id: outputId,
      declarationId,
      materialId,
      quantity: 900,
      unit: 'mg',
      consumptionId: inputId,
      declaration,
    },
    actorId: id(),
    recordedAt: at,
    unit: 'mg',
    warehouseEffect: 'none',
  };
  return copyCoatingSlurrySource({
    receipt: {
      operationId: id(),
      deviceId: scope.deviceId,
      handoffId: handoff.operationId,
      kind: 'receive',
      observedQuantity: 400,
      reason: 'Exact receiver weighing',
      evidence: 'Measured receipt',
      sourceSnapshot: handoff,
      actorId: scope.actorId,
      recordedAt: at,
      custodyEffect: 'received',
      unit: 'mg',
      warehouseEffect: 'none',
    },
    received: 400,
    consumed: 0,
    remaining: 400,
    revision: 1,
    productionBatchId: batch,
    stepNumber: 2,
    materialId,
    materialCode: 'SLURRY',
    materialName: 'Measured Slurry',
    batchCode: 'ACTUAL',
    eligible: true,
    unit: 'mg',
  });
}
const request = (s: ReturnType<typeof source>) => ({
  operationId: id(),
  deviceId: scope.deviceId,
  productionBatchId: batch,
  stepNumber: 2,
  observedAt: 1000.5,
  reference: ' Coating actual-use observation ',
  actualMg: 300,
  allocations: [{operationId: id(), receiptId: s.receipt.operationId, quantity: 300, expectedRevision: 1}],
  reason: 'Actual measured use',
  evidence: 'Scale observation, never calculated pump flow',
});
const result = (r: ReturnType<typeof request>, s: ReturnType<typeof source>) => ({
  ...r,
  room: 'coating',
  unit: 'mg',
  actorId: scope.actorId,
  recordedAt: at,
  warehouseEffect: 'none',
  sources: [
    {
      allocationOperationId: r.allocations[0].operationId,
      source: {
        receipt: s.receipt,
        received: s.received,
        consumed: s.consumed,
        remaining: s.remaining,
        revision: s.revision,
      },
    },
  ],
});
beforeEach(async () => {
  await db.delete();
  await db.open();
  await inventoryOutbox.delete();
  await inventoryOutbox.open();
  await db.users.put({id: actor, isActive: true, role: UserRole.WORKER} as never);
  vi.mocked(inventoryRequest).mockReset();
  vi.mocked(loadInventoryIssueContext).mockResolvedValue({
    ...scope,
    epoch,
    postingEnabled: true,
    warehouseLevel: null,
  });
});
describe('durable actual Coating Slurry use', () => {
  it('retains offline original measurements through reopen, lost committed reply and exact byte retry', async () => {
    const s = source(),
      r = request(s),
      row = await freezeCoatingConsumption(scope, actor, epoch, r, [s]);
    expect(inventoryRequest).not.toHaveBeenCalled();
    await inventoryOutbox.close();
    await inventoryOutbox.open();
    vi.mocked(inventoryRequest)
      .mockRejectedValueOnce(Error('Committed reply lost'))
      .mockResolvedValue(
        new Response(
          JSON.stringify({status: 'duplicate', operationId: r.operationId, consumption: result(r, s)}),
          {status: 200},
        ),
      );
    await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow('lost');
    await sendCoatingConsumption({} as never, scope, actor, row.key);
    expect(vi.mocked(inventoryRequest).mock.calls.map((c) => c[3]?.body)).toEqual([
      JSON.stringify(r),
      JSON.stringify(r),
    ]);
    expect((await coatingConsumptionProposals(scope, actor))[0].fields.state).toBe('accepted');
    expect(await inventoryOutbox.stocks.count()).toBe(0);
  });
  it('refuses inferred/incomplete allocations and local overlap against one original source revision', async () => {
    const s = source(),
      r = request(s);
    await expect(freezeCoatingConsumption(scope, actor, epoch, {...r, actualMg: 301}, [s])).rejects.toThrow();
    await freezeCoatingConsumption(scope, actor, epoch, r, [s]);
    await expect(
      freezeCoatingConsumption(scope, actor, epoch, {...r, operationId: id()}, [s]),
    ).rejects.toThrow();
    expect(() => copyCoatingSlurrySource({...s, remaining: 401})).toThrow();
    expect(() =>
      copyCoatingSlurrySource({...s, receipt: {...s.receipt, kind: 'discrepancy', custodyEffect: 'none'}}),
    ).toThrow();
  });
  it('preserves unknown/denied responses and refuses stale epoch, changed local role and false ACK', async () => {
    const s = source(),
      r = request(s),
      row = await freezeCoatingConsumption(scope, actor, epoch, r, [s]);
    vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({
      ...scope,
      epoch: id(),
      postingEnabled: true,
      warehouseLevel: null,
    });
    await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow();
    expect(inventoryRequest).not.toHaveBeenCalled();
    vi.mocked(inventoryRequest).mockResolvedValueOnce(new Response('{}', {status: 403}));
    await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow();
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('pending');
    vi.mocked(inventoryRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'confirmed',
          operationId: r.operationId,
          consumption: {...result(r, s), actualMg: 301},
        }),
        {status: 201},
      ),
    );
    await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow();
    await db.users.update(actor, {role: UserRole.MASTER});
    vi.mocked(inventoryRequest).mockClear();
    await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow();
    expect(inventoryRequest).not.toHaveBeenCalled();
  });
  it('keeps an original pending request when ACK storage fails and never overwrites a newer conflict', async () => {
    const s = source(),
      r = request(s),
      row = await freezeCoatingConsumption(scope, actor, epoch, r, [s]),
      ack = {status: 'confirmed', operationId: r.operationId, consumption: result(r, s)};
    vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(ack), {status: 201}));
    const fail = () => {
      throw Error('ACK storage failed');
    };
    inventoryOutbox.receivingDrafts.hook('updating', fail);
    try {
      await expect(sendCoatingConsumption({} as never, scope, actor, row.key)).rejects.toThrow(
        'ACK storage failed',
      );
    } finally {
      inventoryOutbox.receivingDrafts.hook('updating').unsubscribe(fail);
    }
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields).toEqual(row.fields);
    let finish!: (r: Response) => void;
    vi.mocked(inventoryRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sending = sendCoatingConsumption({} as never, scope, actor, row.key);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await inventoryOutbox.receivingDrafts.put({
      ...row,
      revision: 2,
      fields: {...row.fields, state: 'conflict'},
    });
    finish(new Response(JSON.stringify(ack), {status: 201}));
    await expect(sending).rejects.toThrow();
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('conflict');
  });
  it('validates scoped source pages and drops unrecognized network fields', async () => {
    const s = source();
    vi.mocked(inventoryRequest).mockResolvedValue(
      new Response(
        JSON.stringify({
          ...scope,
          epoch,
          postingEnabled: true,
          items: [{...s, accessToken: 'never-retain'}],
          hasMore: false,
          nextAfter: null,
        }),
        {status: 200},
      ),
    );
    expect((await loadCoatingSlurry({} as never, scope)).items[0]).not.toHaveProperty('accessToken');
    vi.mocked(inventoryRequest).mockResolvedValue(
      new Response(
        JSON.stringify({
          ...scope,
          actorId: id(),
          epoch,
          postingEnabled: true,
          items: [s],
          hasMore: false,
          nextAfter: null,
        }),
        {status: 200},
      ),
    );
    await expect(loadCoatingSlurry({} as never, scope)).rejects.toThrow();
  });
});
