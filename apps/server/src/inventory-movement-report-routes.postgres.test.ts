import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('authenticated immutable inventory movement report',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 const url=(query:Record<string,string>={},i=2)=>'/inventory/reports/movements?'+new URLSearchParams({deviceId:f.actors[i].device,...query});
 const get=(query:Record<string,string>={},i=2)=>f.get(url(query,i),i);
 it('paginates immutable QA and receipt ledger without creating stock or crossing the snapshot',async()=>{
  const id=await f.stock();
  const first=await get({stockId:id,limit:'1'});
  expect(first.statusCode,first.body).toBe(200);
  expect(first.json()).toMatchObject({epoch:f.epoch,hasMore:true,items:[{
   stockId:id,kind:'receive',quantity:1000,materialCode:expect.any(String),
   materialName:'Synthetic issue powder',unit:'mg',
  }]});
  const {nextAfter,throughSequence}=first.json();
  expect(Number.isSafeInteger(nextAfter)).toBe(true);
  const second=await get({stockId:id,limit:'1',after:String(nextAfter),until:String(throughSequence)});
  expect(second.statusCode,second.body).toBe(200);
  expect(second.json()).toMatchObject({hasMore:false,throughSequence,items:[{kind:'quality_change',stockId:id,quantity:0}]});
  const count=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  await f.stock();
  const held=await get({until:String(throughSequence),after:String(nextAfter)});
  expect(held.json().items).toHaveLength(1);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(count+2);
 });
 it('filters by original server-ledger kind, material and UTC date; rejects impossible bounds',async()=>{
  const id=await f.stock();
  const okay=await get({materialId:f.material,kind:'receive',from:'2026-01-01',through:'2026-12-31'});
  expect(okay.statusCode,okay.body).toBe(200);
  expect(okay.json().items).toMatchObject([{stockId:id,kind:'receive'}]);
  expect((await get({kind:'does-not-exist'})).statusCode).toBe(400);
  expect((await get({from:'2026-12-31',through:'2026-01-01'})).statusCode).toBe(400);
  expect((await get({until:'0',after:'2'})).statusCode).toBe(409);
  expect((await get({limit:'101'})).statusCode).toBe(400);
 });
 it('denies production-only, revoked-warehouse and wrong-device proof; never exposes secrets',async()=>{
  await f.stock();
  expect((await get({},4)).statusCode).toBe(403);
  const readable=await get();
  expect(readable.statusCode,readable.body).toBe(200);
  expect(JSON.stringify(readable.json())).not.toMatch(/token_hash|password_hash|request_payload|signature/);
  const wrong=await f.app.inject({method:'GET',url:url(),headers:{
    ...f.headers(2),'x-device-proof':f.actors[1].proof,
  }});
  expect(wrong.statusCode).toBe(403);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',
    [f.org,f.actors[2].id]);
  expect((await get()).statusCode).toBe(403);
 });
});
