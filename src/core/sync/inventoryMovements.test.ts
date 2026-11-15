import {describe,expect,it,vi} from 'vitest';
import {inventoryRequest} from './inventoryClient';
import {collectMovementSnapshot,inventoryMovementsCsv,loadInventoryMovements,type MovementPage} from './inventoryMovements';
const id='11000000-0000-4000-8000-000000000001';
vi.mock('./inventoryClient',()=>({inventoryRequest:vi.fn()}));
it('validates and sends the historical post-event location filter with frozen export bounds',async()=>{
 vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({epoch:id,throughSequence:3,hasMore:false,nextAfter:0,items:[]})));
 await loadInventoryMovements({} as never,{deviceId:id} as never,id,{locationId:id,until:3});
 const path=vi.mocked(inventoryRequest).mock.calls[0][2];
 expect(path).toContain('locationId='+id);expect(path).toContain('until=3');
 vi.mocked(inventoryRequest).mockClear();
 await expect(loadInventoryMovements({} as never,{} as never,id,{locationId:'bad'})).rejects.toThrow('Invalid movement report identity');
 expect(inventoryRequest).not.toHaveBeenCalled();
});
describe('inventory movement CSV',()=>{
 it('escapes leading spreadsheet formulas and multiline source descriptions',()=>{
  const p:MovementPage={epoch:id,throughSequence:3,hasMore:false,nextAfter:3,items:[{
   sequence:3,operationId:id,stockId:id,kind:'receive',quantity:100,onHandAfter:100,reservedAfter:0,recordedAt:'2026-11-14T00:00:00.000Z',
   actorId:id,deviceId:id,reason:'=RUN(1)\nquoted "note"',productionBatchId:null,
   materialId:id,materialCode:'-INPUT',materialName:' @SUM(1,2)',manufacturerLot:'"LOT,7"',
   locationId:id,fromLocationId:null,toLocationId:null,unit:'mg',audit:null,
  }]};
  const csv=inventoryMovementsCsv(p);
  expect(csv).toContain('"\'-INPUT"');
  expect(csv).toContain('"\' @SUM(1,2)"');
  expect(csv).toContain('"\'=RUN(1)\nquoted ""note"""');
  expect(csv).toContain('"""LOT,7"""');
  expect(csv).toContain('"100","mg","100","0"');
  expect(csv).toContain('"On hand after event","Reserved after event"');
  expect(csv).toContain('"History ID","Through ledger sequence","Sequence"');
  expect(csv).toContain(`"${id}","3","3","2026-11-14T00:00:00.000Z"`);
  expect(csv).toContain('"Source location ID"');
  expect(csv).toContain('"Destination location ID"');
  expect(csv).not.toContain('undefined');
 });
 it('has safe headers for zero results',()=>{
  const csv=inventoryMovementsCsv({epoch:id,throughSequence:0,hasMore:false,nextAfter:0,items:[]});
  expect(csv).toContain('Sequence');expect(csv).toContain('Operation ID');
 });
});

describe('bounded immutable movement export',()=>{
 const empty=(epoch:string,until:number,after:number,rows:number[],more:boolean):MovementPage=>({
  epoch,throughSequence:until,hasMore:more,nextAfter:rows.length?rows[rows.length-1]:after,
  items:rows.map(sequence=>({sequence,operationId:id,stockId:id,kind:'receive',
   quantity:1,onHandAfter:1,reservedAfter:0,recordedAt:'2026-11-14T00:00:00.000Z',
   actorId:id,deviceId:id,reason:'CI',productionBatchId:null,
   materialId:null,materialCode:null,materialName:null,manufacturerLot:null,
   locationId:null,fromLocationId:null,toLocationId:null,unit:null,audit:null})),
 });
 it('retrieves all pages within one immutable upper cursor',async()=>{
  const calls:number[]=[];
  const all=await collectMovementSnapshot(async(after,until)=>{
   calls.push(after);expect(until).toBe(5);
   return after===0?empty(id,5,0,[1,3],true):empty(id,5,3,[5],false);
  },5);
  expect(calls).toEqual([0,3]);
  expect(all.items.map(x=>x.sequence)).toEqual([1,3,5]);
  expect(all.hasMore).toBe(false);
 });
 it('never returns a partial export after exceeding the limit or cursor stall',async()=>{
  await expect(collectMovementSnapshot(async()=>empty(id,2,0,[1,2],true),2,2))
   .rejects.toThrow(/Too many movement rows/);
  await expect(collectMovementSnapshot(async()=>empty(id,2,0,[],true),2))
   .rejects.toThrow(/cursor stalled/);
 });
 it('rejects mixed history epochs across pages',async()=>{
  await expect(collectMovementSnapshot(async(after)=>{
   if(after===0)return empty(id,2,0,[1],true);
   return empty('22000000-0000-4000-8000-000000000002',2,1,[2],false);
  },2)).rejects.toThrow(/history changed/);
 });
});


describe('movement report UTC calendar validation',()=>{
 it('rejects invalid calendar days before touching the network',async()=>{
  for(const bad of ['2026-02-31','2027-02-29','2026-04-31','2026-13-01','2026-00-10']){
   await expect(loadInventoryMovements({} as never,{} as never,id,{from:bad}))
    .rejects.toThrow('Invalid movement date');
   await expect(loadInventoryMovements({} as never,{} as never,id,{through:bad}))
    .rejects.toThrow('Invalid movement date');
  }
 });
});
