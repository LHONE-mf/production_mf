import type {HybridSession} from './hybridClient';
import type {InventoryScope} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';

export interface MaterialBalanceRow{
 materialId:string;code:string;name:string;unit:'mg'|'ul'|'mm'|'pieces';
 category:'raw_material'|'component'|'electrode'|'cell';active:boolean;
 onHand:string;reserved:string;physicallyUnreserved:string;eligibleAvailable:string;
 quarantined:string;blocked:string;expired:string;
 packageCount:string;manufacturerLots:string;expiringPackages:string;
}
export interface MaterialBalancePage{
 epoch:string;asOf:string;expiryDays:number;
 items:MaterialBalanceRow[];hasMore:boolean;nextAfter:string|null;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer=/^(0|[1-9][0-9]*)$/;
export async function loadMaterialBalances(
 session:HybridSession,scope:InventoryScope,epoch:string,
 expiryDays=30,after?:string,limit=50,
):Promise<MaterialBalancePage>{
 if(!Number.isInteger(expiryDays)||expiryDays<0||expiryDays>365||
   !Number.isInteger(limit)||limit<1||limit>100||(after!==undefined&&!uuid.test(after)))
  throw Error('Invalid material summary options');
 const query=new URLSearchParams({deviceId:scope.deviceId,expiryDays:String(expiryDays),limit:String(limit)});
 if(after)query.set('after',after);
 const response=await inventoryRequest(session,scope,'/inventory/reports/materials?'+query);
 if(!response.ok)throw Error('Material summary unavailable: HTTP '+response.status);
 const value:unknown=await response.json();
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid material summary');
 const raw=value as Record<string,unknown>;
 if(raw.epoch!==epoch||typeof raw.asOf!=='string'||!Number.isFinite(Date.parse(raw.asOf))||
   new Date(raw.asOf).toISOString()!==raw.asOf||raw.expiryDays!==expiryDays||
   typeof raw.hasMore!=='boolean'||!Array.isArray(raw.items)||raw.items.length>limit||
   (raw.hasMore?(typeof raw.nextAfter!=='string'||!uuid.test(raw.nextAfter)):raw.nextAfter!==null))
  throw Error('Invalid material summary');
 const items:MaterialBalanceRow[]=[];
 let prior=after??'';
 for(const item of raw.items as unknown[]){
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Invalid material balance');
  const row=item as Record<string,unknown>;
  if(typeof row.materialId!=='string'||!uuid.test(row.materialId)||row.materialId<=prior||
    typeof row.code!=='string'||typeof row.name!=='string'||
    !['mg','ul','mm','pieces'].includes(String(row.unit))||
    !['raw_material','component','electrode','cell'].includes(String(row.category))||
    typeof row.active!=='boolean'||[
      'onHand','reserved','physicallyUnreserved','eligibleAvailable','quarantined',
      'blocked','expired','packageCount','manufacturerLots','expiringPackages'
    ].some(key=>typeof row[key]!=='string'||!integer.test(row[key] as string)))
   throw Error('Invalid material balance');
  prior=row.materialId;
  items.push(row as unknown as MaterialBalanceRow);
 }
 if(raw.hasMore&&(!items.length||raw.nextAfter!==prior))throw Error('Invalid material page cursor');
 return{epoch,asOf:raw.asOf,expiryDays,items,hasMore:raw.hasMore,nextAfter:raw.nextAfter as string|null};
}

/** CSV formula protection, with exact decimal-string quantities. Only the current verified page. */
export function materialBalancesCsv(page:MaterialBalancePage):string{
 const cell=(v:unknown)=>{
  const text=String(v??''),safe=/^[\s\uFEFF]*[=+@-]/u.test(text)?"'"+text:text;
  return '"'+safe.replace(/"/g,'""')+'"';
 };
 const lines=[
  ['Material code','Material name','Unit','Category','Active','On hand','Reserved',
    'Physically unreserved','Eligible available','Quarantined','Blocked','Expired',
    'Packages','Manufacturer lots','Expiring packages'],
  ...page.items.map(r=>[r.code,r.name,r.unit,r.category,r.active,
   r.onHand,r.reserved,r.physicallyUnreserved,r.eligibleAvailable,
   r.quarantined,r.blocked,r.expired,r.packageCount,r.manufacturerLots,r.expiringPackages]),
 ];
 return '\uFEFF'+lines.map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
}
