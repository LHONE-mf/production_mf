import {inventoryScopeKey,type InventoryScope} from './inventoryOutbox';
const active=new Set<string>();
const busy=()=>new Error('Inventory stock synchronization already in progress for this device');
/** One inventory read/write reconciliation at a time, across tabs when Web Locks is available. */
export async function withInventorySync<T>(scope:InventoryScope,work:()=>Promise<T>):Promise<T>{
 const key=inventoryScopeKey(scope);
 if(active.has(key))throw busy();
 active.add(key);
 try{
  if(typeof navigator!=='undefined'&&navigator.locks?.request)
   return await navigator.locks.request('production-mf:inventory:'+key,{ifAvailable:true},async lock=>{if(!lock)throw busy();return work();});
  return await work();
 }finally{active.delete(key);}
}
