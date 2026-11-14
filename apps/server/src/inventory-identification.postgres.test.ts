import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('scoped package/location/batch identification',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;beforeEach(async()=>{f=await createInventoryHandoffFixture();});afterEach(async()=>{await f.app.close();await f.pool.end();});
 const lookup=(kind:string,id:string,i=2,org?:string)=>f.get('/inventory/identification?'+new URLSearchParams({deviceId:f.actors[i].device,organizationId:org??f.org,kind,id}),i);
 it('resolves distinct same-lot containers with actual stock/material/location and no mutation',async()=>{
  const a=await f.stock(),b=await f.stock(),before=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  for(const id of [a,b]){const r=await lookup('container',id);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toMatchObject({epoch:f.epoch,kind:'container',item:{stock:{stockId:id,manufacturerLot:'SAME-MAKER-LOT',onHand:1000,quality:'released'},materialName:'Synthetic issue powder',eligible:true,origin:{kind:'receive'}}});expect(JSON.stringify(r.json())).not.toMatch(/password|token_hash|public_key/);}
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(before);
 });
 it('resolves exact location hierarchy identity and existing batch/order without inventing IDs',async()=>{
  const location=await lookup('location',f.location);expect(location.statusCode,location.body).toBe(200);expect(location.json()).toMatchObject({kind:'location',item:{id:f.location,parentId:null,label:'Issue warehouse',active:true}});
  const batch=await lookup('batch',f.batch);expect(batch.statusCode,batch.body).toBe(200);expect(batch.json()).toMatchObject({kind:'batch',item:{id:f.batch,materialLine:'cathode',status:'created'}});
 });
 it('production members may identify only own-workshop batches, never unrestricted stock/locations',async()=>{
  expect((await lookup('batch',f.batch,4)).statusCode).toBe(200);expect((await lookup('batch',f.batch,5)).statusCode).toBe(404);const id=await f.stock();expect((await lookup('container',id,4)).statusCode).toBe(403);expect((await lookup('location',f.location,4)).statusCode).toBe(403);
 });
 it('rejects malformed/wrong-kind/other-organization identities and current revoked access',async()=>{
  const id=await f.stock();expect((await lookup('container',id,2,randomUUID())).statusCode).toBe(404);expect((await lookup('batch',id)).statusCode).toBe(404);expect((await lookup('container','demo-local-id')).statusCode).toBe(400);expect((await lookup('release',id)).statusCode).toBe(400);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);expect((await lookup('container',id)).statusCode).toBe(403);
 });
});
