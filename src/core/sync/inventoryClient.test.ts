import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {
  inventoryOutbox,inventoryQueueForScope,confirmedInventoryForScope,
  queueInventoryReceipt,type InventoryReceiptRequest,type InventoryScope,
} from './inventoryOutbox';
import {pullInventoryChanges,pushInventoryReceipts} from './inventoryClient';

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
const draft:Omit<InventoryReceiptRequest,'operationId'|'deviceId'>={
  stockId:'44444444-4444-4444-8444-444444444444',
  materialId:'55555555-5555-4555-8555-555555555555',
  locationId:'66666666-6666-4666-8666-666666666666',
  manufacturerLot:'L-2026-11',quantity:2_500_000,
  expectedRevision:0,reason:'Measured received powder; delivery reference',
};
const stock={
  stockId:draft.stockId,materialId:draft.materialId,
  locationId:draft.locationId,manufacturerLot:draft.manufacturerLot,
  unit:'mg' as const,quality:'quarantine' as const,
  onHand:draft.quantity,reserved:0,revision:1,available:draft.quantity,
};
function response(status:number,body:unknown){
  return {status,ok:status>=200&&status<300,json:async()=>body} as Response;
}

beforeEach(async()=>{
  await inventoryOutbox.open();
  await inventoryOutbox.transaction('rw',
    inventoryOutbox.operations,inventoryOutbox.stocks,inventoryOutbox.metadata,async()=>{
      await inventoryOutbox.operations.clear();
      await inventoryOutbox.stocks.clear();
      await inventoryOutbox.metadata.clear();
    });
});
afterEach(()=>{vi.unstubAllGlobals();inventoryOutbox.close();});

describe('Storage provisional offline queue and confirmed synchronization',()=>{
  it('persists the original operation ID across restart without creating confirmed stock',async()=>{
    const id=await queueInventoryReceipt(session,scope,draft);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await inventoryQueueForScope(scope))[0]).toMatchObject({
      operationId:id,state:'pending',request:{operationId:id,quantity:draft.quantity},
    });
    expect(await confirmedInventoryForScope(scope)).toEqual([]);
    inventoryOutbox.close();await inventoryOutbox.open();
    expect((await inventoryQueueForScope(scope))[0].operationId).toBe(id);
    expect(await confirmedInventoryForScope(scope)).toEqual([]);
  });
  it('keeps unknown network outcomes provisional, then atomically accepts exact server acknowledgement',async()=>{
    const id=await queueInventoryReceipt(session,scope,draft);
    vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('Connection lost')));
    await expect(pushInventoryReceipts(session,scope)).rejects.toThrow('Connection lost');
    expect((await inventoryQueueForScope(scope))[0].operationId).toBe(id);
    expect(await confirmedInventoryForScope(scope)).toEqual([]);
    const fetchMock=vi.fn().mockResolvedValue(response(201,{status:'confirmed',operationId:id,stock}));
    vi.stubGlobal('fetch',fetchMock);
    expect(await pushInventoryReceipts(session,scope)).toEqual({accepted:1,conflicts:0,rejected:0});
    expect(await inventoryQueueForScope(scope)).toEqual([]);
    expect(await confirmedInventoryForScope(scope)).toEqual([expect.objectContaining(stock)]);
    const sent=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.operationId).toBe(id);
    expect(sent.deviceId).toBe(scope.deviceId);
  });
  it('accepts a valid exact retry and does not allow forged acknowledgements',async()=>{
    const id=await queueInventoryReceipt(session,scope,draft);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,{
      status:'duplicate',operationId:id,stock:{...stock,manufacturerLot:'different'},
    })));
    await expect(pushInventoryReceipts(session,scope)).rejects.toThrow('differs');
    expect((await inventoryQueueForScope(scope))[0].state).toBe('pending');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,{status:'duplicate',operationId:id,stock})));
    expect((await pushInventoryReceipts(session,scope)).accepted).toBe(1);
  });
  it('shows a real conflict without inventing confirmed stock',async()=>{
    await queueInventoryReceipt(session,scope,draft);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(409,{error:'stock_id_reused'})));
    expect(await pushInventoryReceipts(session,scope)).toEqual({accepted:0,conflicts:1,rejected:0});
    expect((await inventoryQueueForScope(scope))[0]).toMatchObject({
      state:'conflict',error:'stock_id_reused',
    });
    expect(await confirmedInventoryForScope(scope)).toEqual([]);
  });
  it('rejects malformed, out-of-order or advanced-cursor feeds without applying them',async()=>{
    const opId='77777777-7777-4777-8777-777777777777';
    const change={sequence:2,operationId:opId,kind:'receive',stock,recordedAt:new Date().toISOString()};
    const invalid=[
      {changes:[change],nextCursor:3,hasMore:false},
      {changes:[change,{...change,sequence:1}],nextCursor:1,hasMore:false},
      {changes:[{...change,stock:{...stock,available:1}}],nextCursor:2,hasMore:false},
      {changes:[],nextCursor:3,hasMore:false},
    ];
    for(const payload of invalid){
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,payload)));
      await expect(pullInventoryChanges(session,scope)).rejects.toThrow('Invalid inventory');
      expect(await confirmedInventoryForScope(scope)).toEqual([]);
    }
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,{
      changes:[change],nextCursor:2,hasMore:false,
    })));
    expect(await pullInventoryChanges(session,scope)).toEqual({received:1,hasMore:false,cursor:2});
    expect(await confirmedInventoryForScope(scope)).toEqual([expect.objectContaining(stock)]);
  });
  it('isolates inventory data by server organization actor and device',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(200,{
      changes:[{sequence:1,operationId:'77777777-7777-4777-8777-777777777777',
        kind:'receive',stock,recordedAt:new Date().toISOString()}],nextCursor:1,hasMore:false,
    })));
    await pullInventoryChanges(session,scope);
    expect(await confirmedInventoryForScope({...scope,actorId:'88888888-8888-4888-8888-888888888888'})).toEqual([]);
    expect(await confirmedInventoryForScope({...scope,deviceId:'99999999-9999-4999-8999-999999999999'})).toEqual([]);
    expect(await inventoryQueueForScope({...scope,organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).toEqual([]);
  });
  it('rejects unsafe server URLs or wrong proof before sending queued receipts',async()=>{
    await queueInventoryReceipt(session,scope,draft);
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await expect(pushInventoryReceipts({...session,serverUrl:'http://untrusted.example'},scope)).rejects.toThrow();
    await expect(pushInventoryReceipts({...session,deviceProofDeviceId:'99999999-9999-4999-8999-999999999999'},scope)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await inventoryQueueForScope(scope))[0].state).toBe('pending');
  });
});
