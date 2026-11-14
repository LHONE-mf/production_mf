import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('durable warehouse alert policies',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 const data=()=>({changeId:randomUUID(),deviceId:f.actors[1].device,
  materialId:f.material,expectedRevision:0,lowAvailable:5000,
  expiryDays:14,active:true,reason:'Synthetic warehouse safety threshold'});
 it('persists audited manager policy with revision CAS and exact idempotent replay',async()=>{
  const payload=data(),url='/inventory/alert-policies';
  const created=await f.post(url,payload,1);expect(created.statusCode,created.body).toBe(200);
  expect(created.json()).toMatchObject({status:'confirmed',policy:{materialId:f.material,
   lowAvailable:5000,expiryDays:14,revision:1}});
  const again=await f.post(url,payload,1);
  expect(again.statusCode,again.body).toBe(200);expect(again.json().status).toBe('duplicate');
  expect((await f.post(url,{...payload,lowAvailable:5001},1)).statusCode).toBe(409);
  expect((await f.post(url,{...data(),expectedRevision:0},1)).statusCode).toBe(409);
  const list=await f.get('/inventory/alert-policies?'+new URLSearchParams({deviceId:f.actors[2].device}),2);
  expect(list.statusCode,list.body).toBe(200);expect(list.json().policies).toHaveLength(1);
  const update=await f.post(url,{...data(),expectedRevision:1,active:false},1);
  expect(update.statusCode,update.body).toBe(200);expect(update.json().policy).toMatchObject({revision:2,active:false});
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_alert_policy_events WHERE organization_id=$1',[f.org])).rows[0].n).toBe(2);
 });
 it('rejects operator writes, production-only reads, revoked manager and wrong epoch',async()=>{
  const p=data();
  expect((await f.post('/inventory/alert-policies',{...p,deviceId:f.actors[2].device},2)).statusCode).toBe(403);
  expect((await f.get('/inventory/alert-policies?'+new URLSearchParams({deviceId:f.actors[4].device}),4)).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url:'/inventory/alert-policies',
   headers:{...f.headers(1),'x-inventory-epoch':randomUUID()},payload:p})).statusCode).toBe(409);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',
   [f.org,f.actors[1].id]);
  expect((await f.post('/inventory/alert-policies',p,1)).statusCode).toBe(403);
 });
});
