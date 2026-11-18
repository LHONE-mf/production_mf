import type {InventoryStock} from './inventoryDomain.js';

/** Pure validation only. Does not authorize, write, or reserve inventory. */
export type SplitValidation =
  | {ok:true;remaining:number;childQuantity:number}
  | {ok:false;reason:'invalid_quantity'|'invalid_stock'|'insufficient_available'|'reserved_stock'|'same_location'|'blocked_stock'|'quarantine_approval_required'};

export function validateInventorySplit(
  stock:InventoryStock,
  quantity:number,
  targetLocationId:string,
  quarantineAcknowledged=false,
):SplitValidation {
  if(!Number.isSafeInteger(stock.onHand)||stock.onHand<=0||
     !Number.isSafeInteger(stock.reserved)||stock.reserved<0||
     stock.reserved>stock.onHand)return {ok:false,reason:'invalid_stock'};
  if(!Number.isSafeInteger(quantity)||quantity<=0)return {ok:false,reason:'invalid_quantity'};
  if(!targetLocationId.trim()||targetLocationId===stock.locationId)
    return {ok:false,reason:'same_location'};
  if(stock.quality==='blocked')return {ok:false,reason:'blocked_stock'};
  if(stock.quality==='quarantine'&&!quarantineAcknowledged)
    return {ok:false,reason:'quarantine_approval_required'};
  // Until reservations can be atomically assigned to child stock, refuse
  // splitting any reserved container rather than silently moving commitments.
  if(stock.reserved!==0)return {ok:false,reason:'reserved_stock'};
  if(quantity>=stock.onHand)return {ok:false,reason:'insufficient_available'};
  return {ok:true,remaining:stock.onHand-quantity,childQuantity:quantity};
}
