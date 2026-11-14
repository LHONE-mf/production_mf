import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('anytime physical counts and separately approved correction',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;beforeEach(async()=>{f=await createInventoryHandoffFixture();});afterEach(async()=>{await f.app.close();await f.pool.end();});
 const action=(kind:string,countId:string,i=2,extra:object={})=>({operationId:randomUUID(),deviceId:f.actors[i].device,kind,countId,reason:'Synthetic physical count and reconciliation',evidence:'CI independent count sheet',...extra});
 const send=(b:object,i=2)=>f.post('/inventory/counts/operations',b,i);
 async function count(){const b=action('open',randomUUID()),r=await send(b);expect(r.statusCode,r.body).toBe(201);return b;}
 async function observe(countId:string,stockId:string,quantity:number){const r=await f.get('/inventory/changes?deviceId='+f.actors[2].device+'&cursor=0&limit=100',2);const stock=r.json().changes.filter((x:{stock:{stockId:string}})=>x.stock.stockId===stockId).at(-1).stock;const b=action('observe',countId,2,{stock,quantity}),result=await send(b);expect(result.statusCode,result.body).toBe(201);return{body:b,event:result.json().event,stock};}
 it('operator may start anytime, count/recount without stock change, manager explicitly corrects once',async()=>{
  const id=await f.stock(),c=await count(),a=await observe(c.countId,id,900),b=await observe(c.countId,id,950);expect((await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1',[id])).rows[0]).toEqual({on_hand:'1000',revision:2});
  const correction=action('correct',c.countId,1,{observationId:b.body.operationId,expectedRevision:2});expect((await send({...correction,deviceId:f.actors[2].device})).statusCode).toBe(403);
  const r=await send(correction,1);expect(r.statusCode,r.body).toBe(201);expect(r.json().stock).toMatchObject({onHand:950,reserved:0,quality:'released',revision:3});expect((await send(correction,1)).json()).toEqual({...r.json(),status:'duplicate'});expect((await send({...correction,evidence:'Changed witness'},1)).statusCode).toBe(409);
  expect((await f.pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE stock_id=$1 AND kind='count_adjustment'",[id])).rows[0].n).toBe(1);expect((await send(action('correct',c.countId,1,{observationId:a.body.operationId,expectedRevision:2}),1)).statusCode).toBe(409);
 });
 it('retains stale observations but requires new reconciliation before any correction, protecting reservations',async()=>{
  const {id}=await f.reserved(500),c=await count(),a=await observe(c.countId,id,499);expect((await send(action('correct',c.countId,1,{observationId:a.body.operationId,expectedRevision:3}),1)).statusCode).toBe(409);
  const b=await observe(c.countId,id,900);expect((await f.post('/inventory/stocks/'+id+'/splits',{operationId:randomUUID(),childOperationId:randomUUID(),deviceId:f.actors[1].device,parentStockId:id,childStockId:randomUUID(),locationId:f.location,expectedRevision:3,quantity:100,reason:'Physical source changes after count',evidence:'CI repack'},1)).statusCode).toBe(201);
  expect((await send(action('correct',c.countId,1,{observationId:b.body.operationId,expectedRevision:3}),1)).statusCode).toBe(409);expect((await send(action('observe',c.countId,2,{stock:b.stock,quantity:850}))).statusCode).toBe(201);
  const invalid=await send(action('observe',c.countId,2,{stock:{...b.stock,onHand:777,available:277},quantity:850}));expect(invalid.statusCode).toBe(409);
 });
 it('serializes competing corrections, denies generic Master and current revoked/history-held manager',async()=>{
  const id=await f.stock(),c=await count(),a=await observe(c.countId,id,900);expect((await send(action('correct',c.countId,3,{observationId:a.body.operationId,expectedRevision:2}),3)).statusCode).toBe(403);
  const results=await Promise.all([1,0].map(i=>send(action('correct',c.countId,i,{observationId:a.body.operationId,expectedRevision:2}),i)));expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);
  await f.pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[f.org,randomUUID()]);expect((await send(action('open',randomUUID()))).statusCode).toBe(409);
 });
 it('close preserves all evidence, stops further observations, and does not require stock correction',async()=>{
  const id=await f.stock(),c=await count(),a=await observe(c.countId,id,1000);const close=action('close',c.countId);expect((await send(close)).statusCode).toBe(201);expect((await send(close)).statusCode).toBe(200);expect((await send(action('observe',c.countId,2,{stock:a.stock,quantity:1000}))).statusCode).toBe(409);
  const history=await f.get('/inventory/counts/'+c.countId+'/events?deviceId='+f.actors[2].device+'&limit=1',2);expect(history.statusCode,history.body).toBe(200);expect(history.json()).toMatchObject({closed:true,hasMore:true,items:[{kind:'open'}]});expect(history.json().nextAfter).toBeGreaterThan(0);await expect(f.pool.query("DELETE FROM inventory_count_events WHERE organization_id=$1",[f.org])).rejects.toThrow('immutable');
 });
 it('never leaks another organization count/stock or treats observation as a stock ledger mutation',async()=>{
  const id=await f.stock(),c=await count(),other=await createInventoryHandoffFixture();try{expect((await other.get('/inventory/counts/'+c.countId+'/events?deviceId='+other.actors[2].device,2)).statusCode).toBe(404);expect((await other.post('/inventory/counts/operations',{...action('close',c.countId),deviceId:other.actors[2].device},2)).statusCode).toBe(404);}finally{await other.app.close();await other.pool.end();}
  const before=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;await observe(c.countId,id,0);expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(before);
 });
 it('enforces deferred DB pairing and global ID ownership, and revokes manager correction immediately',async()=>{
  const id=await f.stock(),c=await count(),a=await observe(c.countId,id,900),client=await f.pool.connect();try{await client.query('BEGIN');await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock) SELECT $1,organization_id,stock_id,actor_id,device_id,'count_adjustment',100,2,3,'Unpaired direct count',$2,result_stock FROM inventory_operations WHERE stock_id=$3 AND resulting_revision=2",[randomUUID(),JSON.stringify({kind:'correct'}),id]);await expect(client.query('COMMIT')).rejects.toThrow('inventory_count_pair_required');}finally{await client.query('ROLLBACK');client.release();}
  expect((await f.post('/inventory/receipts',{operationId:c.operationId,stockId:randomUUID(),deviceId:f.actors[2].device,materialId:f.material,locationId:f.location,manufacturerLot:'Never adopt count ID',quantity:1,expectedRevision:0,reason:'Intent collision'},2)).statusCode).toBe(409);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[1].id]);expect((await send(action('correct',c.countId,1,{observationId:a.body.operationId,expectedRevision:2}),1)).statusCode).toBe(403);expect((await f.pool.query('SELECT on_hand FROM inventory_stocks WHERE id=$1',[id])).rows[0].on_hand).toBe('1000');
 });
});
