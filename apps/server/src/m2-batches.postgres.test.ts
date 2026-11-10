import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 order release and auditable batch lifecycle (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), foreignOrg = randomUUID();
  const chief = randomUUID(), worker = randomUUID(), outsider = randomUUID();
  const tokens = [chief,worker,outsider].map(() => randomBytes(32).toString('base64url'));
  const auth = (index: number) => ({ authorization: 'Bearer ' + tokens[index] });
  let routeId = '', orderId = '', batchId = '';
  const orderCode = 'BATCH-PILOT-' + randomUUID().slice(0,8);
  const batchCode = 'CATH-' + randomUUID().slice(0,8);

  const insertBatch = (code: string, line: 'cathode'|'anode'|'cell' = 'cathode', index = 0) =>
    app.inject({ method: 'POST', url: '/planning/orders/' + orderId + '/batches',
      headers: auth(index), payload: {
        batchCode: code, materialLine: line, plannedQuantity: '12.500000', quantityUnit: 'kg',
      } });
  const status = (id: string, expectedStatus: string, nextStatus: string, reason?: string, index = 0) =>
    app.inject({ method: 'POST', url: '/planning/batches/' + id + '/status',
      headers: auth(index), payload: {
        expectedStatus, status: nextStatus, ...(reason ? { reason } : {}),
      } });
  const events = (id: string, index = 0) =>
    app.inject({ method: 'GET', url: '/planning/batches/' + id + '/events',
      headers: auth(index) });

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('M2 batch tests require an isolated disposable CI database');
    }
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Batch pilot tenant',foreignOrg,'Foreign batch tenant']);
    for (const [i,userId] of [chief,worker,outsider].entries()) {
      const tenant = i === 2 ? foreignOrg : org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [userId,tenant,'batch-test-'+userId,i === 1 ? 'worker' : 'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,userId,tokenHash(tokens[i])]);
    }
    await pool.query("INSERT INTO workshops(organization_id,id,name) VALUES($1,'coating','Coating')", [org]);
    const route = await app.inject({ method:'POST', url:'/planning/routes', headers: auth(0),
      payload: { code:'BATCH-ROUTE-'+randomUUID().slice(0,8),
        name:'Cathode route for pilot', steps:[{
          name:'Coat cathode',stage:'coating',workshopId:'coating',electrodeLine:'cathode',
        }] } });
    expect(route.statusCode).toBe(201);
    routeId = route.json().id;
    const approval = await app.inject({ method:'POST',
      url:'/planning/routes/'+routeId+'/versions/1/approve',headers:auth(0) });
    expect(approval.statusCode).toBe(200);
    const order = await app.inject({ method:'POST', url:'/planning/orders',headers:auth(0),
      payload: { orderCode,productCode:'NMC-CATHODE',routeId,routeVersion:1,
        plannedQuantity:'150.0',quantityUnit:'kg' } });
    expect(order.statusCode).toBe(201);
    orderId = order.json().id;
  });

  afterAll(async () => {
    // The CI PostgreSQL service is disposable; preserve immutable histories
    // instead of deleting them through a privileged test-only escape hatch.
    await app.close();
    await pool.end();
  });

  it('requires chief release before accepting batches and rejects cross-tenant access', async () => {
    expect((await insertBatch('EARLY-'+randomUUID().slice(0,8))).json())
      .toMatchObject({ error:'order_not_released' });
    expect((await app.inject({ method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(1) })).statusCode).toBe(403);
    expect((await app.inject({ method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(2) })).json()).toMatchObject({ error:'order_not_releasable' });
    const released = await app.inject({ method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(0) });
    expect(released.json()).toMatchObject({ id:orderId, status:'released' });
    expect((await app.inject({ method:'POST',url:'/planning/orders/'+orderId+'/release',
      headers:auth(0) })).statusCode).toBe(409);

    const response = await insertBatch(batchCode);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ orderId, batchCode, materialLine:'cathode',
      status:'created', plannedQuantity:'12.500000', quantityUnit:'kg' });
    batchId = response.json().id;
    expect((await insertBatch(batchCode)).json()).toMatchObject({ error:'batch_code_exists' });
    expect((await insertBatch('NOT-ALLOWED-'+randomUUID().slice(0,8),'cathode',1))
      .statusCode).toBe(403);
    expect((await app.inject({ method:'GET', url:'/planning/orders/'+orderId+'/batches',
      headers:auth(2) })).statusCode).toBe(404);
    expect((await app.inject({ method:'GET', url:'/planning/orders/'+orderId+'/batches',
      headers:auth(1) })).statusCode).toBe(403);
    expect((await events(batchId,2)).statusCode).toBe(404);
    expect((await events(batchId,1)).statusCode).toBe(403);
    const list = await app.inject({ method:'GET',
      url:'/planning/orders/'+orderId+'/batches',headers:auth(0) });
    expect(list.json().batches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id:batchId, batchCode, status:'created' }),
    ]));
    const history = (await events(batchId)).json().events;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      number:1, fromStatus:null, toStatus:'created', actorId:chief,
    });
  });

  it('records every permitted status transition atomically and preserves hold reasons', async () => {
    expect((await status(batchId,'created','completed')).json())
      .toMatchObject({ error:'invalid_batch_status_transition' });
    expect((await status(batchId,'created','hold')).json())
      .toMatchObject({ error:'reason_required' });
    expect((await status(batchId,'created','in_progress')).json())
      .toMatchObject({ previousStatus:'created',status:'in_progress',eventNumber:2 });
    expect((await status(batchId,'created','hold','late conflict')).json())
      .toMatchObject({ error:'batch_status_changed',actualStatus:'in_progress' });
    expect((await status(batchId,'in_progress','hold','Coating parameter deviation')).json())
      .toMatchObject({ status:'hold', eventNumber:3 });
    expect((await status(batchId,'hold','in_progress','Corrected process conditions')).json())
      .toMatchObject({ status:'in_progress',eventNumber:4 });
    expect((await status(batchId,'in_progress','completed')).json())
      .toMatchObject({ status:'completed',eventNumber:5 });
    expect((await status(batchId,'completed','in_progress')).json())
      .toMatchObject({ error:'invalid_batch_status_transition' });

    const history = (await events(batchId)).json();
    expect(history.status).toBe('completed');
    expect(history.events.map((event: { number: number;toStatus:string }) =>
      [event.number,event.toStatus])).toEqual([
        [1,'created'],[2,'in_progress'],[3,'hold'],[4,'in_progress'],[5,'completed'],
      ]);
    expect(history.events[2].reason).toBe('Coating parameter deviation');
    await expect(pool.query(`UPDATE production_batch_events SET reason='tampered'
      WHERE organization_id=$1 AND batch_id=$2 AND event_number=3`,
      [org,batchId])).rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_batch_events
      WHERE organization_id=$1 AND batch_id=$2 AND event_number=3`,
      [org,batchId])).rejects.toThrow('append-only');
    expect((await events(batchId)).json().events).toHaveLength(5);
  });

  it('handles scrapping as terminal and blocks invalid quantities or unauthorized updates', async () => {
    const scrap = await insertBatch('SCRAP-'+randomUUID().slice(0,8),'anode');
    expect(scrap.statusCode).toBe(201);
    const id: string = scrap.json().id;
    expect((await status(id,'created','scrapped')).json())
      .toMatchObject({ error:'reason_required' });
    expect((await status(id,'created','scrapped','Irrecoverable roll defect')).json())
      .toMatchObject({ status:'scrapped',eventNumber:2 });
    expect((await status(id,'scrapped','in_progress')).statusCode).toBe(409);
    expect((await status(id,'scrapped','hold','forbidden',1)).statusCode).toBe(403);
    expect((await status(id,'scrapped','hold','forbidden',2)).statusCode).toBe(404);
    for (const amount of ['0','-5','1e4','1.1234567']) {
      const r = await app.inject({ method:'POST',
        url:'/planning/orders/'+orderId+'/batches', headers:auth(0),
        payload: { batchCode:'INVALID-'+randomUUID().slice(0,8),
          materialLine:'cell',plannedQuantity:amount,quantityUnit:'cells' } });
      expect(r.statusCode).toBe(400);
    }
    expect((await events(id)).json().events.map(
      (event:{toStatus:string})=>event.toStatus)).toEqual(['created','scrapped']);
  });
});
