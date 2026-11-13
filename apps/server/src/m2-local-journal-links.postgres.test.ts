import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('M2 chief-attested legacy stage journal references (PostgreSQL)', () => {
  const pool = new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app = buildApp(pool);
  const org = randomUUID(), outsiderOrg = randomUUID();
  const actors = [randomUUID(),randomUUID(),randomUUID()];
  const tokens = actors.map(() => randomBytes(32).toString('base64url'));
  const auth = (i=0) => ({authorization:'Bearer '+tokens[i]});
  let batchId = '';
  const sourceEntryId = randomUUID(), linkId = randomUUID();
  const payload = {linkId,sourceEntryId,sourceStage:'coating',
    sourceCreatedAt:'2026-11-10T10:15:00.000Z',
    summary:'Recorded a coating run, source is local',
    defects:'Visible pinholes near roll end'};
  const post = (path:string, input:object, actor=0) => app.inject({
    method:'POST',url:path,headers:auth(actor),payload:input,
  });
  const url = (step=1,batch=batchId) =>
    '/planning/batches/'+batch+'/steps/'+step+'/journal-links';
  const history = (actor=0,batch=batchId) => app.inject({
    method:'GET',url:'/planning/batches/'+batch+'/journal-links',headers:auth(actor),
  });
  beforeAll(async () => {
    const target=new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci')
      throw new Error('Journal links integration requires disposable CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS db')).rows[0].db)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Journal links tenant',outsiderOrg,'Outside tenant']);
    for (const [i,user] of actors.entries()) {
      const tenant=i===2 ? outsiderOrg : org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,tenant,'link-'+user,i===1?'master':'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating'),($1,'assembly','Assembly')`,[org]);
    const route=await post('/planning/routes',{code:'JL-'+randomUUID().slice(0,8),
      name:'Reference pilot',steps:[
        {name:'Cathode coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cell assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
      ]});
    expect(route.statusCode).toBe(201);
    const routeId=route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{})).statusCode).toBe(200);
    const order=await post('/planning/orders',{orderCode:'PO-'+randomUUID().slice(0,8),
      productCode:'18650',routeId,routeVersion:1,plannedQuantity:'100',quantityUnit:'cells'});
    expect(order.statusCode).toBe(201);
    expect((await post('/planning/orders/'+order.json().id+'/release',{})).statusCode).toBe(200);
    const batch=await post('/planning/orders/'+order.json().id+'/batches',{
      batchCode:'CATH-'+randomUUID().slice(0,8),materialLine:'cathode',
      plannedQuantity:'25',quantityUnit:'kg'});
    expect(batch.statusCode).toBe(201);
    batchId=batch.json().id;
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('rejects demo-style references, unauthorized actors and mismatched routes',async()=>{
    expect((await app.inject({method:'GET',url:'/planning/batches/'+batchId+'/journal-links'}))
      .statusCode).toBe(401);
    expect((await history(1)).statusCode).toBe(403);
    expect((await history(2)).statusCode).toBe(404);
    expect((await history(0,randomUUID())).statusCode).toBe(404);
    expect((await post(url(),{...payload,sourceEntryId:'jr-001'})).statusCode).toBe(400);
    expect((await post(url(),payload,1)).statusCode).toBe(403);
    expect((await post(url(),payload,2)).statusCode).toBe(404);
    expect((await post(url(2),payload)).json()).toMatchObject({error:'step_not_in_batch_route'});
    expect((await post(url(),{...payload,sourceStage:'assembly'})).json())
      .toMatchObject({error:'journal_stage_mismatch'});
    expect((await post(url(),payload)).json()).toMatchObject({error:'batch_not_active'});
  });

  it('attaches one explicit reference and keeps original data out of execution evidence',async()=>{
    expect((await post('/planning/batches/'+batchId+'/status',
      {expectedStatus:'created',status:'in_progress'})).statusCode).toBe(200);
    const linked=await post(url(),payload);
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({id:linkId,alreadyLinked:false});
    expect((await post(url(),payload)).json()).toMatchObject({
      id:linkId,alreadyLinked:true,
    });
    expect((await post(url(),{...payload,summary:'Changed summary'})).json())
      .toMatchObject({error:'journal_link_id_reused'});
    expect((await post(url(),{...payload,linkId:randomUUID()})).json())
      .toMatchObject({error:'local_source_already_linked'});
    const records=await history();
    expect(records.statusCode).toBe(200);
    expect(records.json().links).toEqual([
      expect.objectContaining({id:linkId,stepNumber:1,
        sourceStage:'coating',sourceEntryId,summary:payload.summary,
        defects:payload.defects,linkedBy:actors[0]}),
    ]);
    const noEvidence=await pool.query(`SELECT count(*)::int AS n
      FROM production_step_evidence WHERE organization_id=$1 AND batch_id=$2`,
      [org,batchId]);
    expect(noEvidence.rows[0].n).toBe(0);
    await expect(pool.query(`UPDATE production_local_journal_links
      SET summary='altered' WHERE organization_id=$1 AND id=$2`,[org,linkId]))
      .rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_local_journal_links
      WHERE organization_id=$1 AND id=$2`,[org,linkId]))
      .rejects.toThrow('append-only');
  });
});
