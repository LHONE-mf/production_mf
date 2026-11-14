import type {HybridSession} from './hybridClient';
import {
  inventoryOutbox,inventoryScopeKey,validateInventoryStock,
  type InventoryScope,type InventoryStockSnapshot,
} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';
import {
  inventoryStockQueueForScope,
  type InventoryStockChangeRequest,type QueuedInventoryStockChange,
} from './inventoryStockOutbox';

/**
 * Manual, explicit synchronization of previously frozen stock proposals.
 * The server is authoritative. A lost reply always retains the same operation
 * ID; accepted stock is never fabricated from a local provisional request.
 */
function sameStock(a:InventoryStockSnapshot,b:InventoryStockSnapshot){
  return a.stockId===b.stockId&&a.materialId===b.materialId&&
    a.manufacturerLot===b.manufacturerLot&&a.locationId===b.locationId&&
    a.unit===b.unit&&a.quality===b.quality&&a.onHand===b.onHand&&
    a.reserved===b.reserved&&a.revision===b.revision&&a.available===b.available;
}
function expectedSnapshot(
  base:InventoryStockSnapshot,request:InventoryStockChangeRequest,
):InventoryStockSnapshot{
  const next={...base,revision:base.revision+1};
  switch(request.kind){
    case 'transfer':
      next.locationId=request.toLocationId;
      break;
    case 'adjust':
      next.onHand+=request.adjustment==='increase'?request.quantity:-request.quantity;
      break;
    case 'reserve':
      next.reserved+=request.quantity;
      break;
    case 'release_reservation':
      next.reserved-=request.quantity;
      break;
  }
  next.available=next.onHand-next.reserved;
  validateInventoryStock(next);
  return next;
}
async function acknowledgeStockChange(
  queued:QueuedInventoryStockChange,raw:unknown,
  expectedStatus:'confirmed'|'duplicate',
){
  if(!raw||typeof raw!=='object')throw new Error('Invalid stock change acknowledgement');
  const ack=raw as {status?:string;operationId?:string;stock?:unknown};
  if(ack.status!==expectedStatus||ack.operationId!==queued.operationId)
    throw new Error('Invalid stock change acknowledgement');
  validateInventoryStock(ack.stock);
  // The server must return exactly the outcome implied by the frozen starting
  // revision and intent; a mismatched snapshot never acknowledges the request.
  if(!sameStock(ack.stock,expectedSnapshot(queued.base,queued.request)))
    throw new Error('Stock change acknowledgement differs from queued intent');
  const snapshot=ack.stock;
  await inventoryOutbox.transaction('rw',
    inventoryOutbox.stockOperations,inventoryOutbox.stocks,async()=>{
      const current=await inventoryOutbox.stockOperations.get(queued.operationId);
      if(!current||current.scopeKey!==queued.scopeKey||
          current.state!=='pending'||current.stockId!==queued.stockId||
          JSON.stringify(current.request)!==JSON.stringify(queued.request)||
          !sameStock(current.base,queued.base))
        throw new Error('Provisional stock change altered before acknowledgement');
      const prior=await inventoryOutbox.stocks.get([queued.scopeKey,snapshot.stockId]);
      if(prior&&prior.revision===snapshot.revision&&!sameStock(prior,snapshot))
        throw new Error('Conflicting confirmed stock state');
      if(!prior||prior.revision<snapshot.revision)
        await inventoryOutbox.stocks.put({...snapshot,scopeKey:queued.scopeKey});
      await inventoryOutbox.stockOperations.delete(queued.operationId);
    });
}

/** A 409 is a visible manual conflict; it never silently rebases to a newer revision. */
const activeStockPushes=new Set<string>();

export async function pushPendingInventoryStockChanges(
  session:HybridSession,scope:InventoryScope,limit=20,
):Promise<{accepted:number;conflicts:number;rejected:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)
    throw new Error('Invalid inventory stock change push limit');
  const scopeKey=inventoryScopeKey(scope);
  if(activeStockPushes.has(scopeKey))
    throw new Error('Inventory stock synchronization already in progress for this device');
  activeStockPushes.add(scopeKey);
  try {
  const pending=(await inventoryStockQueueForScope(scope))
    .filter(row=>row.state==='pending').slice(0,limit);
  let accepted=0,conflicts=0,rejected=0;
  for(const queued of pending){
    const response=await inventoryRequest(session,scope,
      '/inventory/stocks/'+encodeURIComponent(queued.stockId)+'/operations',{
        method:'POST',body:JSON.stringify(queued.request),
      });
    if(response.status===201||response.status===200){
      await acknowledgeStockChange(queued,await response.json(),
        response.status===200?'duplicate':'confirmed');
      accepted++;continue;
    }
    if(response.status===400||response.status===404||response.status===409){
      const raw:unknown=await response.json();
      if(!raw||typeof raw!=='object'||typeof (raw as {error?:unknown}).error!=='string'||
          !(raw as {error:string}).error|| (raw as {error:string}).error.length>200)
        throw new Error('Invalid stock change rejection acknowledgement');
      const reason=(raw as {error:string}).error;
      await inventoryOutbox.transaction('rw',inventoryOutbox.stockOperations,async()=>{
        const current=await inventoryOutbox.stockOperations.get(queued.operationId);
        if(!current||current.scopeKey!==queued.scopeKey||
            current.state!=='pending'||current.stockId!==queued.stockId||
            JSON.stringify(current.request)!==JSON.stringify(queued.request))
          throw new Error('Provisional stock change altered during rejection');
        await inventoryOutbox.stockOperations.update(queued.operationId,{
          state:response.status===409?'conflict':'rejected',error:reason,
        });
      });
      if(response.status===409)conflicts++;else rejected++;
      continue;
    }
    // Server/proof/auth failures and unknown outcomes retain the unchanged
    // provisional operation for retry after reauthentication or reconnection.
    throw new Error('Stock change submission failed: HTTP '+response.status);
  }
  return {accepted,conflicts,rejected};
  } finally {
    activeStockPushes.delete(scopeKey);
  }
}
