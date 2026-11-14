import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {inventoryOutbox,inventoryScopeKey,queueInventoryReceipt,
  type InventoryScope} from './inventoryOutbox';
import {inventoryStockQueueForScope,queueInventoryStockChange} from './inventoryStockOutbox';
import {pushPendingInventoryStockChanges} from './inventoryStockClient';
import {confirmedInventoryForScope} from './inventoryOutbox';

const scope:InventoryScope={
  serverUrl:'https://inventory.example',
  organizationId:'11111111-1111-4111-8111-111111111111',
  actorId:'22222222-2222-4222-8222-222222222222',
  deviceId:'33333333-3333-4333-8333-333333333333',
};
const session={
  serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),
  deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,
  deviceProofExpiresAt:Date.now()+300_000,
  offlineEditExpiresAt:Date.now()+500_000,
};
const stockId='44444444-4444-4444-8444-444444444444';
const source='55555555-5555-4555-8555-555555555555';
const destination='66666666-6666-4666-8666-666666666666';
const material='77777777-7777-4777-8777-777777777777';
const base={
  stockId,materialId:material,manufacturerLot:'LOT-42',
  locationId:source,unit:'mg' as const,quality:'quarantine' as const,
  onHand:2000,reserved:0,available:2000,revision:1,
};
const transfer={
  stockId,kind:'transfer' as const,expectedRevision:1,
  quantity:2000,reason:'Verified physical container movement',
  toLocationId:destination,
};
const adjust={
  stockId,kind:'adjust' as const,expectedRevision:1,
  quantity:250,reason:'Measured physical count correction',
  adjustment:'decrease' as const,
};
const reservationId='88888888-8888-4888-8888-888888888888';
const productionBatchId='99999999-9999-4999-8999-999999999999';
const response=(status:number,payload:unknown)=>({
  status,ok:status>=200&&status<300,json:async()=>payload,
}) as Response;
const snapshot=(patch:Record<string,unknown>={})=>({...base,revision:2,...patch});

beforeEach(async()=>{
  await inventoryOutbox.open();
  await inventoryOutbox.transaction('rw',inventoryOutbox.operations,
    inventoryOutbox.stockOperations,inventoryOutbox.stocks,inventoryOutbox.metadata,
    async()=>{
      await inventoryOutbox.operations.clear();
      await inventoryOutbox.stockOperations.clear();
      await inventoryOutbox.stocks.clear();
      await inventoryOutbox.metadata.clear();
    });
  await inventoryOutbox.stocks.put({...base,scopeKey:inventoryScopeKey(scope)});
});
afterEach(()=>{vi.unstubAllGlobals();inventoryOutbox.close();});

