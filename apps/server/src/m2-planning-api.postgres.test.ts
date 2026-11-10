import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 planning routes and orders API (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), otherOrg = randomUUID();
  const chief = randomUUID(), technologist = randomUUID(), worker = randomUUID(), foreignChief = randomUUID();
  const identities = [chief, technologist, worker, foreignChief];
  const tokens = identities.map(() => randomBytes(32).toString('base64url'));
  const authorization = (index: number) => ({ authorization: 'Bearer ' + tokens[index] });
  const draft = {
    code: 'CELL-18650-' + randomUUID().slice(0,8),
    name: '18650 manufacturing pilot',
    steps: [
      { name: 'Cathode coating', stage: 'coating', workshopId: 'coating', electrodeLine: 'cathode' },
      { name: 'Anode coating', stage: 'coating', workshopId: 'coating', electrodeLine: 'anode' },
      { name: 'Cell assembly', stage: 'assembly', workshopId: 'assembly', electrodeLine: 'common' },
    ],
  };
  let routeId: string;

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('M2 API tests require the disposable CI database');
    }
    const database = await pool.query('SELECT current_database() AS name');
    expect(database.rows[0].name).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org, 'M2 API tenant', otherOrg, 'Other M2 API tenant']);
    for (const [index, id] of identities.entries()) {
      const organization = index === 3 ? otherOrg : org;
      const role = index === 0 || index === 3 ? 'chief' : index === 1 ? 'technologist' : 'worker';
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`, [id,organization,'m2-api-'+id,role]);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),organization,id,tokenHash(tokens[index])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name) VALUES
      ($1,'coating','Coating'),($1,'assembly','Assembly'),($2,'coating','Coating')`,
      [org,otherOrg]);
  });

  afterAll(async () => {
    // Approved versions deliberately survive this test in the throwaway DB;
    // production immutability must not have a privileged cleanup back door.
    await app.close();
    await pool.end();
  });

  it('creates an ordered, tenant-scoped draft route only for authorized planners', async () => {
    expect((await app.inject({ method:'POST', url:'/planning/routes', payload:draft })).statusCode).toBe(401);
    expect((await app.inject({
      method:'POST', url:'/planning/routes', headers:authorization(2), payload:draft,
    })).statusCode).toBe(403);

    const created = await app.inject({
      method:'POST', url:'/planning/routes', headers:authorization(1), payload:draft,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code:draft.code, version:1, state:'draft', steps:3 });
    routeId = created.json().id;
    const rows = await pool.query(`SELECT step_number,stage,electrode_line
      FROM process_route_steps WHERE organization_id=$1 AND route_id=$2
      ORDER BY step_number`,[org,routeId]);
    expect(rows.rows).toEqual([
      { step_number:1, stage:'coating', electrode_line:'cathode' },
      { step_number:2, stage:'coating', electrode_line:'anode' },
      { step_number:3, stage:'assembly', electrode_line:'common' },
    ]);
    expect((await app.inject({
      method:'GET',url:'/planning/routes',headers:authorization(0),
    })).json().routes).toEqual(expect.arrayContaining([expect.objectContaining({
      id:routeId,state:'draft',stepCount:3,
    })]));
    expect((await app.inject({
      method:'GET',url:'/planning/routes',headers:authorization(3),
    })).json().routes).toEqual([]);
  });

  it('rolls back draft creation when a workshop is not registered in the same organization', async () => {
    const invalid = { ...draft, code:'BROKEN-'+randomUUID().slice(0,8),
      steps:[...draft.steps.slice(0,1),{ ...draft.steps[1], workshopId:'not-registered' }] };
    const created = await app.inject({
      method:'POST',url:'/planning/routes',headers:authorization(1),payload:invalid,
    });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ error:'unknown_route_workshop' });
    const result = await pool.query('SELECT id FROM process_routes WHERE organization_id=$1 AND code=$2',
      [org,invalid.code]);
    expect(result.rows).toEqual([]);
    const duplicate = await app.inject({
      method:'POST',url:'/planning/routes',headers:authorization(0),payload:draft,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error:'route_code_exists' });
  });

  it('requires chief approval before orders may use a route and preserves approved steps', async () => {
    const order = {
      orderCode:'PO-'+randomUUID().slice(0,8),productCode:'18650-NMC',
      routeId,routeVersion:1,plannedQuantity:'1200',quantityUnit:'cells',
    };
    expect((await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(0),payload:order,
    })).json()).toMatchObject({ error:'route_not_approved' });
    expect((await app.inject({
      method:'POST',url:'/planning/routes/'+routeId+'/versions/1/approve',
      headers:authorization(1),
    })).statusCode).toBe(403);
    expect((await app.inject({
      method:'POST',url:'/planning/routes/'+routeId+'/versions/1/approve',
      headers:authorization(0),
    })).json()).toMatchObject({ id:routeId,version:1,state:'approved' });
    expect((await app.inject({
      method:'POST',url:'/planning/routes/'+routeId+'/versions/1/approve',
      headers:authorization(0),
    })).statusCode).toBe(409);

    const created = await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(0),payload:order,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      orderCode:order.orderCode,routeId,routeVersion:1,
      status:'draft',quantityUnit:'cells',
    });
    const duplicate = await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(0),payload:order,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error:'order_code_exists' });
    expect((await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(2),payload:order,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(3),
      payload:{ ...order, orderCode:'FOREIGN-'+randomUUID().slice(0,8) },
    })).json()).toMatchObject({ error:'route_not_approved' });

    const own = await app.inject({ method:'GET',url:'/planning/orders',headers:authorization(0) });
    expect(own.json().orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderCode:order.orderCode,routeId }),
    ]));
    expect((await app.inject({
      method:'GET',url:'/planning/orders',headers:authorization(3),
    })).json().orders).toEqual([]);
    expect((await app.inject({
      method:'GET',url:'/planning/orders',headers:authorization(2),
    })).statusCode).toBe(403);
    await expect(pool.query(`UPDATE process_route_steps SET stage='storage'
      WHERE organization_id=$1 AND route_id=$2 AND route_version=1 AND step_number=1`,
      [org,routeId])).rejects.toThrow('approved route steps are immutable');
  });

  it('rejects invalid amounts and unknown route versions without storing orders', async () => {
    for (const amount of ['0', '-1', '1.1234567', '1e6', '1000000000000']) {
      const response = await app.inject({
        method:'POST',url:'/planning/orders',headers:authorization(0),
        payload:{ orderCode:'INVALID-'+randomUUID().slice(0,8),
          productCode:'18650-NMC',routeId,routeVersion:1,
          plannedQuantity:amount,quantityUnit:'cells' },
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.inject({
      method:'POST',url:'/planning/orders',headers:authorization(0),
      payload:{ orderCode:'NO-ROUTE-'+randomUUID().slice(0,8),
        productCode:'18650-NMC',routeId,routeVersion:42,
        plannedQuantity:'5',quantityUnit:'cells' },
    })).json()).toMatchObject({ error:'route_not_approved' });
  });
});
