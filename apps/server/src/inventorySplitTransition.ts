import type {InventoryStock} from './inventoryDomain.js';

export type SplitPlan =
  | {ok:true;parent:InventoryStock;child:InventoryStock}
  | {ok:false;reason:'invalid_stock'|'invalid_quantity'|'reserved_stock'|'quality_blocked'|'quarantine_approval_required'|'same_location'|'invalid_child_id'|'revision_overflow'};

/**
 * Deterministic stock split projection. No database writes or authorization.
 * The server must enforce actor permission, device proof, destination ownership,
 * idempotency and transactional persistence separately.
 */
export function planInventorySplit(
  parent:InventoryStock,
  childStockId:string,
  quantity:number,
  destinationLocationId:string,
  quarantineAcknowledged:boolean,
):SplitPlan {
  if(!Number.isSafeInteger(parent.onHand)||parent.onHand<=0||
     !Number.isSafeInteger(parent.reserved)||parent.reserved<0||
     parent.reserved>parent.onHand||
     !Number.isInteger(parent.revision)||parent.revision<1)
    return {ok:false,reason:'invalid_stock'};
  if(parent.revision>=2147483647)return {ok:false,reason:'revision_overflow'};
  if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>=parent.onHand)
    return {ok:false,reason:'invalid_quantity'};
  if(typeof childStockId!=='string'||!childStockId.trim()||childStockId===parent.stockId)
    return {ok:false,reason:'invalid_child_id'};
  if(typeof destinationLocationId!=='string'||!destinationLocationId.trim()||
     destinationLocationId===parent.locationId)
    return {ok:false,reason:'same_location'};
  if(parent.quality!=='released'&&parent.quality!=='quarantine')
    return {ok:false,reason:'quality_blocked'};
  if(parent.quality==='quarantine'&&quarantineAcknowledged!==true)
    return {ok:false,reason:'quarantine_approval_required'};
  if(parent.reserved!==0)return {ok:false,reason:'reserved_stock'};
  return {
    ok:true,
    parent:{...parent,onHand:parent.onHand-quantity,revision:parent.revision+1},
    child:{...parent,stockId:childStockId,onHand:quantity,reserved:0,
      locationId:destinationLocationId,revision:1},
  };
}
