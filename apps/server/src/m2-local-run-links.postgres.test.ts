import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 typed local manufacturing run links (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), otherOrg = randomUUID();
  const chief = randomUUID(), master = randomUUID(), foreignChief = randomUUID();
  const people = [chief, master, foreignChief];
  const credentials = people.map(() => randomBytes(32).toString('base64url'));
  const headers = (i = 0) => ({ authorization: 'Bearer ' + credentials[i] });
  const post = (url:string, payload:object, i = 0) => app.inject({
    method:'POST', url, headers:headers(i), payload,
  });
  const get = (url:string, i = 0) => app.inject({ method:'GET', url, headers:headers(i) });
  const path = (step:number) =>
    '/planning/batches/' + batchId + '/steps/' + step + '/journal-links';
  let batchId = '';
  const mixId = randomUUID(), coatId = randomUUID(), mixLink = randomUUID();
  const at = '2026-11-10T14:30:00.000Z';
  const mix = {
    linkId:mixLink, sourceKind:'mix_batch',sourceEntryId:mixId,
    sourceStage:'slurry',sourceCreatedAt:at,summary:'LFP dry solids batch',
    sourceMeasure:{kind:'dry_solids_kg',value:'11.123456'},
  };
  const coat = {
    linkId:randomUUID(),sourceKind:'coat_run',sourceEntryId:coatId,
    sourceStage:'coating',sourceCreatedAt:at,summary:'Al coating run',
    defects:'Pinholes',sourceMeasure:{kind:'coated_side_a_m',value:'210.000000'},
  };
  const calender = {
    linkId:randomUUID(),sourceKind:'calender_run',sourceEntryId:randomUUID(),
    sourceStage:'calendaring',sourceCreatedAt:at,summary:'Calendered roll',
    sourceMeasure:{kind:'calendered_length_m',value:'189.500000'},
  };
  const cutting = {
    linkId:randomUUID(),sourceKind:'cut_run',sourceEntryId:randomUUID(),
    sourceStage:'cutting',sourceCreatedAt:at,summary:'Cut electrode output',
    sourceMeasure:{kind:'cut_good_pieces',value:'154'},
  };

  beforeAll(async () => {
    const url = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/production_mf_ci')
      throw new Error('Typed run link test must use disposable CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Typed local sources',otherOrg,'Foreign typed sources']);
    for (const [i,user] of people.entries()) {
      const tenant = i === 2 ? otherOrg : org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,tenant,'typed-'+user,i===1?'master':'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(credentials[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'slurry','Slurry'),($1,'coating','Coating'),
      ($1,'calendaring','Calendering'),($1,'cutting','Cutting')`,[org]);
    const route=await post('/planning/routes',{
      code:'TYPED-'+randomUUID().slice(0,8),name:'Cathode slurry and coating',
      steps:[
        {name:'Slurry',stage:'slurry',workshopId:'slurry',electrodeLine:'cathode'},
        {name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Calendering',stage:'calendaring',workshopId:'calendaring',electrodeLine:'cathode'},
        {name:'Cutting',stage:'cutting',workshopId:'cutting',electrodeLine:'cathode'},
      ],
    });
    expect(route.statusCode).toBe(201);
    const routeId=route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{}))
      .statusCode).toBe(200);
    const order=await post('/planning/orders',{
      orderCode:'TPO-'+randomUUID().slice(0,8),productCode:'LFP',
      routeId,routeVersion:1,plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    expect((await post('/planning/orders/'+order.json().id+'/release',{}))
      .statusCode).toBe(200);
    const batch=await post('/planning/orders/'+order.json().id+'/batches',{
      batchCode:'TC-'+randomUUID().slice(0,8),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(batch.statusCode).toBe(201);
    batchId=batch.json().id;
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('rejects other tenants, unauthorized actors, invalid stage and invented metrics', async () => {
    expect((await get('/planning/batches/'+batchId+'/journal-links',1)).statusCode).toBe(403);
    expect((await get('/planning/batches/'+batchId+'/journal-links',2)).statusCode).toBe(404);
    expect((await post(path(1),mix,1)).statusCode).toBe(403);
    expect((await post(path(1),mix,2)).statusCode).toBe(404);
    expect((await post(path(2),mix)).json()).toMatchObject({error:'journal_stage_mismatch'});
    expect((await post(path(1),{...mix,sourceStage:'coating'})).statusCode).toBe(400);
    expect((await post(path(1),{...mix,sourceMeasure:{kind:'coated_side_a_m',value:'1'}}))
      .statusCode).toBe(400);
    for (const value of ['0','-1','1.1234567','1000000000000']) {
      expect((await post(path(1),{...mix,sourceMeasure:{kind:'dry_solids_kg',value}}))
        .statusCode).toBe(400);
    }
    expect((await post(path(3),calender)).json()).toMatchObject({error:'batch_not_active'});
    expect((await post(path(4),{...cutting,sourceStage:'calendaring'})).statusCode).toBe(400);
    expect((await post(path(4),{...cutting,
      sourceMeasure:{kind:'cut_good_pieces',value:'154.5'}})).statusCode).toBe(400);
    expect((await post(path(4),{...cutting,
      sourceMeasure:{kind:'calendered_length_m',value:'154'}})).statusCode).toBe(400);
    expect((await post(path(1),mix)).json()).toMatchObject({error:'batch_not_active'});
  });

  it('keeps exact values, distinct store IDs, and idempotent immutable provenance', async () => {
    expect((await post('/planning/batches/'+batchId+'/status',{
      expectedStatus:'created',status:'in_progress',
    })).statusCode).toBe(200);
    expect((await post(path(1),mix)).statusCode).toBe(201);
    expect((await post(path(1),mix)).json())
      .toMatchObject({id:mixLink,alreadyLinked:true});
    expect((await post(path(2),coat)).statusCode).toBe(201);
    expect((await post(path(3),calender)).statusCode).toBe(201);
    expect((await post(path(4),cutting)).statusCode).toBe(201);
    expect((await post(path(1),{...mix,sourceMeasure:{kind:'dry_solids_kg',value:'12'}})).json())
      .toMatchObject({error:'journal_link_id_reused'});
    expect((await post(path(1),{...mix,linkId:randomUUID()})).json())
      .toMatchObject({error:'local_source_already_linked'});
    const differentStore = {...coat,linkId:randomUUID(),sourceEntryId:mixId};
    expect((await post(path(2),differentStore)).statusCode).toBe(201);
    const history=await get('/planning/batches/'+batchId+'/journal-links');
    expect(history.statusCode).toBe(200);
    expect(history.json().links).toEqual(expect.arrayContaining([
      expect.objectContaining({sourceKind:'mix_batch',sourceEntryId:mixId,
        sourceMeasure:{kind:'dry_solids_kg',value:'11.123456'}}),
      expect.objectContaining({sourceKind:'coat_run',sourceEntryId:coatId,
        sourceMeasure:{kind:'coated_side_a_m',value:'210.000000'}}),
      expect.objectContaining({sourceKind:'calender_run',sourceEntryId:calender.sourceEntryId,
        sourceMeasure:{kind:'calendered_length_m',value:'189.500000'}}),
      expect.objectContaining({sourceKind:'cut_run',sourceEntryId:cutting.sourceEntryId,
        sourceMeasure:{kind:'cut_good_pieces',value:'154.000000'}}),
    ]));
    expect(history.json().links).toHaveLength(5);
    const evidence=await pool.query(`SELECT count(*)::int AS n FROM production_step_evidence
      WHERE organization_id=$1 AND batch_id=$2`,[org,batchId]);
    expect(evidence.rows[0].n).toBe(0);
    await expect(pool.query(`UPDATE production_local_journal_links SET summary='altered'
      WHERE organization_id=$1 AND id=$2`,[org,mixLink]))
      .rejects.toThrow('append-only');
  });
});
