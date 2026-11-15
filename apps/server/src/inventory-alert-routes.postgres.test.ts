import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';

describe.skipIf(!process.env.POSTGRES_TEST_URL)('authenticated stock-health alerts',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 function report(params:Record<string,string>={},actor=2){
  return f.get('/inventory/reports/alerts?'+new URLSearchParams({
    deviceId:f.actors[actor].device,...params,
  }),actor);
 }
 it('classifies low stock from real released inventory and never changes the ledger',async()=>{
  const id=await f.stock(),before=(await f.pool.query(
    'SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  const low=await report({materialId:f.material,lowAvailable:'1000',view:'alerts'});
  expect(low.statusCode,low.body).toBe(200);
  expect(low.json()).toMatchObject({epoch:f.epoch,lowAvailable:1000,items:[
    {stock:{stockId:id,onHand:1000,reserved:0,available:1000,quality:'released'},
     alerts:['low'],eligible:true}]});
  const clear=await report({materialId:f.material,lowAvailable:'999'});
  expect(clear.statusCode).toBe(200);expect(clear.json().items).toEqual([]);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',
    [f.org])).rows[0].n).toBe(before);
 });
 it('classifies quarantine and expiry separately; pages deterministically without merging maker lots',async()=>{
  const container=randomUUID();
  const receipt=await f.post('/inventory/receipts',{
    operationId:randomUUID(),deviceId:f.actors[2].device,stockId:container,
    materialId:f.material,locationId:f.location,manufacturerLot:'SAME-MAKER-LOT',
    expiresOn:'2025-01-01',quantity:500,expectedRevision:0,reason:'Synthetic expired receipt'},2);
  expect(receipt.statusCode,receipt.body).toBe(201);
  const first=await report({view:'all',limit:'1'});
  expect(first.statusCode).toBe(200);expect(first.json().items).toHaveLength(1);
  expect(first.json().hasMore).toBe(false);
  expect(first.json().items[0]).toMatchObject({stock:{stockId:container,quality:'quarantine'},
    alerts:['quarantine','expired']});
  await f.stock();
  const firstOfTwo=await report({view:'all',limit:'1'});
  expect(firstOfTwo.json().hasMore).toBe(true);
  const second=await report({view:'all',limit:'1',after:firstOfTwo.json().nextAfter});
  expect(second.json().items).toHaveLength(1);
  expect(second.json().items[0].stock.stockId).not.toBe(firstOfTwo.json().items[0].stock.stockId);
 });
 it('fails closed for ungranted users, revoked grants, wrong proof and mixed-unit threshold',async()=>{
  await f.stock();
  expect((await report({},4)).statusCode).toBe(403);
  expect((await report({lowAvailable:'1'})).statusCode).toBe(400);
  expect((await report({expiryDays:'999'})).statusCode).toBe(400);
  expect((await report({after:'not-a-uuid'})).statusCode).toBe(400);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',
    [f.org,f.actors[2].id]);
  expect((await report()).statusCode).toBe(403);
 });
});
