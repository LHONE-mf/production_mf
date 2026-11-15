import type {CountHistoryPage} from './inventoryCounts';

/** Full selected count history, including observations that never changed stock. */
export async function collectCountHistory(fetchPage:(after:number)=>Promise<CountHistoryPage>,snapshot:CountHistoryPage,maxRows=10_000):Promise<CountHistoryPage>{
 const items:CountHistoryPage['items']=[];let after=0;
 while(true){
  const page=await fetchPage(after);
  if(page.epoch!==snapshot.epoch||page.countId!==snapshot.countId||page.throughSequence!==snapshot.throughSequence||page.closed!==snapshot.closed)throw Error('Count export history changed');
  if(page.items.length&&page.items[0].sequence!<=after||page.nextAfter!==null&&(!page.items.length||page.nextAfter<=after||page.nextAfter!==page.items[page.items.length-1].sequence))throw Error('Count export cursor stalled');
  if(items.length+page.items.length>maxRows||page.nextAfter!==null&&items.length+page.items.length>=maxRows)throw Error('Count export limit exceeded');
  items.push(...page.items);
  if(page.nextAfter===null)return{...snapshot,items,nextAfter:null};
  after=page.nextAfter;
 }
}
export function inventoryCountHistoryCsv(page:CountHistoryPage):string{
 const cell=(input:unknown)=>{const text=String(input??'');return '"'+(/^[\s\uFEFF]*[=+@-]/u.test(text)?"'"+text:text).replace(/"/g,'""')+'"';};
 const lines=[['History ID','Through count sequence','Count ID','Closed as of snapshot','Sequence','Recorded UTC','Kind','Operation ID','Observation ID',
  'Container ID','Material ID','Manufacturer lot','Location ID','Quality at observation','Counted revision','Unit',
  'Recorded on hand','Reserved at observation','Physically counted','Count variance (signed)','Actor ID','Device ID','Reason','Evidence'],
  ...page.items.map(r=>[page.epoch,page.throughSequence,r.countId,page.closed,r.sequence,r.recordedAt,r.kind,r.operationId,r.observationId,
   r.stockId,r.observedStock?.materialId,r.observedStock?.manufacturerLot,r.observedStock?.locationId,r.observedStock?.quality,r.expectedRevision,r.observedStock?.unit,
   r.observedStock?.onHand,r.observedStock?.reserved,r.quantity,r.observedStock&&r.quantity!==null?r.quantity-r.observedStock.onHand:'',r.actorId,r.deviceId,r.reason,r.evidence])];
 return '\uFEFF'+lines.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
