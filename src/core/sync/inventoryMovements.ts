import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import type {InventoryScope} from './inventoryOutbox';

export interface MovementRow {
 sequence:number;operationId:string;stockId:string;kind:string;
 quantity:number;recordedAt:string;actorId:string;deviceId:string;
 reason:string;productionBatchId:string|null;materialId:string|null;
 materialCode:string|null;materialName:string|null;manufacturerLot:string|null;
 locationId:string|null;fromLocationId:string|null;toLocationId:string|null;unit:string|null;
}
export interface MovementPage {
 epoch:string;throughSequence:number;items:MovementRow[];hasMore:boolean;nextAfter:number;
}
export interface MovementFilters {
 stockId?:string;materialId?:string;productionBatchId?:string;actorId?:string;
 kind?:string;from?:string;through?:string;manufacturerLot?:string;
}
export type MovementOptions=MovementFilters&{after?:number;until?:number;limit?:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kind=/^[a-z][a-z_]{0,39}$/;
const date=/^\d{4}-\d{2}-\d{2}$/;
const validUtcDate=(value:string)=>{
 if(!date.test(value))return false;
 const parsed=new Date(value+'T00:00:00Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const optionalText=(v:unknown):v is string|null=>v===null||(typeof v==='string'&&v.length<=200);
const optionalId=(v:unknown):v is string|null=>v===null||(typeof v==='string'&&uuid.test(v));
function validateMovementPage(value:unknown,epoch:string,after:number,until:number|undefined,limit:number):MovementPage{
 if(!record(value)||value.epoch!==epoch||!safe(value.throughSequence)||
    (until!==undefined&&value.throughSequence!==until)||value.throughSequence<after||
    typeof value.hasMore!=='boolean'||!safe(value.nextAfter)||
    !Array.isArray(value.items)||value.items.length>limit)
   throw Error('Invalid movement report response');
 let previous=after;
 const items:MovementRow[]=[];
 for(const raw of value.items as unknown[]){
  if(!record(raw)||!safe(raw.sequence)||raw.sequence<=previous||
     raw.sequence>value.throughSequence||!uuid.test(String(raw.operationId))||
     !uuid.test(String(raw.stockId))||typeof raw.kind!=='string'||!kind.test(raw.kind)||
     !safe(raw.quantity)||typeof raw.recordedAt!=='string'||
     !Number.isFinite(Date.parse(raw.recordedAt))||
     new Date(raw.recordedAt).toISOString()!==raw.recordedAt||
     !uuid.test(String(raw.actorId))||!uuid.test(String(raw.deviceId))||
     typeof raw.reason!=='string'||raw.reason.length>2000||
     !optionalId(raw.productionBatchId)||!optionalId(raw.materialId)||
     !optionalId(raw.locationId)||!optionalId(raw.fromLocationId)||
     !optionalId(raw.toLocationId)||!optionalText(raw.materialCode)||
     !optionalText(raw.materialName)||!optionalText(raw.manufacturerLot)||
     (raw.unit!==null&&!['mg','ul','mm','pieces'].includes(String(raw.unit))))
    throw Error('Invalid movement report row');
  previous=raw.sequence;
  items.push(raw as unknown as MovementRow);
 }
 if(value.nextAfter!==previous||(value.hasMore&&items.length===0))
   throw Error('Invalid movement report cursor');
 return{epoch,throughSequence:value.throughSequence,items,
  hasMore:value.hasMore,nextAfter:value.nextAfter};
}
export async function loadInventoryMovements(
 session:HybridSession,scope:InventoryScope,epoch:string,opts:MovementOptions={},
):Promise<MovementPage>{
 for(const id of [opts.stockId,opts.materialId,opts.productionBatchId,opts.actorId]){
  if(id!==undefined&&!uuid.test(id))throw Error('Invalid movement report identity');
 }
 if(opts.kind!==undefined&&!kind.test(opts.kind))throw Error('Invalid movement kind');
 if(opts.manufacturerLot!==undefined&&(!opts.manufacturerLot.trim()||opts.manufacturerLot.length>200))throw Error('Invalid manufacturer lot');
 for(const value of [opts.from,opts.through]){
  if(value!==undefined&&!validUtcDate(value))
   throw Error('Invalid movement date');
 }
 if(opts.from&&opts.through&&opts.from>opts.through)throw Error('Invalid movement date range');
 const limit=opts.limit??50,after=opts.after??0;
 if(!safe(after)||!Number.isInteger(limit)||limit<1||limit>100||
    (opts.until!==undefined&&(!safe(opts.until)||opts.until<after)))
  throw Error('Invalid movement cursor');
 const q=new URLSearchParams({deviceId:scope.deviceId,after:String(after),limit:String(limit)});
 for(const key of ['stockId','materialId','productionBatchId','actorId','kind','from','through','manufacturerLot'] as const){
  if(opts[key])q.set(key,opts[key]);
 }
 if(opts.until!==undefined)q.set('until',String(opts.until));
 const response=await inventoryRequest(session,scope,'/inventory/reports/movements?'+q);
 if(!response.ok)throw Error('Movement report unavailable: HTTP '+response.status);
 return validateMovementPage(await response.json() as unknown,epoch,after,opts.until,limit);
}
/** Read every page of one frozen ledger snapshot; fail rather than export an incomplete file. */
export async function collectMovementSnapshot(
 fetchPage:(after:number,until:number)=>Promise<MovementPage>,
 until:number,maxRows=10_000,
):Promise<MovementPage>{
 if(!safe(until)||!Number.isSafeInteger(maxRows)||maxRows<1)throw Error('Invalid export bound');
 const items:MovementRow[]=[];
 let after=0,epoch:string|undefined;
 while(true){
  const page=await fetchPage(after,until);
  if(page.throughSequence!==until||(epoch!==undefined&&page.epoch!==epoch))
   throw Error('Movement export history changed');
  epoch=page.epoch;
  if(page.items.length&&page.items[0].sequence<=after)
   throw Error('Movement export cursor stalled');
  if(items.length+page.items.length>maxRows||(page.hasMore&&items.length+page.items.length>=maxRows))
   throw Error('Too many movement rows; narrow the filters and try again');
  items.push(...page.items);
  if(!page.hasMore)return{epoch,throughSequence:until,items,hasMore:false,
   nextAfter:page.nextAfter};
  if(page.nextAfter<=after||page.items.length===0)
   throw Error('Movement export cursor stalled');
  after=page.nextAfter;
 }
}

/** CSV contains only the fetched immutable event page; never include request payloads or credentials. */
export function inventoryMovementsCsv(page:MovementPage):string{
 const cell=(input:unknown)=>{
  const value=String(input??''),safeValue=/^[\s\uFEFF]*[=+@-]/u.test(value)?"'"+value:value;
  return '"'+safeValue.replace(/"/g,'""')+'"';
 };
 const lines=[
  ['History ID','Through ledger sequence','Sequence','Recorded UTC','Operation ID','Kind','Container ID','Material code',
   'Material name','Manufacturer lot','Quantity','Unit','Location after event',
   'Source location ID','Destination location ID','Batch ID',
   'Actor ID','Device ID','Reason'],
  ...page.items.map(r=>[
   page.epoch,page.throughSequence,r.sequence,r.recordedAt,r.operationId,r.kind,r.stockId,r.materialCode,
   r.materialName,r.manufacturerLot,r.quantity,r.unit,r.locationId,
   r.fromLocationId,r.toLocationId,r.productionBatchId,r.actorId,r.deviceId,r.reason,
  ]),
 ];
 return '\uFEFF'+lines.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
