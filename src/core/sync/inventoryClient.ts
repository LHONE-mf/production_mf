import type {HybridSession} from './hybridClient';
import {requireFreshDeviceProof} from './deviceProofClient';
import {
  inventoryOutbox,inventoryQueueForScope,inventoryScopeKey,validateInventoryStock,
  type InventoryScope,type InventoryStockSnapshot,type QueuedInventoryReceipt,
} from './inventoryOutbox';

const validId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No automatic sync: callers must request a fresh device proof and explicitly run these. */
export async function inventoryRequest(
  session:HybridSession,scope:InventoryScope,path:string,init?:RequestInit,
):Promise<Response>{
  inventoryScopeKey(scope);
  if(new URL(session.serverUrl).origin!==new URL(scope.serverUrl).origin)
    throw new Error('Inventory session/server mismatch');
  const proof=requireFreshDeviceProof(session);
  if(proof.deviceId!==scope.deviceId)
    throw new Error('Inventory device proof mismatch');
  return fetch(new URL(path,new URL(scope.serverUrl).origin),{
    ...init,headers:{
      Authorization:'Bearer '+session.accessToken,
      'Content-Type':'application/json','x-device-proof':proof.token,...init?.headers,
    },
  });
}

function sameStock(a:InventoryStockSnapshot,b:InventoryStockSnapshot){
  return a.stockId===b.stockId&&a.materialId===b.materialId&&
    a.manufacturerLot===b.manufacturerLot&&a.locationId===b.locationId&&
    a.unit===b.unit&&a.quality===b.quality&&a.onHand===b.onHand&&
    a.reserved===b.reserved&&a.revision===b.revision&&a.available===b.available;
}

async function acknowledgeReceipt(
  queued:QueuedInventoryReceipt,raw:unknown,expectedStatus:'confirmed'|'duplicate',
){
  if(!raw||typeof raw!=='object')throw new Error('Invalid inventory receipt acknowledgement');
  const ack=raw as {status?:string;operationId?:string;stock?:unknown};
  if(ack.status!==expectedStatus||ack.operationId!==queued.operationId)
    throw new Error('Invalid inventory receipt acknowledgement');
  validateInventoryStock(ack.stock);
  const snapshot=ack.stock;
  if(snapshot.stockId!==queued.request.stockId||
      snapshot.materialId!==queued.request.materialId||
      snapshot.locationId!==queued.request.locationId||
      snapshot.manufacturerLot!==queued.request.manufacturerLot||
      snapshot.quality!=='quarantine'||snapshot.revision!==1||
      snapshot.onHand!==queued.request.quantity||
      snapshot.reserved!==0)
    throw new Error('Inventory receipt acknowledgement differs from queued intent');
  await inventoryOutbox.transaction('rw',inventoryOutbox.operations,inventoryOutbox.stocks,async()=>{
    const current=await inventoryOutbox.operations.get(queued.operationId);
    if(!current||current.state!=='pending'||
        JSON.stringify(current.request)!==JSON.stringify(queued.request)||
        current.scopeKey!==queued.scopeKey)
      throw new Error('Provisional receipt changed while awaiting acknowledgement');
    const before=await inventoryOutbox.stocks.get([queued.scopeKey,snapshot.stockId]);
    if(before&&before.revision===snapshot.revision&&!sameStock(before,snapshot))
      throw new Error('Confirmed inventory snapshot conflict');
    if(!before||before.revision<snapshot.revision)
      await inventoryOutbox.stocks.put({...snapshot,scopeKey:queued.scopeKey});
    await inventoryOutbox.operations.delete(queued.operationId);
  });
}

