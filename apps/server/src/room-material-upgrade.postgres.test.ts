import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {describe,it,expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
import {createRoomHandoffFixture} from './room-handoff-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('Populated 032 → 033 room use upgrade',()=>{
 it('preserves all original rows and adds no invented custody or consumption',async()=>{
  const target=new URL(process.env.POSTGRES_TEST_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/production_mf_ci'||target.username!=='production_mf_ci')throw Error('Owned disposable PostgreSQL required');
  const admin=new Pool({connectionString:process.env.POSTGRES_TEST_URL}),client=await admin.connect(),schema='room_upgrade_'+randomUUID().replaceAll('-','');
  let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>|undefined;
  try{
   await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
   for(const file of (await readdir('migrations')).filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=32).sort())await client.query(await readFile('migrations/'+file,'utf8'));
   f=await createInventoryHandoffFixture(schema);const {id,issue}=await f.reserved();
   for(const [kind,rev,actor,extra]of [['approve',2,1,{expectedStockRevision:3}],['dispatch',3,1,{expectedStockRevision:3}],['receive',4,4,{}]]as const)expect((await f.act(issue.id,f.operation(kind,rev,actor,extra),actor)).statusCode).toBe(201);
   expect((await f.post(`/inventory/issues/${issue.id}/outcomes`,{operationId:randomUUID(),deviceId:f.actors[1].device,issueId:issue.id,productionBatchId:f.batch,sourceStockId:id,expectedSettlementRevision:1,quantity:50,kind:'scrap',reason:'Historical unused scrap',evidence:'Synthetic pre-upgrade record'},1)).statusCode).toBe(201);
   const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(r=>r.tablename as string);
   const rows=new Map<string,unknown[]>();for(const name of names)rows.set(name,(await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>r.row));
   await client.query(await readFile('migrations/033_room_material_consumption.sql','utf8'));
   for(const name of names){const now=(await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>{if(name==='inventory_issue_outcomes'){delete r.row.consumption_id;delete r.row.component_id;}return r.row;});expect(now,name).toEqual(rows.get(name));}
   expect((await client.query('SELECT count(*)::int AS n FROM inventory_slurry_consumptions')).rows[0].n).toBe(0);
   const after=await f.get(`/inventory/room-materials/slurry?deviceId=${f.actors[4].device}`,4);expect(after.statusCode,after.body).toBe(200);expect(after.json().items[0].settlement).toMatchObject({consumed:0,scrapped:50,outstanding:450});
  }finally{await f?.app.close();await f?.pool.end();await client.query('ROLLBACK');await client.query('RESET search_path');await client.query('DROP SCHEMA '+schema+' CASCADE');client.release();await admin.end();}
 },30000);
 it('preserves populated 033 rows and creates no manufactured output or handoff on 034 upgrade',async()=>{
  const target=new URL(process.env.POSTGRES_TEST_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/production_mf_ci'||target.username!=='production_mf_ci')throw Error('Owned disposable PostgreSQL required');
  const admin=new Pool({connectionString:process.env.POSTGRES_TEST_URL}),client=await admin.connect(),schema='room_upgrade_'+randomUUID().replaceAll('-','');
  let f:Awaited<ReturnType<typeof createRoomHandoffFixture>>|undefined;
  try{
   await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
   for(const file of (await readdir('migrations')).filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=33).sort())await client.query(await readFile('migrations/'+file,'utf8'));
   f=await createRoomHandoffFixture(schema);const {consumption}=await f.consumed();
   const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(r=>r.tablename as string),rows=new Map<string,unknown[]>();
   for(const name of names)rows.set(name,(await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>r.row));
   await client.query(await readFile('migrations/034_room_output_handoffs.sql','utf8'));
   for(const name of names)expect((await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>r.row),name).toEqual(rows.get(name));
   for(const name of ['inventory_room_outputs','inventory_room_output_lots','inventory_room_handoffs','inventory_room_handoff_events'])expect((await client.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n).toBe(0);
   const sources=await f.get(`/inventory/room-outputs/slurry/sources?deviceId=${f.actors[4].device}`,4);expect(sources.statusCode,sources.body).toBe(200);expect(sources.json().items[0]).toMatchObject({operationId:consumption.operationId,declarationId:null,inputQuantity:1000});
  }finally{await f?.app.close();await f?.pool.end();await client.query('ROLLBACK');await client.query('RESET search_path');await client.query('DROP SCHEMA '+schema+' CASCADE');client.release();await admin.end();}
 },30000);

 it('preserves populated 034 output/receipt and adds no invented Coating use during 035 upgrade',async()=>{
  const target=new URL(process.env.POSTGRES_TEST_URL!);if(!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/production_mf_ci'||target.username!=='production_mf_ci')throw Error('Owned disposable PostgreSQL required');
  const admin=new Pool({connectionString:process.env.POSTGRES_TEST_URL}),client=await admin.connect(),schema='room_upgrade_'+randomUUID().replaceAll('-','');
  let f:Awaited<ReturnType<typeof createRoomHandoffFixture>>|undefined;
  try{
   await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
   for(const file of (await readdir('migrations')).filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=34).sort())await client.query(await readFile('migrations/'+file,'utf8'));
   f=await createRoomHandoffFixture(schema);const received=await f.receivedSlurry();
   const names=(await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[schema])).rows.map(r=>r.tablename as string),before=new Map<string,unknown[]>();
   for(const name of names)before.set(name,(await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>r.row));
   await client.query(await readFile('migrations/035_coating_slurry_consumption.sql','utf8'));
   for(const name of names)expect((await client.query('SELECT to_jsonb(t) AS row FROM '+name+' t')).rows.map(r=>r.row),name).toEqual(before.get(name));
   for(const name of ['inventory_coating_consumptions','inventory_coating_allocations'])expect((await client.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n).toBe(0);
   const after=await f.get(`/inventory/room-materials/coating/slurry?deviceId=${f.actors[5].device}`,5);expect(after.statusCode,after.body).toBe(200);expect(after.json().items[0]).toMatchObject({received:400,consumed:0,remaining:400,revision:1});
   const replay=await f.post('/inventory/room-handoffs/acknowledgements',received.receiptRequest,5);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().receipt).toEqual(received.receipt);
  }finally{await f?.app.close();await f?.pool.end();await client.query('ROLLBACK');await client.query('RESET search_path');await client.query('DROP SCHEMA '+schema+' CASCADE');client.release();await admin.end();}
 },30000);

});
