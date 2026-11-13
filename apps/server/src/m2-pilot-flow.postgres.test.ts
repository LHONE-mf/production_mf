import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

/**
 * Integrated M2 planning pilot, not a shop-floor validation. The test uses
 * isolated PostgreSQL, real Fastify endpoints and distinct authenticated
 * sender/receiver identities. It never runs against a production database.
 */
integration('M2 cross-module production order pilot (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), chief = randomUUID(), cuttingMaster = randomUUID();
  const credentials = [randomBytes(32).toString('base64url'),
    randomBytes(32).toString('base64url')];
  const headers = (index: number) => ({ authorization: 'Bearer ' + credentials[index] });
  const prefix = randomUUID().slice(0,8);
  const post = (url: string, payload?: object, actor = 0) => app.inject({
    method: 'POST', url, headers: headers(actor), ...(payload ? { payload } : {}),
  });
  const get = (url: string, actor = 0) => app.inject({ method: 'GET', url, headers: headers(actor) });

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('Integrated M2 pilot may only use isolated CI PostgreSQL');
    }
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [org, 'M2 integrated pilot']);
    for (const [index, userId] of [chief,cuttingMaster].entries()) {
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [userId,org,'pilot-'+userId,index === 0 ? 'chief' : 'master']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),org,userId,tokenHash(credentials[index])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name) VALUES
      ($1,'coating','Coating'),($1,'cutting','Cutting'),
      ($1,'assembly','Cell assembly')`,[org]);
    await pool.query(`INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id)
      VALUES($1,$2,'cutting')`,[org,cuttingMaster]);
  });

  afterAll(async () => {
    // Approved routes, events, receipts and genealogy are append-only.
    // The disposable GitHub Actions PostgreSQL container is deleted afterward.
    await app.close();
    await pool.end();
  });

  it('creates traceable electrode and cell batches under one approved route', async () => {
    const route = await post('/planning/routes', {
      code:'INTEGRATED-'+prefix,name:'Pilot electrode to cell route',
      steps:[
        {name:'Cathode coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cathode cutting',stage:'cutting',workshopId:'cutting',electrodeLine:'cathode'},
        {name:'Anode coating',stage:'coating',workshopId:'coating',electrodeLine:'anode'},
        {name:'Cell assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
      ],
    });
    expect(route.statusCode).toBe(201);
    const routeId: string = route.json().id;
    const approved = await post('/planning/routes/'+routeId+'/versions/1/approve');
    expect(approved.json()).toMatchObject({ id:routeId,version:1,state:'approved' });

    const order = await post('/planning/orders', {
      orderCode:'PO-'+prefix,productCode:'18650-NMC',
      routeId,routeVersion:1,plannedQuantity:'100',quantityUnit:'cells',
    });
    expect(order.statusCode).toBe(201);
    const orderId: string = order.json().id;
    expect((await post('/planning/orders/'+orderId+'/release')).json())
      .toMatchObject({ id:orderId,status:'released' });

    const createBatch = async (materialLine: 'cathode'|'anode'|'cell',
      plannedQuantity: string, quantityUnit: 'kg'|'cells') => {
      const response = await post('/planning/orders/'+orderId+'/batches', {
        batchCode:materialLine+'-'+prefix,materialLine,plannedQuantity,quantityUnit,
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    const cathodeId = await createBatch('cathode','24.500000','kg');
    const anodeId = await createBatch('anode','18.750000','kg');
    const cellId = await createBatch('cell','100','cells');
    const change = (id: string, expectedStatus: string, status: string) =>
      post('/planning/batches/'+id+'/status',{expectedStatus,status});
    const evidence = (id: string, step: number, kind: 'started'|'completed',
      quantity?: string, quantityUnit?: 'kg'|'cells') =>
      post('/planning/batches/'+id+'/steps/'+step+'/evidence',
        kind === 'started' ? {eventId:randomUUID(),kind} :
          {eventId:randomUUID(),kind,quantity,quantityUnit});

    // The cutting department must independently accept its cathode input.
    expect((await change(cathodeId,'created','in_progress')).statusCode).toBe(200);
    expect((await evidence(cathodeId,1,'started')).statusCode).toBe(201);
    expect((await evidence(cathodeId,1,'completed','24.500000','kg')).statusCode).toBe(201);
    const transferId = randomUUID();
    const transfer = await post('/planning/batches/'+cathodeId+'/handoffs', {
      handoffId:transferId,fromStep:1,toStep:2,
      quantity:'24.500000',quantityUnit:'kg',note:'Coating roll handover',
    });
    expect(transfer.statusCode).toBe(201);
    expect((await change(cathodeId,'in_progress','completed')).json())
      .toMatchObject({ error:'handoff_receipt_pending' });
    const inbox = (await get('/planning/handoffs/inbox',1)).json().handoffs;
    expect(inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({id:transferId,batchId:cathodeId,toWorkshopId:'cutting'}),
    ]));
    expect((await post('/planning/handoffs/'+transferId+'/receive',
      {note:'Batch label and mass confirmed'},1)).json())
      .toMatchObject({ id:transferId,status:'received' });
    expect((await change(cathodeId,'in_progress','completed')).json())
      .toMatchObject({error:'batch_route_step_incomplete'});
    expect((await evidence(cathodeId,2,'started')).statusCode).toBe(201);
    expect((await evidence(cathodeId,2,'completed','24.000000','kg')).statusCode).toBe(201);
    expect((await change(cathodeId,'in_progress','completed')).statusCode).toBe(200);

    // A one-step anode line has no interstage handover, but its completed
    // identity is still available as a provenance input for assembly.
    expect((await change(anodeId,'created','in_progress')).statusCode).toBe(200);
    expect((await evidence(anodeId,3,'started')).statusCode).toBe(201);
    expect((await evidence(anodeId,3,'completed','18.750000','kg')).statusCode).toBe(201);
    expect((await change(anodeId,'in_progress','completed')).statusCode).toBe(200);

    for (const [sourceId,qty] of [[cathodeId,'24.500000'],[anodeId,'18.750000']] as const) {
      const declarationId = randomUUID();
      const input = {
        declarationId,sourceBatchId:sourceId,kind:'assembly',
        sourceQuantity:qty,sourceUnit:'kg',targetQuantity:'100',
        targetUnit:'cells',note:'Pilot lot identity, not stock posting',
      };
      const link = await post('/planning/batches/'+cellId+'/links',input);
      expect(link.statusCode).toBe(201);
      expect(link.json()).toMatchObject({ id:declarationId,targetBatchId:cellId });
      expect((await post('/planning/batches/'+cellId+'/links',input)).json())
        .toMatchObject({ id:declarationId,alreadyRecorded:true });
    }
    expect((await change(cellId,'created','in_progress')).statusCode).toBe(200);
    expect((await evidence(cellId,4,'started')).statusCode).toBe(201);
    expect((await evidence(cellId,4,'completed','100','cells')).statusCode).toBe(201);
    expect((await change(cellId,'in_progress','completed')).statusCode).toBe(200);

    const lineage = (await get('/planning/batches/'+cellId+'/links')).json().links;
    expect(lineage).toHaveLength(2);
    expect(lineage.map((entry:{sourceBatchId:string})=>entry.sourceBatchId).sort())
      .toEqual([cathodeId,anodeId].sort());
    const handovers = (await get('/planning/batches/'+cathodeId+'/handoffs')).json().handoffs;
    expect(handovers).toHaveLength(1);
    expect(handovers[0]).toMatchObject({id:transferId,sentBy:chief,receivedBy:cuttingMaster});
    for (const id of [cathodeId,anodeId,cellId]) {
      const events = (await get('/planning/batches/'+id+'/events')).json();
      expect(events.status).toBe('completed');
      expect(events.events.map((e:{toStatus:string})=>e.toStatus))
        .toEqual(['created','in_progress','completed']);
    }
    const row = await pool.query(`SELECT count(*)::int AS count FROM production_batch_links
      WHERE organization_id=$1 AND order_id=$2`,[org,orderId]);
    expect(row.rows[0].count).toBe(2);
  });
});
