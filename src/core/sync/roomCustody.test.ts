import {beforeEach, describe, it, expect, vi} from 'vitest';
import {db} from '../db';
import {UserRole} from '../types';
import {inventoryOutbox} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryIssueContext} from './inventoryIssueClient';
import {
  freezeRoomCustody,
  sendRoomCustody,
  measuredMg,
  roomCustodyProposals,
  loadSlurryOutputSources,
} from './roomCustody';
import {copySlurrySource, copyDeclaration, copyHandoff, copyRoomHandoff} from './roomCustodyTypes';
vi.mock('./inventoryClient', () => ({inventoryRequest: vi.fn()}));
vi.mock('./inventoryIssueClient', () => ({loadInventoryIssueContext: vi.fn()}));
const id = () => crypto.randomUUID(),
  scope = {serverUrl: 'https://factory.test', organizationId: id(), actorId: id(), deviceId: id()},
  actor = 'local-custody-worker',
  epoch = id();
const batchId = id(),
  consumptionId = id(),
  issueId = id(),
  materialId = id(),
  childId = id(),
  at = new Date().toISOString();
const consumption = {
  operationId: consumptionId,
  deviceId: scope.deviceId,
  productionBatchId: batchId,
  stepNumber: 1,
  source: {
    id: id(),
    recordedAt: 1000,
    recordedBy: actor,
    recordedRole: 'worker',
    batchCode: 'SYNTHETIC-ONLY',
    recipeId: null,
    recipeRevision: null,
    recipeName: 'Measured recipe',
    measurementNote: 'Actual scale',
    components: [{componentId: 'binder', componentVersion: 1, actualMg: 1000}],
  },
  allocations: [
    {
      operationId: childId,
      issueId,
      materialId,
      componentId: 'binder',
      quantity: 1000,
      expectedSettlementRevision: 1,
    },
  ],
  reason: 'Measured input',
  evidence: 'Scale',
  room: 'slurry' as const,
  actorId: scope.actorId,
  recordedAt: at,
  warehouseEffect: 'none' as const,
};
const source = () => ({
  operationId: consumptionId,
  productionBatchId: batchId,
  stepNumber: 1,
  inputQuantity: 1000,
  declarationId: null,
  eligible: true,
  sourceSnapshot: {
    consumption,
    parents: [
      {
        issueId,
        sourceStockId: id(),
        materialId,
        manufacturerLot: 'Vendor lot',
        receiptOperationId: id(),
        componentId: 'binder',
        quantity: 1000,
        unit: 'mg' as const,
        consumptionOperationId: childId,
      },
    ],
  },
});
const request = () => ({
  operationId: id(),
  deviceId: scope.deviceId,
  consumptionId,
  outputs: [{id: id(), materialId, quantity: 900}],
  scrapMg: 0,
  measuredLossMg: 50,
  unknownMg: 50,
  basis: 'weighed-slurry-mass' as const,
  specificationReference: 'Approved card',
  observedAt: 1000,
  reason: 'Actual product',
  evidence: 'Measured net output',
});
function declaration(r = request(), s = source()) {
  return {
    ...r,
    productionBatchId: batchId,
    stepNumber: 1,
    inputQuantity: 1000,
    source: s.sourceSnapshot,
    actorId: scope.actorId,
    recordedAt: at,
    qualityStatus: 'unreviewed' as const,
    warehouseEffect: 'none' as const,
  };
}
function lot() {
  const d = declaration();
  return {
    id: d.outputs[0].id,
    materialId,
    materialCode: 'WIP',
    materialName: 'Slurry',
    productionBatchId: batchId,
    stepNumber: 1,
    quantity: 900,
    available: 900,
    inTransit: 0,
    received: 0,
    revision: 1,
    unit: 'mg' as const,
    qualityStatus: 'unreviewed' as const,
    eligible: true,
    sourceSnapshot: {
      id: d.outputs[0].id,
      declarationId: d.operationId,
      materialId,
      quantity: 900,
      unit: 'mg' as const,
      consumptionId,
      declaration: d,
    },
  };
}
const offer = (l = lot()) => ({
  operationId: id(),
  deviceId: scope.deviceId,
  outputLotId: l.id,
  quantity: 400,
  expectedSourceRevision: 1,
  recipientId: id(),
  destinationStepNumber: 2,
  reason: 'Actual transfer',
  evidence: 'Counted container',
});
beforeEach(async () => {
  await db.delete();
  await db.open();
  await inventoryOutbox.delete();
  await inventoryOutbox.open();
  await db.users.put({id: actor, role: UserRole.WORKER, isActive: true} as never);
  vi.mocked(loadInventoryIssueContext).mockResolvedValue({
    ...scope,
    epoch,
    postingEnabled: true,
    warehouseLevel: null,
  });
  vi.mocked(inventoryRequest).mockReset();
});
describe('durable measured Slurry output and explicit custody', () => {
  it('validates real source genealogy and exact output mass, keeping unknown distinct from zero', () => {
    const s = source(),
      r = request();
    expect(copySlurrySource(s).inputQuantity).toBe(1000);
    const fractional = structuredClone(s);
    fractional.sourceSnapshot.consumption.source.recordedAt = 1000.5;
    expect(copySlurrySource(fractional).sourceSnapshot.consumption.source.recordedAt).toBe(1000.5);
    expect(copyDeclaration(declaration(r, s)).unknownMg).toBe(50);
    expect(() => copyDeclaration({...declaration(r, s), unknownMg: 0})).toThrow();
    expect(() => copySlurrySource({...s, sourceSnapshot: {...s.sourceSnapshot, parents: []}})).toThrow();
    expect(() => copyDeclaration({...declaration(r, s), scrapMg: -1})).toThrow();
  });
  it('freezes original output offline and recovers a lost committed reply after reopen with identical bytes', async () => {
    const s = source(),
      r = request(),
      row = await freezeRoomCustody(scope, actor, epoch, 'declaration', r, s);
    expect(inventoryRequest).not.toHaveBeenCalled();
    await inventoryOutbox.close();
    await inventoryOutbox.open();
    const ack = {status: 'duplicate', operationId: r.operationId, declaration: declaration(r, s)};
    vi.mocked(inventoryRequest)
      .mockRejectedValueOnce(Error('Lost reply'))
      .mockResolvedValue(new Response(JSON.stringify(ack), {status: 200}));
    await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow('Lost');
    await sendRoomCustody({} as never, scope, actor, row.key);
    expect(vi.mocked(inventoryRequest).mock.calls.map((c) => c[3]?.body)).toEqual([
      JSON.stringify(r),
      JSON.stringify(r),
    ]);
    expect((await roomCustodyProposals(scope, actor))[0].fields.state).toBe('accepted');
    expect(await inventoryOutbox.stocks.count()).toBe(0);
  });
  it('prevents source adoption and freezes pending partial offer budgets without inventing receipt', async () => {
    const s = source(),
      r = request();
    await freezeRoomCustody(scope, actor, epoch, 'declaration', r, s);
    await expect(
      freezeRoomCustody({...scope, actorId: id()}, actor, epoch, 'declaration', {...r, operationId: id()}, s),
    ).rejects.toThrow();
    const l = lot(),
      a = offer(l);
    await freezeRoomCustody(scope, actor, epoch, 'handoff', a, l);
    await expect(
      freezeRoomCustody(scope, actor, epoch, 'handoff', {...offer(l), quantity: 600}, l),
    ).rejects.toThrow();
    expect(
      (await roomCustodyProposals(scope, actor)).filter((p) => p.fields.command === 'receipt'),
    ).toHaveLength(0);
  });
  it('keeps pending evidence on false ACK, stale epoch, lost authority and rejects late ACK over a conflict', async () => {
    const s = source(),
      r = request(),
      row = await freezeRoomCustody(scope, actor, epoch, 'declaration', r, s);
    vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({
      ...scope,
      epoch: id(),
      postingEnabled: true,
      warehouseLevel: null,
    });
    await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow('История');
    expect(inventoryRequest).not.toHaveBeenCalled();
    vi.mocked(inventoryRequest).mockResolvedValueOnce(new Response('{}', {status: 403}));
    await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow();
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('pending');
    vi.mocked(inventoryRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'confirmed',
          operationId: r.operationId,
          declaration: {...declaration(r, s), actorId: id()},
        }),
        {status: 201},
      ),
    );
    await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow();
    let finish!: (r: Response) => void;
    vi.mocked(inventoryRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sending = sendRoomCustody({} as never, scope, actor, row.key);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await inventoryOutbox.receivingDrafts.put({
      ...row,
      revision: 2,
      fields: {...row.fields, state: 'conflict'},
    });
    finish(
      new Response(
        JSON.stringify({status: 'confirmed', operationId: r.operationId, declaration: declaration(r, s)}),
        {status: 201},
      ),
    );
    await expect(sending).rejects.toThrow('изменилось');
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state).toBe('conflict');
  });
  it('validates receiver custody separately from discrepancies and does not store unrecognized network fields', async () => {
    const l = lot(),
      r = offer(l),
      h = {
        ...r,
        productionBatchId: batchId,
        sourceRoom: 'slurry',
        destinationRoom: 'coating',
        recipientWorkshopId: 'coating',
        sourceSnapshot: l.sourceSnapshot,
        actorId: scope.actorId,
        recordedAt: at,
        unit: 'mg',
        warehouseEffect: 'none',
      };
    expect(copyHandoff({...h, accessToken: 'do-not-save'})).not.toHaveProperty('accessToken');
    expect(() =>
      copyRoomHandoff({
        ...h,
        status: 'awaiting_receiver',
        custodyQuantity: 400,
        eligible: true,
        events: [],
        eventCount: 0,
        eventsTruncated: false,
      }),
    ).toThrow();
    vi.mocked(inventoryRequest).mockResolvedValue(
      new Response(
        JSON.stringify({
          ...scope,
          epoch,
          postingEnabled: true,
          items: [{...source(), inputQuantity: 999}],
          hasMore: false,
          nextAfter: null,
        }),
        {status: 200},
      ),
    );
    await expect(loadSlurryOutputSources({} as never, scope)).rejects.toThrow();
  });
  it('requires explicit measured values, exact mg precision and zero only where permitted', () => {
    expect(measuredMg('0', true)).toBe(0);
    expect(measuredMg('0,000', true)).toBe(0);
    expect(measuredMg('0.001')).toBe(1);
    for (const v of ['', ' ', 'unknown', '0.0001', '-1']) expect(() => measuredMg(v, true)).toThrow();
    expect(() => measuredMg('0')).toThrow();
  });
  it('retains a pending original if ACK storage fails and rejects changed local authority', async () => {
    const s = source(),
      r = request(),
      row = await freezeRoomCustody(scope, actor, epoch, 'declaration', r, s);
    vi.mocked(inventoryRequest).mockResolvedValue(
      new Response(
        JSON.stringify({status: 'confirmed', operationId: r.operationId, declaration: declaration(r, s)}),
        {status: 201},
      ),
    );
    const fail = () => {
      throw Error('ACK storage failure');
    };
    inventoryOutbox.receivingDrafts.hook('updating', fail);
    try {
      await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow(
        'ACK storage failure',
      );
    } finally {
      inventoryOutbox.receivingDrafts.hook('updating').unsubscribe(fail);
    }
    expect((await inventoryOutbox.receivingDrafts.get(row.key))?.fields).toEqual(row.fields);
    await db.users.update(actor, {role: UserRole.MASTER});
    vi.mocked(inventoryRequest).mockClear();
    await expect(sendRoomCustody({} as never, scope, actor, row.key)).rejects.toThrow();
    expect(inventoryRequest).not.toHaveBeenCalled();
  });
});
