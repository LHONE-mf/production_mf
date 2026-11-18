import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('Room custody and actual Slurry use (real PostgreSQL)',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeAll(async()=>{f=await createInventoryHandoffFixture();});
 afterAll(async()=>{await f?.app.close();await f?.pool.end();});
 async function received(quantity=6000000){
  const stockId=randomUUID();
  expect((await f.post('/inventory/receipts',{operationId:randomUUID(),stockId,deviceId:f.actors[2].device,materialId:f.material,locationId:f.location,manufacturerLot:stockId,quantity:10000000,expectedRevision:0,reason:'Synthetic 10000 g receipt'},2)).statusCode).toBe(201);
  expect((await f.post(`/inventory/stocks/${stockId}/quality-dispositions`,{operationId:randomUUID(),stockId,deviceId:f.actors[0].device,expectedRevision:1,disposition:'release',reason:'QA',evidence:'Synthetic certificate'})).statusCode).toBe(201);
  const req=await f.request(quantity);
  for(const [kind,revision,stockRevision]of [['reserve',1,2],['approve',2,3],['dispatch',3,3]]as const){
   const result=await f.act(req.issue.id,f.operation(kind,revision,1,{expectedStockRevision:stockRevision,...(kind==='reserve'?{stockId}:{})}));expect(result.statusCode,result.body).toBe(201);
  }
  const response=await f.act(req.issue.id,f.operation('receive',4,4),4);expect(response.statusCode,response.body).toBe(201);
  return{stockId,issueId:req.issue.id};
 }
 function command(parents:{issueId:string;quantity:number;revision?:number}[],sourceId=randomUUID()){
  return{operationId:randomUUID(),deviceId:f.actors[4].device,productionBatchId:f.batch,stepNumber:1,
   source:{id:sourceId,recordedAt:Date.now(),recordedBy:'synthetic-local-author',recordedRole:'worker',batchCode:sourceId,recipeId:null,recipeRevision:null,recipeName:'Measured synthetic binder',measurementNote:'Scale observation',components:[{componentId:'binder',componentVersion:1,actualMg:parents.reduce((n,p)=>n+p.quantity,0)}]},
   allocations:parents.map(p=>({operationId:randomUUID(),issueId:p.issueId,materialId:f.material,componentId:'binder',quantity:p.quantity,expectedSettlementRevision:p.revision??1})),reason:'Actual weighed use',evidence:'Synthetic weighed record'};
 }
 it('receives 6000 g, consumes 4700 g, retains 1300 g; warehouse debit occurs only at dispatch',async()=>{
  const p=await received(),request=command([{issueId:p.issueId,quantity:4700000}]);
  const before=await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1',[p.stockId]);
  const response=await f.post('/inventory/room-materials/slurry/consumptions',request,4);expect(response.statusCode,response.body).toBe(201);
  const choices=await f.get(`/inventory/room-materials/slurry?deviceId=${f.actors[4].device}`,4);
  expect(choices.statusCode,choices.body).toBe(200);
  expect(choices.json().items.find((r:{issue:{id:string}})=>r.issue.id===p.issueId).settlement).toMatchObject({issued:6000000,consumed:4700000,outstanding:1300000,revision:2});
  expect((await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1',[p.stockId])).rows).toEqual(before.rows);
  expect(before.rows[0].on_hand).toBe('4000000');
  expect((await f.post('/inventory/room-materials/slurry/consumptions',request,4)).json()).toEqual({...response.json(),status:'duplicate'});
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...request,evidence:'changed'},4)).statusCode).toBe(409);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...request,operationId:randomUUID()},4)).statusCode).toBe(409);
  const report=await f.get(`/inventory/reports/reconciliation?deviceId=${f.actors[0].device}`);
  expect(report.json().items.find((r:{issueId:string})=>r.issueId===p.issueId)).toMatchObject({consumed:4700000,consumptionStatus:'recorded',outstanding:1300000});
 });
 it('allocates 1500 g and 700 g from two explicit lots in one atomic measured source',async()=>{
  const a=await received(),b=await received();
  const body=command([{issueId:a.issueId,quantity:1500000},{issueId:b.issueId,quantity:700000}]);
  const r=await f.post('/inventory/room-materials/slurry/consumptions',body,4);expect(r.statusCode,r.body).toBe(201);
  expect(r.json().consumption.allocations).toEqual(body.allocations);
  const rows=(await f.get(`/inventory/room-materials/slurry?deviceId=${f.actors[4].device}`,4)).json().items;
  expect(rows.find((r:{issue:{id:string}})=>r.issue.id===a.issueId).settlement.outstanding).toBe(4500000);
  expect(rows.find((r:{issue:{id:string}})=>r.issue.id===b.issueId).settlement.outstanding).toBe(5300000);
 });
 it('serializes competing devices and prevents returning consumed quantities',async()=>{
  const p=await received(1000),one=command([{issueId:p.issueId,quantity:800}]),two={...command([{issueId:p.issueId,quantity:800}]),deviceId:f.actors[3].device};
  const results=await Promise.all([f.post('/inventory/room-materials/slurry/consumptions',one,4),f.post('/inventory/room-materials/slurry/consumptions',two,3)]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);
  const scrap={operationId:randomUUID(),deviceId:f.actors[1].device,issueId:p.issueId,productionBatchId:f.batch,sourceStockId:p.stockId,expectedSettlementRevision:2,quantity:201,kind:'scrap',reason:'Cannot settle used material',evidence:'Synthetic test'};
  expect((await f.post(`/inventory/issues/${p.issueId}/outcomes`,scrap,1)).statusCode).toBe(409);
  const ok=await f.post(`/inventory/issues/${p.issueId}/outcomes`,{...scrap,quantity:200},1);expect(ok.statusCode,ok.body).toBe(201);expect(ok.json().settlement).toMatchObject({consumed:800,scrapped:200,outstanding:0});
 });
 it('fails closed on authority, changed units/measurements, holds and incomplete allocation',async()=>{
  const p=await received(1000),body=command([{issueId:p.issueId,quantity:800}]);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...body,deviceId:f.actors[2].device},2)).statusCode).toBe(403);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...body,source:{...body.source,components:[{...body.source.components[0],actualMg:801}]}},4)).statusCode).toBe(400);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...body,allocations:[{...body.allocations[0],quantity:0.5}]},4)).statusCode).toBe(400);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',{...body,stepNumber:2147483648},4)).statusCode).toBe(400);
  await f.pool.query("UPDATE inventory_stocks SET quality='blocked' WHERE id=$1",[p.stockId]);
  expect((await f.post('/inventory/room-materials/slurry/consumptions',body,4)).statusCode).toBe(409);
 });
 it('retains a partial source across two separately declared measured operations',async()=>{
  const p=await received(1000);
  for(const [quantity,revision]of [[400,1],[200,2]]){
   const request=command([{issueId:p.issueId,quantity,revision}]);request.reason=' Actual observed use ';request.source.recipeName=' Exact original recipe name ';
   const r=await f.post('/inventory/room-materials/slurry/consumptions',request,4);expect(r.statusCode,r.body).toBe(201);expect(r.json().consumption.reason).toBe(request.reason);expect(r.json().consumption.source).toEqual(request.source);
  }
  const page=(await f.get(`/inventory/room-materials/slurry?deviceId=${f.actors[4].device}`,4)).json();
  expect(page.items.find((r:{issue:{id:string}})=>r.issue.id===p.issueId).settlement).toMatchObject({consumed:600,outstanding:400,revision:3});
 });
 it('returns only the eligible unused remainder and preserves exclusive operation IDs and original epoch',async()=>{
  const p=await received(1000),body=command([{issueId:p.issueId,quantity:800}]);
  const first=await f.post('/inventory/room-materials/slurry/consumptions',body,4);expect(first.statusCode,first.body).toBe(201);
  const source=(await f.pool.query('SELECT revision FROM inventory_stocks WHERE id=$1',[p.stockId])).rows[0];
  const returned=await f.post(`/inventory/issues/${p.issueId}/outcomes`,{kind:'return',operationId:randomUUID(),deviceId:f.actors[2].device,issueId:p.issueId,productionBatchId:f.batch,sourceStockId:p.stockId,expectedSettlementRevision:2,expectedSourceRevision:source.revision,stockId:randomUUID(),locationId:f.location,condition:'untouched_unused',quantity:200,reason:'Eligible untouched remainder',evidence:'Physical unused quantity'},2);
  expect(returned.statusCode,returned.body).toBe(201);expect(returned.json().settlement).toMatchObject({consumed:800,returned:200,outstanding:0});
  const replay=await f.app.inject({method:'POST',url:'/inventory/room-materials/slurry/consumptions',headers:{...f.headers(4),'x-inventory-epoch':randomUUID()},payload:body});expect(replay.statusCode).toBe(409);
  const reused={...command([{issueId:p.issueId,quantity:1}]),operationId:body.allocations[0].operationId};
  expect((await f.post('/inventory/room-materials/slurry/consumptions',reused,4)).statusCode).toBe(409);
  await expect(f.pool.query("UPDATE inventory_slurry_consumptions SET source_id='rewritten' WHERE operation_id=$1",[body.operationId])).rejects.toThrow('immutable');
 });
});
