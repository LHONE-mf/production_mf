import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 stage handover and acknowledgement (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), foreignOrg = randomUUID();
  const chief = randomUUID(), receiver = randomUUID(), excludedMaster = randomUUID(), foreignChief = randomUUID();
  const actors = [chief, receiver, excludedMaster, foreignChief];
  const tokens = actors.map(() => randomBytes(32).toString('base64url'));
  const auth = (i: number) => ({ authorization: 'Bearer ' + tokens[i] });
  const code = () => randomUUID().slice(0,8);
  let routeId = '', orderId = '', batchId = '';
  const firstId = randomUUID(), secondId = randomUUID();
  const send = (handoffId: string, fromStep: number, toStep: number, index = 0,
      quantity = '20', quantityUnit = 'kg', batch = batchId) => app.inject({
    method:'POST',url:'/planning/batches/'+batch+'/handoffs',headers:auth(index),
    payload:{handoffId,fromStep,toStep,quantity,quantityUnit,note:'Transfer ticket'},
  });
  const receive = (handoffId: string, index = 1) => app.inject({
    method:'POST',url:'/planning/handoffs/'+handoffId+'/receive',headers:auth(index),
    payload:{note:'Count and label checked'},
  });
  const inbox = (index = 1) => app.inject({
    method:'GET',url:'/planning/handoffs/inbox',headers:auth(index),
  });
  const history = (index = 0) => app.inject({
    method:'GET',url:'/planning/batches/'+batchId+'/handoffs',headers:auth(index),
  });

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci')
      throw new Error('M2 handover tests require a disposable PostgreSQL database');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Handover fixture',foreignOrg,'Foreign handover fixture']);
    for (const [i,user] of actors.entries()) {
      const tenant = i === 3 ? foreignOrg : org;
      const role = i === 0 || i === 3 ? 'chief' : 'master';
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,[user,tenant,'handover-'+user,role]);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES ($1,'coating','Coating'),($1,'cutting','Cutting'),($1,'sorting','Sorting')`,[org]);
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'cutting'),($1,$2,'sorting')`,[org,receiver]);
    const route = await app.inject({method:'POST',url:'/planning/routes',headers:auth(0),
      payload:{code:'HND-'+code(),name:'Three-step cathode line',
        steps:[
          {name:'Coat cathode',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
          {name:'Cut cathode',stage:'cutting',workshopId:'cutting',electrodeLine:'cathode'},
          {name:'Sort cathode',stage:'sorting',workshopId:'sorting',electrodeLine:'cathode'},
        ]}});
    expect(route.statusCode).toBe(201);
    routeId = route.json().id;
    expect((await app.inject({method:'POST',
      url:'/planning/routes/'+routeId+'/versions/1/approve',headers:auth(0)})).statusCode).toBe(200);
    const order = await app.inject({method:'POST',url:'/planning/orders',headers:auth(0),
      payload:{orderCode:'PO-HND-'+code(),productCode:'NMC-CATHODE',
        routeId,routeVersion:1,plannedQuantity:'150',quantityUnit:'kg'}});
    expect(order.statusCode).toBe(201);
    orderId = order.json().id;
    expect((await app.inject({method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(0)})).statusCode).toBe(200);
    const batch = await app.inject({method:'POST',
      url:'/planning/orders/'+orderId+'/batches',headers:auth(0),
      payload:{batchCode:'HND-B-'+code(),materialLine:'cathode',
        plannedQuantity:'100',quantityUnit:'kg'}});
    expect(batch.statusCode).toBe(201);
    batchId = batch.json().id;
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('requires an active authorized batch and the next cathode route step', async () => {
    expect((await app.inject({
      method:'POST',url:'/planning/batches/'+batchId+'/handoffs',
      payload:{handoffId:randomUUID(),fromStep:1,toStep:2,quantity:'20',quantityUnit:'kg'},
    })).statusCode).toBe(401);
    expect((await send(randomUUID(),1,2,1)).statusCode).toBe(403);
    expect((await send(randomUUID(),1,2,3)).statusCode).toBe(404);
    expect((await send(randomUUID(),1,2,0,'20','kg',randomUUID())).statusCode).toBe(404);
    expect((await send(randomUUID(),1,2)).json()).toMatchObject({error:'batch_not_active'});
    expect((await app.inject({method:'POST',url:'/planning/batches/'+batchId+'/status',
      headers:auth(0),payload:{expectedStatus:'created',status:'in_progress'}})).statusCode).toBe(200);
    expect((await send(randomUUID(),1,3)).json()).toMatchObject({error:'not_next_route_step'});
    expect((await send(randomUUID(),2,3)).json()).toMatchObject({error:'previous_handoff_not_received'});
    expect((await send(randomUUID(),1,2,0,'150')).json())
      .toMatchObject({error:'handoff_quantity_exceeds_batch'});
    expect((await send(randomUUID(),1,2,0,'20','cells')).json())
      .toMatchObject({error:'handoff_quantity_exceeds_batch'});
  });

  it('sends an append-only transfer, blocks self receipt, and scopes the master inbox', async () => {
    const created = await send(firstId,1,2);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({id:firstId,batchId,status:'sent'});
    expect((await send(firstId,1,2)).json()).toMatchObject({status:'already_sent'});
    expect((await send(firstId,1,3)).json()).toMatchObject({error:'handoff_id_reused'});
    expect((await send(randomUUID(),1,2)).json())
      .toMatchObject({error:'previous_handoff_not_received'});
    const pending = (await inbox()).json().handoffs;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({id:firstId,batchId,toWorkshopId:'cutting',quantity:'20.000000'}),
    ]));
    expect((await inbox(2)).json().handoffs).toEqual([]);
    expect((await inbox(3)).json().handoffs).toEqual([]);
    expect((await receive(firstId,0)).json()).toMatchObject({error:'same_actor_cannot_receive'});
    expect((await receive(firstId,2)).json()).toMatchObject({error:'destination_workshop_access_denied'});
    expect((await receive(firstId,3)).statusCode).toBe(404);
    expect((await history(1)).statusCode).toBe(403);
    const accepted = await receive(firstId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({status:'received'});
    expect((await receive(firstId)).json()).toMatchObject({error:'handoff_already_received'});
    expect((await inbox()).json().handoffs).toEqual([]);
    const audit = (await history()).json().handoffs;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({id:firstId,fromStep:1,toStep:2,
      sentBy:chief,receivedBy:receiver,quantity:'20.000000',quantityUnit:'kg'});
    await expect(pool.query(`UPDATE production_stage_handoffs SET note='rewritten'
      WHERE organization_id=$1 AND id=$2`,[org,firstId])).rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_stage_receipts
      WHERE organization_id=$1 AND handoff_id=$2`,[org,firstId])).rejects.toThrow('append-only');
  });

  it('only advances through a received transfer and blocks work while a batch is held', async () => {
    expect((await send(secondId,2,3)).statusCode).toBe(201);
    expect((await inbox()).json().handoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({id:secondId,toWorkshopId:'sorting'}),
    ]));
    expect((await send(randomUUID(),2,3)).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/planning/batches/'+batchId+'/status',
      headers:auth(0),payload:{expectedStatus:'in_progress',status:'completed'}})).json())
      .toMatchObject({error:'handoff_receipt_pending'});
    expect((await app.inject({method:'POST',url:'/planning/batches/'+batchId+'/status',
      headers:auth(0),payload:{expectedStatus:'in_progress',status:'hold',
        reason:'Manual inspection required'}})).statusCode).toBe(200);
    expect((await receive(secondId)).statusCode).toBe(200);
    expect((await send(randomUUID(),2,3)).json()).toMatchObject({error:'batch_not_active'});
    expect((await app.inject({method:'POST',url:'/planning/batches/'+batchId+'/status',
      headers:auth(0),payload:{expectedStatus:'hold',status:'in_progress'}})).statusCode).toBe(200);
    expect((await send(randomUUID(),2,3)).json()).toMatchObject({error:'previous_handoff_not_received'});
    const historyRows = (await history()).json().handoffs;
    expect(historyRows.map((row:{fromStep:number;toStep:number})=>[row.fromStep,row.toStep]))
      .toEqual([[1,2],[2,3]]);
    expect(historyRows.every((row:{receivedBy:string|null})=>row.receivedBy===receiver)).toBe(true);
  });
});
