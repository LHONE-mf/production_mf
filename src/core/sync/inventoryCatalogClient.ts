import type {HybridSession} from './hybridClient';
import type {InventoryScope} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';

// Server-confirmed catalogues are read-only until a durable, scoped local
// catalogue cache is introduced. They do not modify stock or offline receipts.
export interface InventoryMaterial {
  id:string;code:string;name:string;
  category:'raw_material'|'component'|'electrode'|'cell';
  baseUnit:'mg'|'ul'|'mm'|'pieces';
}
export interface InventoryLocation {
  id:string;parentId:string|null;label:string;
  kind:'warehouse'|'cabinet'|'rack'|'shelf'|'container_area';
  active:boolean;
}
export interface InventoryPage<T> {
  items:T[];hasMore:boolean;nextAfter:string|null;
}
export interface WarehouseAccess {
  level:'chief'|'manager'|'operator';
  canRecordReceipts:boolean;
  canManageCatalog:boolean;
  canCorrectStock:boolean;
  correctionRoleEligible:boolean;
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nonempty=(s:unknown,max:number):s is string=>
  typeof s==='string'&&!!s.trim()&&s.length<=max;
const isRecord=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function material(x:unknown):x is InventoryMaterial{
  if(!isRecord(x))return false;
  return typeof x.id==='string'&&uuid.test(x.id)&&nonempty(x.code,100)&&
    nonempty(x.name,200)&&
    ['raw_material','component','electrode','cell'].includes(String(x.category))&&
    ['mg','ul','mm','pieces'].includes(String(x.baseUnit));
}
function location(x:unknown):x is InventoryLocation{
  if(!isRecord(x))return false;
  return typeof x.id==='string'&&uuid.test(x.id)&&
    (x.parentId===null||(typeof x.parentId==='string'&&uuid.test(x.parentId)))&&
    nonempty(x.label,200)&&
    ['warehouse','cabinet','rack','shelf','container_area'].includes(String(x.kind))&&
    typeof x.active==='boolean';
}
function validatePage<T extends {id:string}>(
  raw:unknown,key:'materials'|'locations',
  valid:(x:unknown)=>x is T,limit:number,after?:string,
):InventoryPage<T>{
  if(!isRecord(raw))throw new Error('Invalid inventory catalogue response');
  const rows=raw[key];
  if(!Array.isArray(rows)||rows.length>limit||
      typeof raw.hasMore!=='boolean')
    throw new Error('Invalid inventory catalogue response');
  const items:T[]=[];let previous=after??'';
  for(const item of rows as unknown[]){
    if(!valid(item)||item.id<=previous)
      throw new Error('Invalid inventory catalogue row ordering or identity');
    items.push(item);previous=item.id;
  }
  if(raw.hasMore&&(items.length!==limit||raw.nextAfter!==previous))
    throw new Error('Invalid inventory catalogue continuation');
  if(!raw.hasMore&&raw.nextAfter!==null)
    throw new Error('Invalid inventory catalogue cursor');
  return {items,hasMore:raw.hasMore,nextAfter:raw.nextAfter as string|null};
}

async function catalogRequest(
  session:HybridSession,scope:InventoryScope,path:string,after?:string,limit=50,
){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||
      (after!==undefined&&!uuid.test(after)))
    throw new Error('Invalid inventory catalogue page');
  const params=new URLSearchParams({deviceId:scope.deviceId,limit:String(limit)});
  if(after)params.set('after',after);
  const response=await inventoryRequest(session,scope,path+'?'+params);
  if(!response.ok)throw new Error('Inventory catalogue request failed: HTTP '+response.status);
  return response.json() as Promise<unknown>;
}

export async function loadInventoryMaterials(
  session:HybridSession,scope:InventoryScope,after?:string,limit=50,
):Promise<InventoryPage<InventoryMaterial>>{
  return validatePage(await catalogRequest(session,scope,'/inventory/materials',after,limit),
    'materials',material,limit,after);
}
export async function loadInventoryLocations(
  session:HybridSession,scope:InventoryScope,after?:string,limit=50,
):Promise<InventoryPage<InventoryLocation>>{
  return validatePage(await catalogRequest(session,scope,'/inventory/locations',after,limit),
    'locations',location,limit,after);
}
export async function loadWarehouseAccess(
  session:HybridSession,scope:InventoryScope,
):Promise<WarehouseAccess>{
  const response=await inventoryRequest(session,scope,
    '/inventory/access/me?deviceId='+encodeURIComponent(scope.deviceId));
  if(!response.ok)throw new Error('Warehouse access request failed: HTTP '+response.status);
  const raw:unknown=await response.json();
  if(!isRecord(raw)||!['chief','manager','operator'].includes(String(raw.level))||
      typeof raw.canRecordReceipts!=='boolean'||
      typeof raw.canManageCatalog!=='boolean'||
      typeof raw.canCorrectStock!=='boolean'||
      typeof raw.correctionRoleEligible!=='boolean'||
      raw.canCorrectStock!==(raw.level==='chief'||raw.level==='manager')||
      raw.canRecordReceipts!==true||
      raw.canManageCatalog!==(raw.level==='chief'||raw.level==='manager')||
      raw.correctionRoleEligible!==(raw.level==='chief'||raw.level==='manager'))
    throw new Error('Invalid warehouse access response');
  return raw as unknown as WarehouseAccess;
}

/** Preserve full physical context when leaf labels repeat. */
export function inventoryLocationPath(locations:InventoryLocation[],id:string):string{
 const names:string[]=[],seen=new Set<string>();
 let current:string|null=id;
 while(current){
  if(seen.has(current)||seen.size>=100)throw Error('Invalid inventory location hierarchy');
  seen.add(current);const row=locations.find(location=>location.id===current);
  names.unshift(row?.label??current);current=row?.parentId??null;
 }
 return names.join(' / ');
}
