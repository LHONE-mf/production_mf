import Dexie from 'dexie';
import {afterEach,describe,expect,it} from 'vitest';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope} from './inventoryOutbox';
import {queueInventoryStockChange,inventoryStockQueueForScope} from './inventoryStockOutbox';

const scope:InventoryScope={
  serverUrl:'https://inventory.example',
  organizationId:'11111111-1111-4111-8111-111111111111',
  actorId:'22222222-2222-4222-8222-222222222222',
  deviceId:'33333333-3333-4333-8333-333333333333',
};
const stockId='44444444-4444-4444-8444-444444444444';
const locationId='55555555-5555-4555-8555-555555555555';
const materialId='66666666-6666-4666-8666-666666666666';
const scopeKey=inventoryScopeKey(scope);
const session={
  serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),
  deviceProofDeviceId:scope.deviceId,offlineEditExpiresAt:Date.now()+300_000,
};
afterEach(async()=>{
  inventoryOutbox.close();
  await inventoryOutbox.delete();
});

describe('Storage inventory outbox upgrade',()=>{
  it('upgrades actual v1 IndexedDB data to v2 without deleting receipts, snapshots or the feed cursor',async()=>{
    inventoryOutbox.close();
    await inventoryOutbox.delete();
    const old=new Dexie('ProductionMfInventoryOutbox');
    old.version(1).stores({
      operations:'operationId,scopeKey,state,queuedAt',
      stocks:'[scopeKey+stockId],scopeKey',
      metadata:'key',
    });
    await old.open();
    const operationId='77777777-7777-4777-8777-777777777777';
    const originalReceipt={
      operationId,scopeKey,state:'pending',queuedAt:1234,
      request:{operationId,deviceId:scope.deviceId,
        stockId:'88888888-8888-4888-8888-888888888888',
        materialId,locationId,manufacturerLot:'LOT-2',
        quantity:10,expectedRevision:0,reason:'Existing frozen receipt'},
    };
    const originalStock={
      scopeKey,stockId,materialId,locationId,manufacturerLot:'LOT-1',
      unit:'mg',quality:'quarantine',onHand:5000,reserved:0,
      revision:1,available:5000,
    };
    await old.table('operations').add(originalReceipt);
    await old.table('stocks').add(originalStock);
    await old.table('metadata').add({key:scopeKey+':cursor',value:42});
    old.close();

    await inventoryOutbox.open();
    expect(await inventoryOutbox.operations.get(operationId)).toEqual(originalReceipt);
    expect(await inventoryOutbox.stocks.get([scopeKey,stockId])).toEqual(originalStock);
    expect((await inventoryOutbox.metadata.get(scopeKey+':cursor'))?.value).toBe(42);
    expect(await inventoryStockQueueForScope(scope)).toEqual([]);

    const pendingId=await queueInventoryStockChange(session,scope,{
      stockId,kind:'transfer',toLocationId:'99999999-9999-4999-8999-999999999999',
      expectedRevision:1,quantity:5000,reason:'Verified container moved offline',
    });
    expect((await inventoryStockQueueForScope(scope))[0]).toMatchObject({
      operationId:pendingId,state:'pending',
    });
    expect(await inventoryOutbox.operations.get(operationId)).toEqual(originalReceipt);
    expect(await inventoryOutbox.stocks.get([scopeKey,stockId])).toEqual(originalStock);
    expect((await inventoryOutbox.metadata.get(scopeKey+':cursor'))?.value).toBe(42);
    inventoryOutbox.close();await inventoryOutbox.open();
    expect((await inventoryStockQueueForScope(scope))[0].operationId).toBe(pendingId);
  });
});
it('preserves populated v2 stock proposals when adding v3 receiving drafts',async()=>{
 inventoryOutbox.close();await inventoryOutbox.delete();
 const old=new Dexie('ProductionMfInventoryOutbox');
 old.version(1).stores({operations:'operationId,scopeKey,state,queuedAt',stocks:'[scopeKey+stockId],scopeKey',metadata:'key'});
 old.version(2).stores({stockOperations:'operationId,scopeKey,[scopeKey+stockId],stockId,state,queuedAt'});
 await old.open();
 const row={operationId:'77777777-7777-4777-8777-777777777777',scopeKey,stockId,state:'conflict',queuedAt:123,error:'revision_conflict',base:{revision:1},request:{kind:'transfer',expectedRevision:1}};
 await old.table('stockOperations').put(row);await old.table('metadata').put({key:scopeKey+':cursor',value:42});old.close();
 await inventoryOutbox.open();expect(await inventoryOutbox.stockOperations.get(row.operationId)).toEqual(row);
 expect((await inventoryOutbox.metadata.get(scopeKey+':cursor'))?.value).toBe(42);expect(await inventoryOutbox.receivingDrafts.count()).toBe(0);
});
