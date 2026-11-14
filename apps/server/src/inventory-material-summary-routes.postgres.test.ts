import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('material stock summary',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 const get=(params:Record<string,string>={},actor=2)=>f.get('/inventory/reports/materials?'+new URLSearchParams({
  deviceId:f.actors[actor].device,...params,
 }),actor);
 it('preserves actual base-unit totals, reservations and released eligibility',async()=>{
  await f.stock();await f.reserved(500);
  const before=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  const report=await get();
  expect(report.statusCode,report.body).toBe(200);
  expect(report.json().items).toMatchObject([{
   materialId:f.material,unit:'mg',onHand:'2000',reserved:'500',
   physicallyUnreserved:'1500',eligibleAvailable:'1500',
   packageCount:'2',manufacturerLots:'1',quarantined:'0',blocked:'0',
  }]);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(before);
 });
 it('applies approved stock thresholds and evaluates a material-wide low-stock alarm without posting stock',async()=>{
  await f.stock();await f.reserved(500);
  const before=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',
    [f.org])).rows[0].n;
  const policy=await f.post('/inventory/alert-policies',{
    changeId:randomUUID(),deviceId:f.actors[1].device,materialId:f.material,
    expectedRevision:0,lowAvailable:1600,expiryDays:14,active:true,
    reason:'Approved synthetic material safety threshold',
  },1);
  expect(policy.statusCode,policy.body).toBe(200);
  const report=await get();
  expect(report.statusCode,report.body).toBe(200);
  expect(report.json().items).toMatchObject([{
    materialId:f.material,eligibleAvailable:'1500',
    policy:{lowAvailable:1600,expiryDays:14,active:true,
      revision:1,lowStock:true,expiringPackages:'0'},
  }]);
  const disabled=await f.post('/inventory/alert-policies',{
    changeId:randomUUID(),deviceId:f.actors[1].device,materialId:f.material,
    expectedRevision:1,lowAvailable:1600,expiryDays:14,active:false,
    reason:'Temporary disable approved by warehouse manager',
  },1);
  expect(disabled.statusCode,disabled.body).toBe(200);
  expect((await get()).json().items[0].policy).toMatchObject({revision:2,active:false,lowStock:false});
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',
    [f.org])).rows[0].n).toBe(before);
 });
 it('includes zero-stock materials without fabricating packages and pages by material identity',async()=>{
  const other=randomUUID();
  const result=await f.post('/inventory/materials',{
   id:other,deviceId:f.actors[0].device,code:'SUM-'+other,name:'Unused synthetic material',
   category:'component',baseUnit:'pieces',
  },0);
  expect(result.statusCode,result.body).toBe(201);
  const p=await get({limit:'1'});expect(p.statusCode,p.body).toBe(200);expect(p.json().hasMore).toBe(true);
  const next=await get({limit:'1',after:p.json().nextAfter});
  expect(next.statusCode,next.body).toBe(200);
  const combined=[...p.json().items,...next.json().items];
  expect(combined.map((r:{materialId:string})=>r.materialId).sort()).toEqual([other,f.material].sort());
  expect(combined.find((r:{materialId:string})=>r.materialId===other)).toMatchObject({
   onHand:'0',reserved:'0',eligibleAvailable:'0',packageCount:'0',unit:'pieces',policy:null,
  });
  const saved=await f.post('/inventory/alert-policies',{
    changeId:randomUUID(),deviceId:f.actors[0].device,materialId:other,
    expectedRevision:0,lowAvailable:10,expiryDays:30,active:true,
    reason:'Warn when a component has no accepted stock',
  },0);
  expect(saved.statusCode,saved.body).toBe(200);
  expect((await get()).json().items.find((r:{materialId:string})=>r.materialId===other))
    .toMatchObject({eligibleAvailable:'0',policy:{lowAvailable:10,lowStock:true}});

 });
 it('fails closed for revoked operators, production-only users and invalid pages',async()=>{
  expect((await get({},4)).statusCode).toBe(403);
  expect((await get({limit:'999'})).statusCode).toBe(400);
  expect((await get({expiryDays:'999'})).statusCode).toBe(400);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',
   [f.org,f.actors[2].id]);
  expect((await get()).statusCode).toBe(403);
 });
});
