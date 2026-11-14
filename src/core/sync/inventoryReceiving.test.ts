import {afterEach,beforeEach,expect,it} from 'vitest';
import {inventoryOutbox} from './inventoryOutbox';
import {toInventoryBaseUnits,saveReceivingDraft,freezeReceivingDraft} from './inventoryReceiving';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofDeviceId:scope.deviceId,offlineEditExpiresAt:Date.now()+60000};
const key='receiving-test';
const fields={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'A',quantity:2125000,expectedRevision:0 as const,reason:'Receiving sheet'};
beforeEach(async()=>{await inventoryOutbox.open();});
afterEach(async()=>{inventoryOutbox.close();await inventoryOutbox.delete();});
it('converts decimal strings losslessly and rejects rounding, unsafe bounds and wrong dimensions',()=>{
 expect(toInventoryBaseUnits('2.125','kg','mg')).toBe(2125000);
 expect(toInventoryBaseUnits('0,001','g','mg')).toBe(1);
 expect(toInventoryBaseUnits('1.5','L','ul')).toBe(1500000);
 for(const [q,u,b] of [['0.0000001','kg','mg'],['1','L','mg'],['0.5','pieces','pieces'],['9007199254740992','mg','mg'],['0','mg','mg'],['1e3','g','mg']])expect(()=>toInventoryBaseUnits(q,u,b)).toThrow();
});
it('atomically freezes a draft once, preserves fields and ID across reopen, refuses stale edits',async()=>{
 await saveReceivingDraft(key,0,{lot:'A'});
 const id=await freezeReceivingDraft(key,1,session,scope,fields);
 inventoryOutbox.close();await inventoryOutbox.open();
 expect((await inventoryOutbox.receivingDrafts.get(key))?.operationId).toBe(id);
 expect((await inventoryOutbox.operations.get(id))?.request.quantity).toBe(2125000);
 await expect(freezeReceivingDraft(key,1,session,scope,fields)).rejects.toThrow();
 await expect(saveReceivingDraft(key,1,{lot:'Changed'})).rejects.toThrow();
 expect(await inventoryOutbox.operations.count()).toBe(1);expect(await inventoryOutbox.stocks.count()).toBe(0);
});
it('leaves the saved draft intact if validation fails inside the queue transaction',async()=>{
 await saveReceivingDraft(key,0,{lot:'Evidence retained'});
 await expect(freezeReceivingDraft(key,1,session,scope,{...fields,quantity:-1})).rejects.toThrow();
 expect((await inventoryOutbox.receivingDrafts.get(key))?.fields).toEqual({lot:'Evidence retained'});
 expect((await inventoryOutbox.receivingDrafts.get(key))?.operationId).toBeUndefined();
 expect(await inventoryOutbox.operations.count()).toBe(0);
});
it('freezes whole-container stock intent atomically and rejects a stale source revision',async()=>{
 const {freezeStockDraft}=await import('./inventoryReceiving');
 const {inventoryScopeKey}=await import('./inventoryOutbox');
 const stock={stockId:fields.stockId,materialId:fields.materialId,locationId:fields.locationId,manufacturerLot:'A',unit:'mg' as const,quality:'quarantine' as const,onHand:2125000,reserved:0,available:2125000,revision:1};
 await inventoryOutbox.stocks.put({...stock,scopeKey:inventoryScopeKey(scope)});
 await saveReceivingDraft(key,0,{reason:'Physical movement'});
 await expect(freezeStockDraft(key,1,session,scope,{kind:'transfer',stockId:stock.stockId,expectedRevision:2,quantity:stock.onHand,toLocationId:'77777777-7777-4777-8777-777777777777',reason:'Physical movement'})).rejects.toThrow('Stock changed');
 expect((await inventoryOutbox.receivingDrafts.get(key))?.operationId).toBeUndefined();
 const id=await freezeStockDraft(key,1,session,scope,{kind:'transfer',stockId:stock.stockId,expectedRevision:1,quantity:stock.onHand,toLocationId:'77777777-7777-4777-8777-777777777777',reason:'Physical movement'});
 expect((await inventoryOutbox.stockOperations.get(id))?.request.quantity).toBe(2125000);
 expect((await inventoryOutbox.stocks.toArray())[0].locationId).toBe(stock.locationId);
});