describe('Storage offline stock operation outbox (development-only)',()=>{
  it('upgrades the receipt outbox without losing receipts and persists frozen stock changes across restart',async()=>{
    const receiptId=await queueInventoryReceipt(session,scope,{
      stockId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',materialId:material,
      locationId:source,manufacturerLot:'LOT-B',quantity:30,
      expectedRevision:0,reason:'Separate package receipt',
    });
    const id=await queueInventoryStockChange(session,scope,transfer);
    const before=(await inventoryStockQueueForScope(scope))[0];
    expect(before).toMatchObject({operationId:id,state:'pending',
      request:{operationId:id,deviceId:scope.deviceId,kind:'transfer',
        expectedRevision:1,toLocationId:destination}});
    expect(before.request).not.toHaveProperty('stockId');
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(base);
    inventoryOutbox.close();await inventoryOutbox.open();
    expect((await inventoryStockQueueForScope(scope))[0]).toEqual(before);
    expect(await inventoryOutbox.operations.get(receiptId)).toBeDefined();
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(base);
  });

  it('rejects provisional overcommit, stale versions, malformed requests and second pending changes',async()=>{
    await expect(queueInventoryStockChange(session,scope,{...transfer,quantity:1500}))
      .rejects.toThrow('whole unreserved');
    await expect(queueInventoryStockChange(session,scope,{...transfer,expectedRevision:2}))
      .rejects.toThrow('Stock changed');
    await expect(queueInventoryStockChange(session,scope,{...adjust,quantity:3000}))
      .rejects.toThrow('reserved or absent');
    await expect(queueInventoryStockChange(session,scope,{
      ...transfer,quantity:NaN,
    })).rejects.toThrow('Invalid provisional');
    await expect(queueInventoryStockChange(session,scope,{
      ...transfer,reason:'   ',
    })).rejects.toThrow('Invalid provisional');
    await expect(queueInventoryStockChange(session,scope,{
      ...transfer,extra:'untrusted',
    } as typeof transfer)).rejects.toThrow('Unknown');
    await expect(queueInventoryStockChange({...session,offlineEditExpiresAt:0,
      deviceProofExpiresAt:0},scope,transfer)).rejects.toThrow('offline window');
    await queueInventoryStockChange(session,scope,transfer);
    await expect(queueInventoryStockChange(session,scope,transfer))
      .rejects.toThrow('existing provisional');
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(base);
  });

  it('keeps timed-out stock movements and the original ID for exact retry',async()=>{
    const id=await queueInventoryStockChange(session,scope,transfer);
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Connection lost')));
    await expect(pushPendingInventoryStockChanges(session,scope)).rejects.toThrow('Connection lost');
    expect((await inventoryStockQueueForScope(scope))[0]).toMatchObject({
      operationId:id,state:'pending',
    });
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(base);
    const good=snapshot({locationId:destination});
    const fetchMock=vi.fn().mockResolvedValue(response(201,{
      status:'confirmed',operationId:id,stock:good,
    }));
    vi.stubGlobal('fetch',fetchMock);
    expect(await pushPendingInventoryStockChanges(session,scope))
      .toEqual({accepted:1,conflicts:0,rejected:0});
    expect(await inventoryStockQueueForScope(scope)).toEqual([]);
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(good);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/inventory/stocks/'+stockId+'/operations');
    const sent=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.operationId).toBe(id);
    expect(sent.deviceId).toBe(scope.deviceId);
    expect(sent).not.toHaveProperty('stockId');
  });

  it('prevents simultaneous pushes from the same device and unlocks after a network error',async()=>{
    const id=await queueInventoryStockChange(session,scope,transfer);
    let unblock:(response:Response)=>void=()=>{};
    const waiting=new Promise<Response>(resolve=>{unblock=resolve;});
    const fetchMock=vi.fn().mockReturnValueOnce(waiting);
    vi.stubGlobal('fetch',fetchMock);
    const first=pushPendingInventoryStockChanges(session,scope);
    await expect(pushPendingInventoryStockChanges(session,scope))
      .rejects.toThrow('already in progress');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unblock(response(201,{
      status:'confirmed',operationId:id,stock:snapshot({locationId:destination}),
    }));
    expect((await first).accepted).toBe(1);
    expect(await pushPendingInventoryStockChanges(session,scope))
      .toEqual({accepted:0,conflicts:0,rejected:0});

    await queueInventoryStockChange(session,scope,{
      ...transfer,expectedRevision:2,toLocationId:source,
    });
    vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('Offline again')));
    await expect(pushPendingInventoryStockChanges(session,scope))
      .rejects.toThrow('Offline again');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(409,{
      error:'revision_conflict',currentRevision:3,
    })));
    expect((await pushPendingInventoryStockChanges(session,scope)).conflicts).toBe(1);
  });

  it('does not acknowledge a forged server snapshot, then accepts valid duplicate response',async()=>{
    const id=await queueInventoryStockChange(session,scope,adjust);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(201,{
      status:'confirmed',operationId:id,
      stock:snapshot({onHand:1751,available:1751}),
    })));
    await expect(pushPendingInventoryStockChanges(session,scope))
      .rejects.toThrow('differs from queued intent');
    expect((await inventoryStockQueueForScope(scope))[0].state).toBe('pending');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,{
      status:'duplicate',operationId:id,
      stock:snapshot({onHand:1750,available:1750}),
    })));
    expect((await pushPendingInventoryStockChanges(session,scope)).accepted).toBe(1);
    expect((await confirmedInventoryForScope(scope))[0])
      .toMatchObject({onHand:1750,reserved:0,revision:2});
  });

  it('preserves conflicts without rebase, and retains server auth errors for later retry',async()=>{
    await queueInventoryStockChange(session,scope,transfer);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(403,{error:'forbidden'})));
    await expect(pushPendingInventoryStockChanges(session,scope)).rejects.toThrow('HTTP 403');
    expect((await inventoryStockQueueForScope(scope))[0].state).toBe('pending');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(409,{
      error:'revision_conflict',currentRevision:3,
    })));
    expect(await pushPendingInventoryStockChanges(session,scope))
      .toEqual({accepted:0,conflicts:1,rejected:0});
    expect((await inventoryStockQueueForScope(scope))[0]).toMatchObject({
      state:'conflict',error:'revision_conflict',
      request:{expectedRevision:1},
    });
    expect((await confirmedInventoryForScope(scope))[0]).toMatchObject(base);
    const noFetch=vi.fn();vi.stubGlobal('fetch',noFetch);
    expect(await pushPendingInventoryStockChanges(session,scope))
      .toEqual({accepted:0,conflicts:0,rejected:0});
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('handles reserve and release using server-confirmed snapshots without optimistic deductions',async()=>{
    const scopeKey=inventoryScopeKey(scope);
    const released={...base,quality:'released' as const};
    await inventoryOutbox.stocks.put({...released,scopeKey});
    const reserve={stockId,kind:'reserve' as const,expectedRevision:1,
      quantity:500,reason:'Allocated to released production order',
      productionBatchId,reservationId};
    const reserveOpId=await queueInventoryStockChange(session,scope,reserve);
    expect((await confirmedInventoryForScope(scope))[0].available).toBe(2000);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(201,{
      status:'confirmed',operationId:reserveOpId,
      stock:{...released,revision:2,reserved:500,available:1500},
    })));
    await pushPendingInventoryStockChanges(session,scope);
    const release={stockId,kind:'release_reservation' as const,
      expectedRevision:2,quantity:200,reason:'Batch requires less material',
      productionBatchId,reservationId};
    const releaseOpId=await queueInventoryStockChange(session,scope,release);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(201,{
      status:'confirmed',operationId:releaseOpId,
      stock:{...released,revision:3,reserved:300,available:1700},
    })));
    await pushPendingInventoryStockChanges(session,scope);
    expect((await confirmedInventoryForScope(scope))[0])
      .toMatchObject({reserved:300,available:1700,revision:3});
  });

  it('does not roll back newer confirmed feed state on a late valid acknowledgement',async()=>{
    const id=await queueInventoryStockChange(session,scope,transfer);
    await inventoryOutbox.stocks.put({...base,
      scopeKey:inventoryScopeKey(scope),revision:3,locationId:destination,
      onHand:1500,available:1500});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(201,{
      status:'confirmed',operationId:id,stock:snapshot({locationId:destination}),
    })));
    expect((await pushPendingInventoryStockChanges(session,scope)).accepted).toBe(1);
    expect((await confirmedInventoryForScope(scope))[0])
      .toMatchObject({revision:3,onHand:1500,available:1500});
  });
});
