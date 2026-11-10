import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 batch genealogy audit (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), foreignOrg = randomUUID();
  const chief = randomUUID(), worker = randomUUID(), foreignChief = randomUUID();
  const actors = [chief,worker,foreignChief];
  const tokens = actors.map(() => randomBytes(32).toString('base64url'));
  const headers = (i: number) => ({authorization:'Bearer ' + tokens[i]});
  const code = (kind: string) => kind + '-' + randomUUID().slice(0,8);
  let orderId = '', secondOrderId = '';
  let cathodeId = '', anodeId = '', cellId = '', secondCellId = '', otherOrderId = '';
  const link = (targetId: string, sourceBatchId: string, kind = 'assembly', index = 0) =>
    app.inject({method:'POST',url:'/planning/batches/'+targetId+'/links',
      headers:headers(index),payload:{
        sourceBatchId,kind,sourceQuantity:'12.500000',sourceUnit:'kg',
        targetQuantity:'100',targetUnit:'cells',note:'Pilot provenance declaration',
      }});
  const getLinks = (id: string, index = 0) => app.inject({
    method:'GET',url:'/planning/batches/'+id+'/links',headers:headers(index),
  });
  const createBatch = async (order: string, line: 'cathode'|'anode'|'cell') => {
    const r = await app.inject({method:'POST',url:'/planning/orders/'+order+'/batches',
      headers:headers(0),payload:{
        batchCode:code('LOT'),materialLine:line,plannedQuantity:'150',quantityUnit:'kg',
      }});
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const complete = async (id: string) => {
    for (const [expectedStatus,status] of [
      ['created','in_progress'],['in_progress','completed'],
    ] as const) {
      const r = await app.inject({
        method:'POST',url:'/planning/batches/'+id+'/status',
        headers:headers(0),payload:{expectedStatus,status},
      });
      expect(r.statusCode).toBe(200);
    }
  };

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('Refusing a non-disposable database for batch genealogy tests');
    }
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Genealogy test tenant',foreignOrg,'Other genealogy tenant']);
    for (const [i,id] of actors.entries()) {
      const tenant = i === 2 ? foreignOrg : org;
      const role = i === 1 ? 'worker' : 'chief';
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`, [id,tenant,'genealogy-'+id,role]);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,id,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating')`, [org]);
    const route = await app.inject({
      method:'POST',url:'/planning/routes',headers:headers(0),
      payload:{code:code('ROUTE'),name:'Traceable coating route',
        steps:[{name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'}]},
    });
    expect(route.statusCode).toBe(201);
    const routeId = route.json().id as string;
    expect((await app.inject({method:'POST',
      url:'/planning/routes/'+routeId+'/versions/1/approve',headers:headers(0)})).statusCode).toBe(200);
    for (let i=0;i<2;i++) {
      const order = await app.inject({method:'POST',url:'/planning/orders',headers:headers(0),
        payload:{orderCode:code('ORDER'),productCode:'18650-NMC',routeId,routeVersion:1,
          plannedQuantity:'1000',quantityUnit:'cells'}});
      expect(order.statusCode).toBe(201);
      const id = order.json().id as string;
      expect((await app.inject({method:'POST',url:'/planning/orders/'+id+'/release',
        headers:headers(0)})).statusCode).toBe(200);
      if (i === 0) orderId=id; else secondOrderId=id;
    }
    cathodeId = await createBatch(orderId,'cathode');
    anodeId = await createBatch(orderId,'anode');
    cellId = await createBatch(orderId,'cell');
    secondCellId = await createBatch(orderId,'cell');
    otherOrderId = await createBatch(secondOrderId,'cathode');
    await complete(cathodeId);
    await complete(anodeId);
    await complete(otherOrderId);
  });

  afterAll(async () => {
    // This database is destroyed after CI. Historical links are immutable.
    await app.close();await pool.end();
  });

  it('rejects unauthorized, self, unknown, and cross-order declarations', async () => {
    expect((await app.inject({method:'GET',
      url:'/planning/batches/'+cellId+'/links'})).statusCode).toBe(401);
    expect((await getLinks(cellId,1)).statusCode).toBe(403);
    expect((await getLinks(cellId,2)).statusCode).toBe(404);
    expect((await link(cellId,cathodeId,'assembly',1)).statusCode).toBe(403);
    expect((await link(cellId,cathodeId,'assembly',2)).statusCode).toBe(404);
    expect((await link(cellId,cellId,'assembly')).json())
      .toMatchObject({error:'self_link_forbidden'});
    expect((await link(cellId,randomUUID(),'assembly')).statusCode).toBe(404);
    expect((await link(cellId,otherOrderId,'assembly')).json())
      .toMatchObject({error:'batch_order_mismatch'});
    const wrongKind = await link(secondCellId,cellId,'split');
    expect(wrongKind.statusCode).toBe(409);
    const before = await getLinks(cellId);
    expect(before.json().links).toEqual([]);
  });

  it('links completed cathode and anode inputs to a cell batch without altering status or stock', async () => {
    for (const input of [cathodeId,anodeId]) {
      const response = await link(cellId,input);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({sourceBatchId:input,targetBatchId:cellId,kind:'assembly'});
    }
    const input = await getLinks(cellId);
    expect(input.statusCode).toBe(200);
    expect(input.json().links).toHaveLength(2);
    expect(input.json().links.map((entry:{sourceBatchId:string}) => entry.sourceBatchId).sort())
      .toEqual([cathodeId,anodeId].sort());
    const sourceHistory = await getLinks(cathodeId);
    expect(sourceHistory.json().links).toHaveLength(1);
    expect(sourceHistory.json().links[0]).toMatchObject({
      sourceBatchId:cathodeId,targetBatchId:cellId,
      sourceQuantity:'12.500000',targetQuantity:'100.000000',
      sourceUnit:'kg',targetUnit:'cells',note:'Pilot provenance declaration',
    });
    const rows = await pool.query(`SELECT status FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[org,cellId]);
    expect(rows.rows[0].status).toBe('created');
    expect((await pool.query(`SELECT count(*)::int AS count FROM production_batch_links
      WHERE organization_id=$1 AND order_id=$2`,[org,orderId])).rows[0].count).toBe(2);
  });

  it('treats identical genealogy request IDs as safe retries but rejects changed payloads', async () => {
    const source = await createBatch(orderId, 'cathode');
    const target = await createBatch(orderId, 'cell');
    await complete(source);
    const declarationId = randomUUID();
    const payload = {
      declarationId, sourceBatchId: source, kind: 'assembly',
      sourceQuantity: '5.000000', sourceUnit: 'kg',
      targetQuantity: '100', targetUnit: 'cells',
      note: 'Receipt cross-check',
    };
    const submit = (body: object) => app.inject({
      method: 'POST', url: '/planning/batches/' + target + '/links',
      headers: headers(0), payload: body,
    });
    const first = await submit(payload);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: declarationId, sourceBatchId: source });
    const retried = await submit(payload);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ id: declarationId, alreadyRecorded: true });
    expect((await submit({ ...payload, targetQuantity: '101' })).json())
      .toMatchObject({ error: 'declaration_id_reused' });
    expect((await submit({ ...payload, sourceBatchId: cathodeId })).json())
      .toMatchObject({ error: 'declaration_id_reused' });
    const list = (await getLinks(target)).json().links;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: declarationId,
      sourceQuantity: '5.000000', targetQuantity: '100.000000' });
    const stored = await pool.query(`SELECT count(*)::int AS count FROM production_batch_links
      WHERE organization_id=$1 AND id=$2`, [org,declarationId]);
    expect(stored.rows[0].count).toBe(1);
  });

  it('enforces positive quantities, allowed states, and immutable provenance in PostgreSQL', async () => {
    const invalid = await app.inject({method:'POST',url:'/planning/batches/'+secondCellId+'/links',
      headers:headers(0),payload:{sourceBatchId:cathodeId,kind:'assembly',
        sourceQuantity:'0',sourceUnit:'kg',targetQuantity:'100',targetUnit:'cells'}});
    expect(invalid.statusCode).toBe(400);
    const held = await app.inject({method:'POST',url:'/planning/batches/'+secondCellId+'/status',
      headers:headers(0),payload:{expectedStatus:'created',status:'hold',reason:'Quality hold'}});
    expect(held.statusCode).toBe(200);
    expect((await link(secondCellId,cathodeId)).json())
      .toMatchObject({error:'batch_link_not_permitted_by_status'});
    const existing = (await getLinks(cellId)).json().links[0] as {id:string};
    await expect(pool.query(`UPDATE production_batch_links SET note='changed'
      WHERE organization_id=$1 AND id=$2`,[org,existing.id]))
      .rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_batch_links
      WHERE organization_id=$1 AND id=$2`,[org,existing.id]))
      .rejects.toThrow('append-only');

    // Even a direct SQL caller cannot forge a cross-order link with valid UUIDs.
    await expect(pool.query(`INSERT INTO production_batch_links
      (organization_id,id,order_id,source_batch_id,target_batch_id,
        link_kind,source_quantity,source_unit,target_quantity,target_unit,actor_id)
      VALUES($1,$2,$3,$4,$5,'assembly',1,'kg',1,'cells',$6)`,
      [org,randomUUID(),orderId,otherOrderId,cellId,chief]))
      .rejects.toMatchObject({code:'23503'});
  });

  it('rejects cyclic genealogy even if previous batch statuses were altered out of band', async () => {
    // This fixture simulates a legacy bad write outside the API. Graph cycles
    // must still be rejected, independent of the normal lifecycle safeguards.
    await pool.query(`UPDATE production_batches SET status='created'
      WHERE organization_id=$1 AND id=$2`,[org,cathodeId]);
    // Add C -> A only after C is completed, with A artificially made writable.
    await complete(cellId);
    const cycle = await app.inject({method:'POST',
      url:'/planning/batches/'+cathodeId+'/links',headers:headers(0),
      payload:{sourceBatchId:cellId,kind:'consumption',
        sourceQuantity:'2',sourceUnit:'cells',targetQuantity:'1',targetUnit:'kg'}});
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toMatchObject({error:'batch_genealogy_cycle'});
    expect((await getLinks(cathodeId)).json().links).toHaveLength(1);
  });
});
