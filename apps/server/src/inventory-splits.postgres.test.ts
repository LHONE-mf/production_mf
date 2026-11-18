import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('authorized physical package splits',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});afterEach(async()=>{await f.app.close();await f.pool.end();});
 const path=(id:string)=>'/inventory/stocks/'+id+'/splits';
 const send=(id:string,body:object,i=1)=>f.post(path(id),body,i);
 function intent(id:string,i=1,extra:object={}){return{operationId:randomUUID(),childOperationId:randomUUID(),deviceId:f.actors[i].device,parentStockId:id,childStockId:randomUUID(),locationId:f.location,expectedRevision:2,quantity:300,reason:'Physical partial repack authorized by warehouse manager',evidence:'CI sealed child weight and label report',...extra};}
 it('conserves one physical parent and child, inherits QA/dates, retries immutable results and exposes lineage',async()=>{
  const id=await f.stock('2099-12-31'),body=intent(id),r=await send(id,body);expect(r.statusCode,r.body).toBe(201);const ack=r.json();
  expect(ack.parent).toMatchObject({stockId:id,onHand:700,reserved:0,revision:3});expect(ack.child).toMatchObject({stockId:body.childStockId,onHand:300,reserved:0,revision:1,quality:'released',disposition:'release',manufacturerLot:'SAME-MAKER-LOT',expiresAt:'2100-01-01T00:00:00.000Z',manufacturedOn:'2026-01-01'});
  expect(ack.parent.onHand+ack.child.onHand).toBe(1000);expect((await send(id,body)).json()).toEqual({...ack,status:'duplicate'});
  expect((await send(id,{...body,quantity:301})).statusCode).toBe(409);
  expect((await f.pool.query('SELECT kind FROM inventory_operations WHERE operation_id=ANY($1::uuid[]) ORDER BY sequence',[[body.operationId,body.childOperationId]])).rows.map(r=>r.kind)).toEqual(['split_out','split_in']);
  const lineage=await f.get('/inventory/stocks/'+body.childStockId+'/genealogy?deviceId='+f.actors[2].device,2);expect(lineage.statusCode,lineage.body).toBe(200);expect(lineage.json().items).toContainEqual(expect.objectContaining({kind:'split',parentStockId:id,childStockId:body.childStockId,quantity:300}));
  await expect(f.pool.query("UPDATE inventory_splits SET evidence='rewrite' WHERE operation_id=$1",[body.operationId])).rejects.toThrow(/immutable/);
 });
 it('preserves owned reservations on parent and forbids overdrawing or transferring them to child',async()=>{
  const {id}=await f.reserved(500),body=intent(id,1,{expectedRevision:3,quantity:501});expect((await send(id,body)).statusCode).toBe(409);
  const r=await send(id,{...body,operationId:randomUUID(),quantity:500});expect(r.statusCode,r.body).toBe(201);expect(r.json().parent).toMatchObject({onHand:500,reserved:500,available:0});expect(r.json().child).toMatchObject({onHand:500,reserved:0});expect((await f.pool.query('SELECT quantity FROM inventory_reservations WHERE organization_id=$1',[f.org])).rows[0].quantity).toBe('500');
 });
 it('requires current Chief or explicit manager; neither operator nor generic Master can approve',async()=>{
  const id=await f.stock();for(const i of [2,3,4])expect((await send(id,intent(id,i),i)).statusCode).toBe(403);
  expect((await send(id,intent(id,0),0)).statusCode).toBe(201);
 });
 it('serializes competing splits and rejects child/operation collisions without partial stock',async()=>{
  const id=await f.stock(),a=intent(id),b=intent(id);const results=await Promise.all([send(id,a),send(id,b)]);expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);
  const accepted=results[0].statusCode===201?a:b;const second=await f.stock();expect((await send(second,intent(second,1,{childStockId:accepted.childStockId}))).statusCode).toBe(409);expect((await f.pool.query('SELECT on_hand FROM inventory_stocks WHERE id=$1',[second])).rows[0].on_hand).toBe('1000');
  expect((await send(second,intent(second,1,{operationId:accepted.childOperationId}))).statusCode).toBe(409);
 });
 it('full repack leaves empty parent identity and later parent hold prevents child use or release override',async()=>{
  const id=await f.stock(),b=intent(id,1,{quantity:1000}),r=await send(id,b);expect(r.statusCode,r.body).toBe(201);expect(r.json().parent.onHand).toBe(0);
  expect((await f.post('/inventory/stocks/'+id+'/quality-dispositions',{operationId:randomUUID(),stockId:id,deviceId:f.actors[0].device,expectedRevision:3,disposition:'hold',reason:'Recalled original source',evidence:'CI recall certificate'})).statusCode).toBe(201);
  expect((await f.post('/inventory/stocks/'+b.childStockId+'/operations',{operationId:randomUUID(),deviceId:f.actors[1].device,kind:'reserve',expectedRevision:1,quantity:1,reservationId:randomUUID(),productionBatchId:f.batch,reason:'Cannot bypass inherited source hold'},1)).statusCode).toBe(409);
  expect((await f.post('/inventory/stocks/'+b.childStockId+'/quality-dispositions',{operationId:randomUUID(),stockId:b.childStockId,deviceId:f.actors[0].device,expectedRevision:1,disposition:'release',reason:'Cannot bypass source hold',evidence:'CI denial'})).statusCode).toBe(409);
 });
 it('tenant, history, disabled destination and revoked manager remain fenced',async()=>{
  const id=await f.stock(),other=await createInventoryHandoffFixture();try{expect((await other.post(path(id),{...intent(id),deviceId:other.actors[1].device} ,1)).statusCode).toBe(404);}finally{await other.app.close();await other.pool.end();}
  const invalid=intent(id,1,{locationId:randomUUID()});expect((await send(id,invalid)).statusCode).toBe(404);expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1',[invalid.childStockId])).rowCount).toBe(0);
  await f.pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[f.org,randomUUID()]);expect((await send(id,intent(id))).statusCode).toBe(409);
  await f.pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[f.org,f.epoch]);await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[1].id]);expect((await send(id,intent(id))).statusCode).toBe(403);
 });
 it('cannot commit an unpaired split debit directly and preserves held QA during an authorized repack',async()=>{
  const id=await f.stock(),b=intent(id),client=await f.pool.connect();try{await client.query('BEGIN');await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock) SELECT $1,organization_id,stock_id,actor_id,device_id,'split_out',1,2,3,'Unpaired direct debit',$2,result_stock FROM inventory_operations WHERE stock_id=$3 AND resulting_revision=2",[b.operationId,JSON.stringify(b),id]);await expect(client.query('COMMIT')).rejects.toThrow('inventory_split_pair_required');}finally{await client.query('ROLLBACK');client.release();}
  expect((await f.pool.query('SELECT 1 FROM inventory_operations WHERE operation_id=$1',[b.operationId])).rowCount).toBe(0);
  expect((await f.post('/inventory/stocks/'+id+'/quality-dispositions',{operationId:randomUUID(),stockId:id,deviceId:f.actors[0].device,expectedRevision:2,disposition:'hold',reason:'Hold original before repack',evidence:'CI hold'})).statusCode).toBe(201);
  const r=await send(id,intent(id,1,{expectedRevision:3}));expect(r.statusCode,r.body).toBe(201);expect(r.json().child).toMatchObject({quality:'blocked',disposition:'hold',onHand:300});expect(r.json().parent).toMatchObject({quality:'blocked',disposition:'hold',onHand:700});
 });

 it('rejects blocked packages without altering original stock or creating a child',async()=>{
  const id=await f.stock();
  const hold=await f.post('/inventory/stocks/'+id+'/quality-dispositions',{
   operationId:randomUUID(),stockId:id,deviceId:f.actors[0].device,expectedRevision:2,
   disposition:'hold',reason:'Synthetic QA hold',evidence:'Controlled QA decision'
  });expect(hold.statusCode,hold.body).toBe(201);
  const request=intent(id,1,{expectedRevision:3,quarantineAcknowledged:true});
  const result=await send(id,request);
  expect(result.statusCode,result.body).toBe(409);
  expect((await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1',[id])).rows[0])
   .toMatchObject({on_hand:'1000',revision:3});
  expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1',[request.childStockId])).rowCount).toBe(0);
 });
 it('requires explicit quarantine acknowledgement and stores it with inherited quality',async()=>{
  const id=randomUUID();
  const receipt=await f.post('/inventory/receipts',{
   operationId:randomUUID(),stockId:id,deviceId:f.actors[2].device,
   materialId:f.material,locationId:f.location,manufacturerLot:'QUARANTINE-LOT',
   quantity:1000,expectedRevision:0,reason:'Synthetic physical receipt'
  },2);expect(receipt.statusCode,receipt.body).toBe(201);
  const unsigned=intent(id,1,{expectedRevision:1});
  expect((await send(id,unsigned)).statusCode).toBe(409);
  expect((await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1',[id])).rows[0])
   .toMatchObject({on_hand:'1000',revision:1});
  const approved=intent(id,1,{expectedRevision:1,quarantineAcknowledged:true});
  const result=await send(id,approved);expect(result.statusCode,result.body).toBe(201);
  expect(result.json().parent).toMatchObject({quality:'quarantine',onHand:700});
  expect(result.json().child).toMatchObject({quality:'quarantine',onHand:300});
  const stored=await f.pool.query('SELECT quarantine_acknowledged FROM inventory_splits WHERE operation_id=$1',[approved.operationId]);
  expect(stored.rows[0]?.quarantine_acknowledged).toBe(true);
  expect((await send(id,approved)).json()).toEqual({...result.json(),status:'duplicate'});
 });
});
