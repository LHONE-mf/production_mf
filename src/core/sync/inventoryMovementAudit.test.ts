import {describe,expect,it,vi} from 'vitest';
import {inventoryRequest} from './inventoryClient';
import {inventoryMovementsCsv,loadInventoryMovements} from './inventoryMovements';
vi.mock('./inventoryClient',()=>({inventoryRequest:vi.fn()}));
const id='11000000-0000-4000-8000-000000000001',child='22000000-0000-4000-8000-000000000002';
const at='2026-11-15T00:00:00.000Z';
const quality={type:'quality',disposition:'hold',evidence:'=QA "certificate"'};
const counted={type:'count',countId:id,observationId:child,recordedOnHand:1000,countedOnHand:950,
 observedRevision:2,observedBy:id,observedDeviceId:id,observedAt:at,observationEvidence:'@COUNT',evidence:'=APPROVAL'};
const split={type:'split',parentStockId:id,childStockId:child,parentOperationId:id,childOperationId:child,
 parentOnHandBefore:950,parentOnHandAfter:650,evidence:'CI child label'};
const returned={type:'return',sourceStockId:id,issueId:id,evidence:'CI inspected unused return'};
function row(kind:string,audit:unknown,extra:object={}){return{
 sequence:1,operationId:id,stockId:id,kind,quantity:0,onHandAfter:1000,reservedAfter:0,
 recordedAt:at,actorId:id,deviceId:id,reason:'Synthetic audited event',productionBatchId:id,
 materialId:id,materialCode:'CI',materialName:'Powder',manufacturerLot:'LOT',locationId:id,
 fromLocationId:null,toLocationId:null,unit:'mg',audit,...extra,
};}
async function load(item:ReturnType<typeof row>){
 vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({epoch:id,throughSequence:1,items:[item],hasMore:false,nextAfter:1})));
 return loadInventoryMovements({} as never,{deviceId:id} as never,id);
}
describe('movement audit boundary and CSV',()=>{
 it('validates and exports QA evidence and separately attributed count observation/approval',async()=>{
  const qa=await load(row('quality_change',quality));expect(qa.items[0].audit).toEqual(quality);
  const count=await load(row('count_adjustment',counted,{quantity:50,onHandAfter:950}));
  expect(count.items[0].audit).toEqual(counted);
  const csv=inventoryMovementsCsv(count);
  expect(csv).toContain('"Count ID","Observation ID"');expect(csv).toContain('"1000","950","\'-50"');
  expect(csv).toContain('"\'@COUNT"');expect(csv).toContain('"\'=APPROVAL"');
  expect(inventoryMovementsCsv(qa)).toContain('"hold"');
  expect(inventoryMovementsCsv(qa)).toContain('"\'=QA ""certificate"""');
 });
 it('validates both sides of conserved split genealogy and the source of an unused return',async()=>{
  const parent=await load(row('split_out',split,{quantity:300,onHandAfter:650}));
  expect(parent.items[0].audit).toEqual(split);
  const kid=await load(row('split_in',split,{stockId:child,operationId:child,quantity:300,onHandAfter:300}));
  expect(kid.items[0].audit).toEqual(split);
  const back=await load(row('return',returned,{stockId:child,quantity:200,onHandAfter:200}));
  expect(back.items[0].audit).toEqual(returned);expect(inventoryMovementsCsv(back)).toContain('Source container ID');
  for(const page of [parent,kid,back]){
   const [header,data]=inventoryMovementsCsv(page).trim().split('\r\n').map(line=>line.split(','));
   expect(data).toHaveLength(header.length);
   expect(data[header.indexOf('"Source container ID"')]).toBe('"'+id+'"');
   expect(data[header.indexOf('"Child container ID"')]).toBe('"'+child+'"');
  }
 });
 it('rejects missing/mismatched audit, false count differences and forged split identities/conservation',async()=>{
  for(const audit of [null,undefined,{...quality,disposition:'available'},{...quality,evidence:''},counted])await expect(load(row('quality_change',audit))).rejects.toThrow(/Invalid/);
  for(const audit of [{...counted,countedOnHand:951},{...counted,recordedOnHand:1001},{...counted,observedBy:'bad'},
   {...counted,observedAt:'not UTC'},{...counted,observedRevision:0},{...counted,observationEvidence:''}]){
   await expect(load(row('count_adjustment',audit,{quantity:50,onHandAfter:950}))).rejects.toThrow(/Invalid/);
  }
  for(const audit of [{...split,parentOnHandAfter:651},{...split,childStockId:id},{...split,parentOperationId:child}])await expect(load(row('split_out',audit,{quantity:300,onHandAfter:650}))).rejects.toThrow(/Invalid/);
  await expect(load(row('return',{...returned,sourceStockId:child},{stockId:child,quantity:200,onHandAfter:200}))).rejects.toThrow(/Invalid/);
  await expect(load(row('receive',quality,{quantity:1000}))).rejects.toThrow(/Invalid/);
 });
 it('handles an explicit zero physical count without inferring use or an unapproved movement',async()=>{
  const page=await load(row('count_adjustment',{...counted,countedOnHand:0},{quantity:1000,onHandAfter:0}));
  expect(page.items[0].onHandAfter).toBe(0);expect(inventoryMovementsCsv(page)).toContain('"1000","0","\'-1000"');
 });
});