/** Submit frozen provisional receipts one by one. Unknown network status is retryable. */
export async function pushInventoryReceipts(
  session:HybridSession,scope:InventoryScope,limit=20,
):Promise<{accepted:number;conflicts:number;rejected:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)
    throw new Error('Invalid inventory push limit');
  const pending=(await inventoryQueueForScope(scope)).filter(row=>row.state==='pending').slice(0,limit);
  let accepted=0,conflicts=0,rejected=0;
  for(const queued of pending){
    const response=await inventoryRequest(session,scope,'/inventory/receipts',{
      method:'POST',body:JSON.stringify(queued.request),
    });
    if(response.status===200||response.status===201){
      await acknowledgeReceipt(queued,await response.json(),
        response.status===200?'duplicate':'confirmed');
      accepted++;
      continue;
    }
    if(response.status===409||response.status===400||response.status===404){
      const raw=await response.json() as {error?:unknown};
      if(typeof raw?.error!=='string'||!raw.error||raw.error.length>200)
        throw new Error('Invalid inventory rejection acknowledgement');
      const rejectionReason=raw.error as string;
      await inventoryOutbox.transaction('rw',inventoryOutbox.operations,async()=>{
        const current=await inventoryOutbox.operations.get(queued.operationId);
        if(!current||current.state!=='pending'||
            current.scopeKey!==queued.scopeKey||
            JSON.stringify(current.request)!==JSON.stringify(queued.request))
          throw new Error('Provisional receipt changed during rejection');
        await inventoryOutbox.operations.update(queued.operationId,{
          state:response.status===409?'conflict':'rejected',error:rejectionReason,
        });
      });
      if(response.status===409)conflicts++;else rejected++;
      continue;
    }
    // Auth/proof failures, network errors and server errors must preserve the
    // provisional operation with its original ID for an explicit retry.
    throw new Error('Inventory receipt submission failed: HTTP '+response.status);
  }
  return {accepted,conflicts,rejected};
}

export async function pullInventoryChanges(
  session:HybridSession,scope:InventoryScope,limit=50,
):Promise<{received:number;hasMore:boolean;cursor:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw new Error('Invalid inventory pull limit');
  const scopeKey=inventoryScopeKey(scope),key=scopeKey+':cursor';
  const cursor=(await inventoryOutbox.metadata.get(key))?.value??0;
  const response=await inventoryRequest(session,scope,
    '/inventory/changes?deviceId='+encodeURIComponent(scope.deviceId)+
    '&cursor='+cursor+'&limit='+limit);
  if(!response.ok)throw new Error('Inventory change pull failed: HTTP '+response.status);
  const payload=await response.json() as {
    changes?:unknown;nextCursor?:unknown;hasMore?:unknown;
  };
  if(!Array.isArray(payload.changes)||payload.changes.length>limit||
      typeof payload.hasMore!=='boolean'||
      !Number.isSafeInteger(payload.nextCursor)||Number(payload.nextCursor)<cursor)
    throw new Error('Invalid inventory change feed');
  const changes=payload.changes as Array<{
    sequence:number;operationId:string;kind:string;stock:unknown;recordedAt:string;
  }>;
  let previous=cursor;
  for(const item of changes){
    if(!item||!Number.isSafeInteger(item.sequence)||item.sequence<=previous||
        !validId.test(item.operationId)||
        !['receive','transfer','adjust','reserve','release_reservation'].includes(item.kind)||
        typeof item.recordedAt!=='string'||!Number.isFinite(Date.parse(item.recordedAt)))
      throw new Error('Invalid inventory change order or identity');
    validateInventoryStock(item.stock);
    if(item.kind==='receive'?
        item.stock.revision!==1||item.stock.quality!=='quarantine':
        item.stock.revision<=1)
      throw new Error('Invalid inventory change revision');
    previous=item.sequence;
  }
  if((changes.length===0&&payload.nextCursor!==cursor)||
      (changes.length>0&&payload.nextCursor!==previous))
    throw new Error('Invalid inventory cursor acknowledgement');
  // Apply all snapshots and checkpoint the cursor in the SAME transaction.
  await inventoryOutbox.transaction('rw',inventoryOutbox.stocks,inventoryOutbox.metadata,async()=>{
    const currentCursor=(await inventoryOutbox.metadata.get(key))?.value??0;
    if(currentCursor!==cursor)throw new Error('Inventory cursor advanced while pulling');
    for(const item of changes){
      const stock=item.stock as InventoryStockSnapshot;
      const before=await inventoryOutbox.stocks.get([scopeKey,stock.stockId]);
      if(before&&before.revision===stock.revision&&!sameStock(before,stock))
        throw new Error('Conflicting confirmed inventory snapshots');
      if(!before||before.revision<stock.revision)
        await inventoryOutbox.stocks.put({...stock,scopeKey});
    }
    await inventoryOutbox.metadata.put({key,value:payload.nextCursor as number});
  });
  return {received:changes.length,hasMore:payload.hasMore as boolean,cursor:payload.nextCursor as number};
}
