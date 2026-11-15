import {inventoryRequest} from './inventoryClient';
import {validateInventoryStock,type InventoryScope,type InventoryStockSnapshot} from './inventoryOutbox';
import type {HybridSession} from './hybridClient';

export type InventoryAlertKind='quarantine'|'blocked'|'expired'|'expiring'|'restricted'|'low';
export interface InventoryAlertRow {
  stock:InventoryStockSnapshot;materialCode:string;materialName:string;
  locationLabel:string;eligible:boolean;alerts:InventoryAlertKind[];
}
export interface InventoryAlertsPage {
  epoch:string;asOf:string;expiryDays:number;lowAvailable:number;materialId:string|null;
  items:InventoryAlertRow[];hasMore:boolean;nextAfter:string|null;
}
export interface InventoryAlertOptions {
  after?:string;limit?:number;expiryDays:number;lowAvailable:number;
  materialId?:string;view:'alerts'|'all';
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds=['quarantine','blocked','expired','expiring','restricted','low'] as const;
function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function parsePage(raw:unknown,epoch:string,opts:InventoryAlertOptions):InventoryAlertsPage{
  if(!record(raw)||raw.epoch!==epoch||typeof raw.asOf!=='string'||!Number.isFinite(Date.parse(raw.asOf))||
      new Date(raw.asOf).toISOString()!==raw.asOf||
      raw.expiryDays!==opts.expiryDays||raw.lowAvailable!==opts.lowAvailable||
      raw.materialId!==(opts.materialId??null)||typeof raw.hasMore!=='boolean'||
      !Array.isArray(raw.items)||raw.items.length>(opts.limit??50)||
      (raw.hasMore?typeof raw.nextAfter!=='string'||!uuid.test(raw.nextAfter):raw.nextAfter!==null)||
      (opts.after!==undefined&&raw.hasMore&&String(raw.nextAfter)<=opts.after))
    throw Error('Invalid inventory alert report');
  const items:InventoryAlertRow[]=[];
  let previous=opts.after??'';
  for(const item of raw.items as unknown[]){
    if(!record(item))throw Error('Invalid inventory alert item');
    const stock=item.stock;validateInventoryStock(stock);
    if(stock.stockId<=previous||typeof item.materialCode!=='string'||
      typeof item.materialName!=='string'||typeof item.locationLabel!=='string'||
      typeof item.eligible!=='boolean'||!Array.isArray(item.alerts)||
      item.alerts.some(x=>!kinds.includes(x as InventoryAlertKind))||
      new Set(item.alerts).size!==item.alerts.length)
      throw Error('Invalid inventory alert item');
    previous=stock.stockId;
    items.push({stock,materialCode:item.materialCode as string,materialName:item.materialName,
      locationLabel:item.locationLabel,eligible:item.eligible,
      alerts:item.alerts as InventoryAlertKind[]});
  }
  return {epoch:raw.epoch as string,asOf:raw.asOf,expiryDays:opts.expiryDays,
    lowAvailable:opts.lowAvailable,materialId:opts.materialId??null,
    items,hasMore:raw.hasMore,nextAfter:raw.nextAfter as string|null};
}
export async function loadInventoryAlerts(
  session:HybridSession,scope:InventoryScope,epoch:string,opts:InventoryAlertOptions,
):Promise<InventoryAlertsPage>{
  if(!Number.isSafeInteger(opts.expiryDays)||opts.expiryDays<0||opts.expiryDays>365||
      !Number.isSafeInteger(opts.lowAvailable)||opts.lowAvailable<0||
      (opts.lowAvailable>0&&!opts.materialId)||
      (opts.after!==undefined&&!uuid.test(opts.after))||
      (opts.materialId!==undefined&&!uuid.test(opts.materialId))||
      (opts.limit!==undefined&&(!Number.isInteger(opts.limit)||opts.limit<1||opts.limit>100)))
    throw Error('Invalid inventory alert parameters');
  const params=new URLSearchParams({deviceId:scope.deviceId,
    expiryDays:String(opts.expiryDays),lowAvailable:String(opts.lowAvailable),
    view:opts.view,limit:String(opts.limit??50)});
  if(opts.after)params.set('after',opts.after);
  if(opts.materialId)params.set('materialId',opts.materialId);
  const response=await inventoryRequest(session,scope,'/inventory/reports/alerts?'+params);
  if(!response.ok)throw Error('Warehouse alert report unavailable: HTTP '+response.status);
  return parsePage(await response.json() as unknown,epoch,opts);
}

/** Export only what was visibly fetched; every untrusted field is CSV-formula safe. */
export function inventoryAlertsCsv(page:InventoryAlertsPage):string{
  const escape=(input:unknown)=>{
    const value=String(input??'');
    const safe=/^[\s\uFEFF]*[=+@-]/u.test(value)?"'"+value:value;
    return '"'+safe.replace(/"/g,'""')+'"';
  };
  const headers=['Material code','Material name','Manufacturer lot','Container ID',
    'Location','Quality','Available','On hand','Reserved','Base unit','Expires UTC','Warnings'];
  const lines=[headers,...page.items.map(row=>[
    row.materialCode,row.materialName,row.stock.manufacturerLot,row.stock.stockId,
    row.locationLabel,row.stock.quality,row.stock.available,row.stock.onHand,
    row.stock.reserved,row.stock.unit,row.stock.expiresAt??'',row.alerts.join(';'),
  ])];
  return '\uFEFF'+lines.map(line=>line.map(escape).join(',')).join('\r\n')+'\r\n';
}
