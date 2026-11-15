import type {HybridSession} from './hybridClient';
import type {InventoryScope} from './inventoryOutbox';
import {inventoryRequest} from './inventoryClient';

export interface ReconciliationRow{
 issueId:string;stockId:string;materialId:string;productionBatchId:string;recipientId:string;
 stepNumber:number;workshopId:string;manufacturerLot:string;unit:string;
 materialCode:string;materialName:string;batchCode:string;recipientName:string;
 dispatchOperationId:string;receiptOperationId:string;
 issued:number;returned:number;scrapped:number;consumed:null;consumptionStatus:'not_recorded';outstanding:number;
}
export interface ReconciliationPage{
 epoch:string;throughIssueSequence:number;throughOutcomeSequence:number;
 items:ReconciliationRow[];hasMore:boolean;nextAfter:string|null;
}
export interface ReconciliationFilters{productionBatchId?:string;recipientId?:string;materialId?:string;stockId?:string}
type Options=ReconciliationFilters&{after?:string;limit?:number;untilIssue?:number;untilOutcome?:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const filterKeys=['productionBatchId','recipientId','materialId','stockId'] as const;
export async function loadIssueReconciliation(session:HybridSession,scope:InventoryScope,epoch:string,opts:Options={}):Promise<ReconciliationPage>{
 const limit=opts.limit??50;
 if([...filterKeys.map(key=>opts[key]),opts.after].some(id=>id!==undefined&&!uuid.test(id))||
  !Number.isInteger(limit)||limit<1||limit>100||
  (opts.untilIssue===undefined)!==(opts.untilOutcome===undefined)||
  [opts.untilIssue,opts.untilOutcome].some(n=>n!==undefined&&!safe(n)))throw Error('Invalid reconciliation options');
 const q=new URLSearchParams({deviceId:scope.deviceId,limit:String(limit)});
 for(const key of [...filterKeys,'after','untilIssue','untilOutcome'] as const)if(opts[key]!==undefined)q.set(key,String(opts[key]));
 const response=await inventoryRequest(session,scope,'/inventory/reports/reconciliation?'+q);
 if(!response.ok)throw Error('Reconciliation unavailable: HTTP '+response.status);
 const page:unknown=await response.json();
 if(!record(page)||page.epoch!==epoch||!safe(page.throughIssueSequence)||!safe(page.throughOutcomeSequence)||
  (opts.untilIssue!==undefined&&(page.throughIssueSequence!==opts.untilIssue||page.throughOutcomeSequence!==opts.untilOutcome))||
  typeof page.hasMore!=='boolean'||!Array.isArray(page.items)||page.items.length>limit||
  (page.hasMore?typeof page.nextAfter!=='string'||!uuid.test(page.nextAfter):page.nextAfter!==null))throw Error('Invalid reconciliation page');
 const items:ReconciliationRow[]=[];let prior=opts.after?.toLowerCase()??'';
 for(const row of page.items as unknown[]){
  if(!record(row)||['issueId',...filterKeys,'dispatchOperationId','receiptOperationId'].some(key=>typeof row[key]!=='string'||!uuid.test(row[key] as string))||
   String(row.issueId)<=prior||!safe(row.stepNumber)||row.stepNumber<1||
   ['workshopId','manufacturerLot','materialCode','materialName','batchCode','recipientName'].some(key=>typeof row[key]!=='string'||(row[key] as string).length>2000)||
   !['mg','ul','mm','pieces'].includes(String(row.unit))||
   ['issued','returned','scrapped','outstanding'].some(key=>!safe(row[key]))||row.issued===0||
   row.consumed!==null||row.consumptionStatus!=='not_recorded')throw Error('Invalid reconciliation row');
  const item=row as unknown as ReconciliationRow;
  if(BigInt(item.issued)!==BigInt(item.returned)+BigInt(item.scrapped)+BigInt(item.outstanding))throw Error('Invalid reconciliation balance');
  prior=item.issueId;items.push(item);
 }
 if(page.hasMore&&(!items.length||page.nextAfter!==prior))throw Error('Invalid reconciliation cursor');
 return{epoch,throughIssueSequence:page.throughIssueSequence,throughOutcomeSequence:page.throughOutcomeSequence,
  items,hasMore:page.hasMore,nextAfter:page.nextAfter as string|null};
}
export async function collectIssueReconciliation(fetchPage:(after?:string)=>Promise<ReconciliationPage>,snapshot:ReconciliationPage,maxRows=10_000):Promise<ReconciliationPage>{
 const items:ReconciliationRow[]=[];let after:string|undefined;
 while(true){
  const page=await fetchPage(after);
  if(page.epoch!==snapshot.epoch||page.throughIssueSequence!==snapshot.throughIssueSequence||
   page.throughOutcomeSequence!==snapshot.throughOutcomeSequence)throw Error('Reconciliation export history changed');
  if((page.items.length&&page.items[0].issueId<=(after??''))||
   (page.hasMore&&(!page.items.length||!page.nextAfter||page.nextAfter!==page.items[page.items.length-1].issueId)))throw Error('Reconciliation export cursor stalled');
  if(items.length+page.items.length>maxRows||(page.hasMore&&items.length+page.items.length>=maxRows))throw Error('Reconciliation export limit exceeded; narrow filters');
  items.push(...page.items);
  if(!page.hasMore)return{...snapshot,items,hasMore:false,nextAfter:null};
  after=page.nextAfter!;
 }
}
export function issueReconciliationCsv(page:ReconciliationPage):string{
 const cell=(input:unknown)=>{const text=String(input??'');return '"'+(/^[\s\uFEFF]*[=+@-]/u.test(text)?"'"+text:text).replace(/"/g,'""')+'"';};
 const lines=[['History ID','Through issue sequence','Through outcome sequence','Issue ID','Batch ID','Batch code','Step','Workshop',
  'Recipient ID','Recipient name','Source container ID','Material ID','Material code','Material name','Manufacturer lot','Unit',
  'Issued and received','Returned','Issued scrap','Actual consumption','Unsettled (not measured unused)','Dispatch operation ID','Receipt operation ID'],
  ...page.items.map(r=>[page.epoch,page.throughIssueSequence,page.throughOutcomeSequence,r.issueId,r.productionBatchId,r.batchCode,
   r.stepNumber,r.workshopId,r.recipientId,r.recipientName,r.stockId,r.materialId,r.materialCode,r.materialName,r.manufacturerLot,r.unit,
   r.issued,r.returned,r.scrapped,'NOT RECORDED',r.outstanding,r.dispatchOperationId,r.receiptOperationId])];
 return '\uFEFF'+lines.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
