import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 append-only route-step evidence (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), foreignOrg = randomUUID();
  const chief = randomUUID(), master = randomUUID(), foreignChief = randomUUID();
  const actors = [chief, master, foreignChief];
  const tokens = actors.map(() => randomBytes(32).toString('base64url'));
  const auth = (i: number) => ({ authorization: 'Bearer ' + tokens[i] });
  const code = (label: string) => label + '-' + randomUUID().slice(0,8);
  let routeId = '', orderId = '', batchId = '';
  let startId = '', finishId = '';
  const step = (number: number, kind: 'started'|'completed'|'deviation', id: string = randomUUID(),
    extra: Record<string,string> = {}, i = 0, batch = batchId) =>
    app.inject({
      method: 'POST', url: '/planning/batches/' + batch + '/steps/' + number + '/evidence',
      headers: auth(i), payload: {
        eventId: id, kind,
        ...(kind === 'completed' ? { quantity: '50.000000', quantityUnit: 'kg' } : {}),
        ...extra,
      },
    });
  const read = (i = 0) => app.inject({
    method: 'GET', url: '/planning/batches/' + batchId + '/steps', headers: auth(i),
  });

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci')
      throw new Error('Refusing non-disposable PostgreSQL for step evidence tests');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Step evidence pilot',foreignOrg,'Foreign step pilot']);
    for (const [i,user] of actors.entries()) {
      const tenant = i === 2 ? foreignOrg : org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,tenant,'evidence-'+user,i === 1 ? 'master' : 'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating'),($1,'cutting','Cutting')`,[org]);
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'cutting')`,[org,master]);
    const route = await app.inject({method:'POST',url:'/planning/routes',headers:auth(0),
      payload:{code:code('ROUTE'),name:'Evidence process route',steps:[
        {name:'Cathode coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cathode cutting',stage:'cutting',workshopId:'cutting',electrodeLine:'cathode'},
      ]}});
    expect(route.statusCode).toBe(201);
    routeId = route.json().id;
    expect((await app.inject({method:'POST',
      url:'/planning/routes/'+routeId+'/versions/1/approve',headers:auth(0)})).statusCode).toBe(200);
    const order = await app.inject({method:'POST',url:'/planning/orders',headers:auth(0),
      payload:{orderCode:code('ORDER'),productCode:'NMC-CATHODE',
        routeId,routeVersion:1,plannedQuantity:'100',quantityUnit:'kg'}});
    expect(order.statusCode).toBe(201);
    orderId = order.json().id;
    expect((await app.inject({method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(0)})).statusCode).toBe(200);
    const batch = await app.inject({method:'POST',
      url:'/planning/orders/'+orderId+'/batches',headers:auth(0),
      payload:{batchCode:code('CATH'),materialLine:'cathode',
        plannedQuantity:'100',quantityUnit:'kg'}});
    expect(batch.statusCode).toBe(201);
    batchId = batch.json().id;
  });
  afterAll(async () => {
    // The throwaway CI database is destroyed by the job. Never work around
    // the immutable route, genealogy or evidence history for cleanup.
    await app.close();
    await pool.end();
  });

  it('requires a chief, active batch and a valid step in its branch', async () => {
    expect((await app.inject({method:'GET',url:'/planning/batches/'+batchId+'/steps'})).statusCode).toBe(401);
    expect((await read(1)).statusCode).toBe(403);
    expect((await read(2)).statusCode).toBe(404);
    expect((await step(1,'started',randomUUID(),{},1)).statusCode).toBe(403);
    expect((await step(1,'started',randomUUID(),{},2)).statusCode).toBe(404);
    expect((await step(1,'started',randomUUID(),{},0,randomUUID())).statusCode).toBe(404);
    expect((await step(99,'started')).json()).toMatchObject({error:'step_not_in_batch_route'});
    expect((await step(1,'started')).json()).toMatchObject({error:'batch_not_active'});
    expect((await app.inject({method:'POST',url:'/planning/batches/'+batchId+'/status',
      headers:auth(0),payload:{expectedStatus:'created',status:'in_progress'}})).statusCode).toBe(200);
    expect((await step(2,'started')).json()).toMatchObject({
      error:'previous_step_not_complete_or_received',
    });
    expect((await step(1,'completed')).json()).toMatchObject({error:'step_not_open'});
    expect((await step(1,'deviation')).json()).toMatchObject({error:'invalid_step_evidence'});
  });

  it('appends first-step start, deviations and completion and prevents duplicate evidence', async () => {
    startId = randomUUID();
    finishId = randomUUID();
    expect((await step(1,'started',startId,{ equipmentCode:'LINE-A' })).statusCode).toBe(201);
    expect((await step(1,'started',startId,{ equipmentCode:'LINE-A' })).json())
      .toMatchObject({ id:startId,kind:'started',alreadyRecorded:true });
    expect((await step(1,'started',startId,{ equipmentCode:'LINE-B' })).json())
      .toMatchObject({ error:'step_evidence_id_reused' });
    expect((await step(1,'started')).json()).toMatchObject({error:'step_already_started'});
    expect((await step(1,'deviation',randomUUID(),{ note:'Operator observed unusual variation' })).statusCode).toBe(201);
    expect((await step(1,'completed',finishId)).statusCode).toBe(201);
    expect((await step(1,'completed',finishId)).json())
      .toMatchObject({ id:finishId,kind:'completed',alreadyRecorded:true });
    expect((await step(1,'completed')).json()).toMatchObject({error:'step_not_open'});
    expect((await step(1,'deviation',randomUUID(),{ note:'Too late' })).json())
      .toMatchObject({error:'step_not_open'});
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json().steps.map((s: {number:number;evidence:{kind:string}|null}) =>
      [s.number,s.evidence?.kind])).toEqual([
        [1,'started'],[1,'deviation'],[1,'completed'],[2,undefined],
      ]);
  });

  it('requires both documented completion and an independently receipted handoff to start next step', async () => {
    expect((await step(2,'started')).json()).toMatchObject({
      error:'previous_step_not_complete_or_received',
    });
    const handoffId = randomUUID();
    const sent = await app.inject({method:'POST',
      url:'/planning/batches/'+batchId+'/handoffs',headers:auth(0),
      payload:{handoffId,fromStep:1,toStep:2,quantity:'50',quantityUnit:'kg'}});
    expect(sent.statusCode).toBe(201);
    expect((await step(2,'started')).json()).toMatchObject({
      error:'previous_step_not_complete_or_received',
    });
    expect((await app.inject({method:'POST',
      url:'/planning/handoffs/'+handoffId+'/receive',headers:auth(0),
      payload:{}})).json()).toMatchObject({error:'same_actor_cannot_receive'});
    expect((await app.inject({method:'POST',
      url:'/planning/handoffs/'+handoffId+'/receive',headers:auth(1),
      payload:{note:'Identities checked'}})).statusCode).toBe(200);
    expect((await step(2,'started')).statusCode).toBe(201);
    expect((await step(2,'completed',randomUUID(),
      {quantity:'48.000000',quantityUnit:'kg'})).statusCode).toBe(201);
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json().steps.filter((s:{number:number})=>s.number===2)
      .map((s:{evidence:{kind:string}})=>s.evidence.kind)).toEqual(['started','completed']);
    expect(response.json().steps[0].name).toBe('Cathode coating');
    expect(response.json().steps.at(-1).name).toBe('Cathode cutting');
  });

  it('rejects direct rewrites and cross-workshop route evidence even with valid UUIDs', async () => {
    await expect(pool.query(`UPDATE production_step_evidence SET note='altered'
      WHERE organization_id=$1 AND id=$2`,[org,startId]))
      .rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_step_evidence
      WHERE organization_id=$1 AND id=$2`,[org,startId]))
      .rejects.toThrow('append-only');
    await expect(pool.query(`INSERT INTO production_step_evidence
      (organization_id,id,batch_id,order_id,route_id,route_version,
        step_number,workshop_id,kind,actor_id,note)
      VALUES($1,$2,$3,$4,$5,1,1,'cutting','deviation',$6,'Mismatched route workshop')`,
      [org,randomUUID(),batchId,orderId,routeId,chief]))
      .rejects.toMatchObject({code:'23503'});
    expect((await read()).json().steps.filter(
      (row:{evidence:{kind:string}|null})=>row.evidence?.kind==='started')).toHaveLength(2);
  });
});
