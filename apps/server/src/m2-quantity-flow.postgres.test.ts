import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

/** Read-only comparison of declared production quantities, not yield accounting. */
integration('M2 batch quantity flow audit (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), foreignOrg = randomUUID();
  const chief = randomUUID(), master = randomUUID(), foreignChief = randomUUID();
  const people = [chief,master,foreignChief];
  const tokens = people.map(() => randomBytes(32).toString('base64url'));
  const headers = (i: number) => ({authorization:'Bearer '+tokens[i]});
  const code = (label: string) => label+'-'+randomUUID().slice(0,8);
  let batchId = '';
  const read = (batch = batchId, actor = 0) => app.inject({
    method:'GET',url:'/planning/batches/'+batch+'/quantity-flow',headers:headers(actor),
  });
  const workshopFlow = (actor = 1, batch = batchId) => app.inject({
    method:'GET',url:'/planning/workshop-batches/'+batch+'/quantity-comparison',
    headers:headers(actor),
  });
  const post = (url: string, payload: object, actor = 0) => app.inject({
    method:'POST',url,headers:headers(actor),payload,
  });
  const evidence = (step: number, kind: 'started'|'completed', quantity?: string) =>
    post('/planning/batches/'+batchId+'/steps/'+step+'/evidence',
      kind === 'started' ? {eventId:randomUUID(),kind} :
      {eventId:randomUUID(),kind,quantity,quantityUnit:'kg'});

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci')
      throw new Error('Quantity flow tests require isolated CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Flow tenant',foreignOrg,'Flow outsider']);
    for (const [i,user] of people.entries()) {
      const organization = i === 2 ? foreignOrg : org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,organization,'flow-'+user,i === 1 ? 'master' : 'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),organization,user,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating'),($1,'cutting','Cutting')`,[org]);
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'cutting')`,[org,master]);
    const route = await post('/planning/routes', {
      code:code('ROUTE'),name:'Quantity flow cathode',steps:[
        {name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cutting',stage:'cutting',workshopId:'cutting',electrodeLine:'cathode'},
      ],
    });
    expect(route.statusCode).toBe(201);
    const routeId = route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{})).statusCode).toBe(200);
    const order = await post('/planning/orders',{
      orderCode:code('ORDER'),productCode:'NMC',
      routeId,routeVersion:1,plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    expect((await post('/planning/orders/'+order.json().id+'/release',{})).statusCode).toBe(200);
    const batch = await post('/planning/orders/'+order.json().id+'/batches',{
      batchCode:code('BATCH'),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(batch.statusCode).toBe(201);
    batchId = batch.json().id;
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  it('protects organization records and never exposes quantities to a master', async () => {
    expect((await app.inject({method:'GET',url:'/planning/batches/'+batchId+'/quantity-flow'}))
      .statusCode).toBe(401);
    expect((await read(batchId,1)).statusCode).toBe(403);
    expect((await read(batchId,2)).statusCode).toBe(404);
    expect((await read(randomUUID())).statusCode).toBe(404);
    expect((await read('not-a-uuid')).statusCode).toBe(400);
  });

  it('reports missing output and handover without guessing inventory loss', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({batchId,steps:[
      {number:1,name:'Coating',workshopId:'coating',nextStep:2,
        output:null,handoff:null,difference:null,
        sourceComparison:{status:'no_source',sourceCount:0,withdrawnSourceCount:0,source:null,difference:null}},
      {number:2,name:'Cutting',workshopId:'cutting',nextStep:null,
        output:null,handoff:null,difference:null,
        sourceComparison:{status:'no_source',sourceCount:0,withdrawnSourceCount:0,source:null,difference:null}},
    ]});
  });

  it('compares exact decimal quantities and distinguishes sent and received', async () => {
    expect((await post('/planning/batches/'+batchId+'/status',
      {expectedStatus:'created',status:'in_progress'})).statusCode).toBe(200);
    expect((await evidence(1,'started')).statusCode).toBe(201);
    expect((await evidence(1,'completed','70.250001')).statusCode).toBe(201);
    const initial = (await read()).json().steps;
    expect(initial[0]).toMatchObject({
      output:{quantity:'70.250001',unit:'kg'},handoff:null,difference:null,
    });
    const handoffId = randomUUID();
    expect((await post('/planning/batches/'+batchId+'/handoffs',{
      handoffId,fromStep:1,toStep:2,quantity:'65.125999',quantityUnit:'kg',
    })).statusCode).toBe(201);
    const pendingInput=(await workshopFlow()).json().steps;
    expect(pendingInput).toEqual([expect.objectContaining({
      number:2,output:null,input:{
        id:handoffId,quantity:'65.125999',unit:'kg',received:false,
      },inputDifference:null,
    })]);
    const sent = (await read()).json().steps;
    expect(sent[0]).toMatchObject({
      output:{quantity:'70.250001',unit:'kg'},
      handoff:{id:handoffId,quantity:'65.125999',unit:'kg',received:false},
      difference:'5.124002',
    });
    expect((await post('/planning/handoffs/'+handoffId+'/receive',{},1)).statusCode).toBe(200);
    expect((await evidence(2,'started')).statusCode).toBe(201);
    expect((await evidence(2,'completed','60.000000')).statusCode).toBe(201);
    const received = (await read()).json().steps;
    expect(received[0].handoff.received).toBe(true);
    expect(received[1]).toMatchObject({
      output:{quantity:'60.000000',unit:'kg'},
      handoff:null,difference:null,nextStep:null,
    });
    const rows = await pool.query(`SELECT count(*)::int AS n FROM production_stage_handoffs
      WHERE organization_id=$1 AND batch_id=$2`,[org,batchId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('compares only current workshop declarations without exposing source journals', async () => {
    expect((await app.inject({method:'GET',
      url:'/planning/workshop-batches/'+batchId+'/quantity-comparison'})).statusCode).toBe(401);
    expect((await workshopFlow(0)).statusCode).toBe(403);
    expect((await workshopFlow(2)).statusCode).toBe(403);
    expect((await workshopFlow(1,randomUUID())).statusCode).toBe(404);
    expect((await workshopFlow(1,'not-a-uuid')).statusCode).toBe(400);
    const scoped=await workshopFlow();
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toEqual({batchId,hasMore:false,steps:[
      {number:2,name:'Cutting',workshopId:'cutting',nextStep:null,
        output:{quantity:'60.000000',unit:'kg'},handoff:null,difference:null,
        input:{id:expect.any(String),quantity:'65.125999',unit:'kg',received:true},
        inputDifference:'5.125999'},
    ]});
    await pool.query(`INSERT INTO user_workshop_memberships
      (organization_id,user_id,workshop_id) VALUES($1,$2,'coating')`,[org,master]);
    const shared=await workshopFlow();
    expect(shared.statusCode).toBe(200);
    expect(shared.json().steps).toEqual([
      {number:1,name:'Coating',workshopId:'coating',nextStep:2,
        output:{quantity:'70.250001',unit:'kg'},
        handoff:{id:expect.any(String),quantity:'65.125999',unit:'kg',received:true},
        difference:'5.124002',input:null,inputDifference:null},
      {number:2,name:'Cutting',workshopId:'cutting',nextStep:null,
        output:{quantity:'60.000000',unit:'kg'},handoff:null,difference:null,
        input:{id:expect.any(String),quantity:'65.125999',unit:'kg',received:true},
        inputDifference:'5.125999'},
    ]);
    expect(shared.json().steps.every((row:object)=>
      !('sourceComparison' in row) && !('sourceEntryId' in row))).toBe(true);
    await pool.query(`DELETE FROM user_workshop_memberships
      WHERE organization_id=$1 AND user_id=$2 AND workshop_id='coating'`,[org,master]);
    expect((await workshopFlow()).json().steps.map((row:{number:number})=>row.number))
      .toEqual([2]);
    await pool.query(`DELETE FROM user_workshop_memberships
      WHERE organization_id=$1 AND user_id=$2 AND workshop_id='cutting'`,[org,master]);
    expect((await workshopFlow()).statusCode).toBe(404);
    await pool.query(`INSERT INTO user_workshop_memberships
      (organization_id,user_id,workshop_id) VALUES($1,$2,'cutting')`,[org,master]);
    expect((await workshopFlow()).statusCode).toBe(200);
    expect((await read()).json().steps).toHaveLength(2);
  });

});
