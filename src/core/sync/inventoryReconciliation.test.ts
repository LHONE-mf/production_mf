import {beforeEach,describe,expect,it,vi} from 'vitest';
import {inventoryRequest} from './inventoryClient';
import {loadIssueReconciliation,issueReconciliationCsv,collectIssueReconciliation,type ReconciliationPage} from './inventoryReconciliation';
vi.mock('./inventoryClient',()=>({inventoryRequest:vi.fn()}));
const id='11000000-0000-4000-8000-000000000001',next='22000000-0000-4000-8000-000000000002';
const page=():ReconciliationPage=>({epoch:id,throughIssueSequence:5,throughOutcomeSequence:2,hasMore:false,nextAfter:null,items:[{
 issueId:id,stockId:id,materialId:id,productionBatchId:id,recipientId:id,stepNumber:1,workshopId:'slurry',
 manufacturerLot:'LOT',unit:'mg',materialCode:'INPUT',materialName:'Powder',batchCode:'BATCH',recipientName:'Operator',
 dispatchOperationId:id,receiptOperationId:id,issued:500,returned:200,scrapped:50,consumed:null,consumptionStatus:'not_recorded',outstanding:250,
}]});
const load=(options={})=>loadIssueReconciliation({} as never,{deviceId:id} as never,id,options);
beforeEach(()=>vi.mocked(inventoryRequest).mockReset());
describe('received issue report boundary',()=>{
 it('reports measured consumption and keeps it inside the conserved issue remainder',async()=>{
  const p=page();Object.assign(p.items[0],{consumed:100,consumptionStatus:'recorded',outstanding:150});
  vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(p)));
  expect((await load()).items[0].consumed).toBe(100);
  expect(issueReconciliationCsv(p)).toContain('"500","200","50","100","150"');
 });
 it('loads an explicitly scoped frozen report and validates conservation',async()=>{
  vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(page())));
  expect(await load({productionBatchId:id,recipientId:id,materialId:id,stockId:id,untilIssue:5,untilOutcome:2})).toEqual(page());
  const path=vi.mocked(inventoryRequest).mock.calls[0][2];
  expect(path).toContain('recipientId='+id);expect(path).toContain('untilOutcome=2');
 });
 it('rejects fabricated zero consumption, unsafe units/quantities, wrong history and invalid cursors',async()=>{
  for(const change of [{consumed:0},{consumptionStatus:'recorded'},{returned:501},{outstanding:251},
   {issued:Number.MAX_SAFE_INTEGER+1},{unit:'kg'},{receiptOperationId:'bad'}]){
   const p=page();Object.assign(p.items[0],change);
   vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(p)));
   await expect(load()).rejects.toThrow(/Invalid/);
  }
  for(const change of [{epoch:next},{hasMore:true,nextAfter:next},{throughIssueSequence:-1}]){
   vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({...page(),...change})));
   await expect(load()).rejects.toThrow(/Invalid/);
  }
  vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify(page())));
  await expect(load({untilIssue:6,untilOutcome:2})).rejects.toThrow(/Invalid/);
 });
 it('rejects invalid filter identities and partial bounds before any request',async()=>{
  for(const opts of [{recipientId:'bad'},{untilIssue:5},{untilOutcome:2},{limit:101},{after:'bad'}])await expect(load(opts)).rejects.toThrow(/Invalid/);
  expect(inventoryRequest).not.toHaveBeenCalled();
 });
 it('propagates denied reads without returning a report',async()=>{
  vi.mocked(inventoryRequest).mockResolvedValue(new Response('{}',{status:403}));
  await expect(load()).rejects.toThrow(/403/);
 });
});
describe('reconciliation export',()=>{
 it('escapes formulas/quotes and labels consumption as NOT RECORDED with both history cursors',()=>{
  const p=page();p.items[0].recipientName=' @RUN(1)';p.items[0].manufacturerLot='=LOT\n"quote"';
  const csv=issueReconciliationCsv(p);
  expect(csv).toContain('"\' @RUN(1)"');expect(csv).toContain('"\'=LOT\n""quote"""');
  expect(csv).toContain('"NOT RECORDED"');expect(csv).toContain('"500","200","50","NOT RECORDED","250"');
  expect(csv).toContain(`"${id}","5","2"`);
 });
 it('collects the full frozen selection and refuses partial, stalled or mixed-history exports',async()=>{
  const calls:(string|undefined)[]=[];
  const all=await collectIssueReconciliation(async after=>{
   calls.push(after);const p=page();
   if(!after){p.hasMore=true;p.nextAfter=id;}else p.items[0].issueId=next;
   return p;
  },page());
  expect(calls).toEqual([undefined,id]);expect(all.items.map(r=>r.issueId)).toEqual([id,next]);
  await expect(collectIssueReconciliation(async()=>({...page(),hasMore:true,nextAfter:id}),page(),1)).rejects.toThrow(/limit/);
  await expect(collectIssueReconciliation(async()=>({...page(),epoch:next}),page())).rejects.toThrow(/history/);
  await expect(collectIssueReconciliation(async()=>({...page(),throughOutcomeSequence:3}),page())).rejects.toThrow(/history/);
  await expect(collectIssueReconciliation(async()=>({...page(),hasMore:true,nextAfter:id}),page())).rejects.toThrow(/cursor/);
 });
});
