import { randomBytes,randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('M2 flagged quality observations and completion triage (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),outsideOrg=randomUUID();
  const actors=[randomUUID(),randomUUID(),randomUUID()];
  const tokens=actors.map(()=>randomBytes(32).toString('base64url'));
  const auth=(actor=0)=>({authorization:'Bearer '+tokens[actor]});
  const post=(url:string,payload:object,actor=0)=>app.inject({
    method:'POST',url,headers:auth(actor),payload,
  });
  const get=(url:string,actor=0)=>app.inject({
    method:'GET',url,headers:auth(actor),
  });
  const code=(label:string)=>label+'-'+randomUUID().slice(0,8);
  let batch='',cellBatch='';
  const obsId=randomUUID(),ordinaryId=randomUUID(),secondFlagId=randomUUID();
  const reviewId=randomUUID();
  const finding=(id:string,flagged=true)=>({
    observationId:id,kind:'visual',characteristic:'Coating edge',
    attentionRequired:flagged,note:'Edge texture needs review',
  });
  const inspectionUrl=(batchId=batch)=>
    '/planning/batches/'+batchId+'/steps/1/inspections';
  const reviewUrl=(id=obsId,batchId=batch)=>
    '/planning/batches/'+batchId+'/inspections/'+id+'/reviews';
  const reviews=()=>get('/planning/batches/'+batch+'/inspections');
  const close=()=>post('/planning/batches/'+batch+'/status',{
    expectedStatus:'in_progress',status:'completed',
  });
  const decision=(id:string,outcome:'reviewed_no_block'|'follow_up_required',reason:string)=>({
    reviewId:id,outcome,reason,
  });

  beforeAll(async()=>{
    const address=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(address.hostname)||
      address.pathname!=='/production_mf_ci')
      throw new Error('Quality triage tests require isolated CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS db')).rows[0].db)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Review test tenant',outsideOrg,'Review outside tenant']);
    for(const [i,user] of actors.entries()){
      const tenant=i===2?outsideOrg:org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,tenant,'review-'+user,i===1?'master':'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(tokens[i])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating'),($1,'assembly','Assembly')`,[org]);
    const route=await post('/planning/routes',{
      code:code('REVIEW'),name:'Coded review route',
      steps:[
        {name:'Cathode coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cell assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
      ],
    });
    expect(route.statusCode).toBe(201);
    const routeId=route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{})).statusCode).toBe(200);
    const order=await post('/planning/orders',{
      orderCode:code('ORDER'),productCode:'LFP',routeId,routeVersion:1,
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    expect((await post('/planning/orders/'+order.json().id+'/release',{})).statusCode).toBe(200);
    const main=await post('/planning/orders/'+order.json().id+'/batches',{
      batchCode:code('CATH'),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(main.statusCode).toBe(201);
    batch=main.json().id;
    const cell=await post('/planning/orders/'+order.json().id+'/batches',{
      batchCode:code('CELL'),materialLine:'cell',
      plannedQuantity:'50',quantityUnit:'cells',
    });
    expect(cell.statusCode).toBe(201);
    cellBatch=cell.json().id;
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('enforces login, tenant, role and exact reviewed observation',async()=>{
    expect((await app.inject({method:'POST',url:reviewUrl(),
      payload:decision(reviewId,'reviewed_no_block','Documented inspection check')}))
      .statusCode).toBe(401);
    expect((await post(reviewUrl(),
      decision(reviewId,'reviewed_no_block','Reason'),1)).statusCode).toBe(403);
    expect((await post(reviewUrl(),
      decision(reviewId,'reviewed_no_block','Reason'),2)).statusCode).toBe(404);
    expect((await post(reviewUrl(randomUUID()),
      decision(reviewId,'reviewed_no_block','Reason'))).statusCode).toBe(404);
    expect((await post(reviewUrl(obsId,cellBatch),
      decision(reviewId,'reviewed_no_block','Reason'))).statusCode).toBe(404);
    for(const payload of [
      {...decision(reviewId,'reviewed_no_block','Reason'),reviewId:'demo'},
      {...decision(reviewId,'reviewed_no_block','Reason'),reason:' '},
      {...decision(reviewId,'reviewed_no_block','Reason'),outcome:'approved'},
      {...decision(reviewId,'reviewed_no_block','Reason'),unexpected:true},
    ]){
      expect((await post(reviewUrl(),payload)).statusCode).toBe(400);
    }
  });

  it('prevents closure before reviews, while ordinary observations need no triage',async()=>{
    expect((await post('/planning/batches/'+batch+'/status',{
      expectedStatus:'created',status:'in_progress',
    })).statusCode).toBe(200);
    expect((await post(inspectionUrl(),finding(ordinaryId,false))).statusCode).toBe(201);
    expect((await close()).json()).toMatchObject({error:'batch_route_step_incomplete'});
    expect((await post(inspectionUrl(),finding(obsId))).statusCode).toBe(201);
    expect((await post(inspectionUrl(),finding(secondFlagId))).statusCode).toBe(201);
    expect((await close()).json()).toMatchObject({error:'inspection_review_pending'});
    expect((await post(reviewUrl(ordinaryId),
      decision(randomUUID(),'reviewed_no_block','No problem'))).json())
      .toMatchObject({error:'observation_review_not_required'});
    expect((await reviews()).json().observations).toEqual(expect.arrayContaining([
      expect.objectContaining({id:obsId,attentionRequired:true,latestReview:null}),
      expect.objectContaining({id:ordinaryId,attentionRequired:false,
        latestReview:null,reviewHistory:[]}),
    ]));
  });

  it('needs a latest nonblocking rationale for every flagged observation',async()=>{
    const followup=decision(reviewId,'follow_up_required','Further visual examination needed');
    const first=await post(reviewUrl(),followup);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({reviewNumber:1,alreadyRecorded:false});
    expect((await post(reviewUrl(),followup)).json()).toMatchObject({
      reviewNumber:1,alreadyRecorded:true,
    });
    expect((await post(reviewUrl(),{...followup,reason:'changed'})).json())
      .toMatchObject({error:'inspection_review_id_reused'});
    expect((await close()).json()).toMatchObject({error:'inspection_review_pending'});
    const nonblocking=decision(randomUUID(),'reviewed_no_block',
      'Additional check documented: no blocking condition found');
    expect((await post(reviewUrl(),nonblocking)).json())
      .toMatchObject({reviewNumber:2,alreadyRecorded:false});
    expect((await close()).json()).toMatchObject({error:'inspection_review_pending'});
    const second=decision(randomUUID(),'reviewed_no_block',
      'Second location inspected with no blocking finding');
    expect((await post(reviewUrl(secondFlagId),second)).statusCode).toBe(201);
    const history=(await reviews()).json().observations;
    expect(history.find((r:{id:string})=>r.id===obsId)).toMatchObject({
      latestReview:{number:2,outcome:'reviewed_no_block',
        reason:nonblocking.reason,reviewedBy:actors[0]},
      reviewHistory:[
        {number:1,outcome:'follow_up_required',
          reason:followup.reason,reviewedBy:actors[0]},
        {number:2,outcome:'reviewed_no_block',
          reason:nonblocking.reason,reviewedBy:actors[0]},
      ],
    });
    expect(history.find((r:{id:string})=>r.id===secondFlagId)).toMatchObject({
      latestReview:{number:1,outcome:'reviewed_no_block'},
    });
    expect((await close()).json()).toMatchObject({error:'batch_route_step_incomplete'});
    // Later follow-up reopens the completion guard without rewriting history.
    expect((await post(reviewUrl(),decision(randomUUID(),
      'follow_up_required','Another observation requires confirmation'))).json())
      .toMatchObject({reviewNumber:3});
    expect((await close()).json()).toMatchObject({error:'inspection_review_pending'});
    expect((await post(reviewUrl(),decision(randomUUID(),
      'reviewed_no_block','Follow-up performed, no blocking condition'))).json())
      .toMatchObject({reviewNumber:4});
    expect((await close()).json()).toMatchObject({error:'batch_route_step_incomplete'});
    const completeHistory=(await reviews()).json().observations
      .find((r:{id:string})=>r.id===obsId);
    expect(completeHistory.reviewHistory.map((r:{number:number})=>r.number))
      .toEqual([1,2,3,4]);
    expect(completeHistory.latestReview.number).toBe(4);
    const count=await pool.query(`SELECT count(*)::int AS n FROM production_inspection_reviews
      WHERE organization_id=$1 AND batch_id=$2`,[org,batch]);
    expect(count.rows[0].n).toBe(5);
    await expect(pool.query(`UPDATE production_inspection_reviews
      SET reason='edited' WHERE organization_id=$1 AND id=$2`,[org,reviewId]))
      .rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_inspection_reviews
      WHERE organization_id=$1 AND id=$2`,[org,reviewId]))
      .rejects.toThrow('append-only');
  });

  it('does not auto-release, auto-complete, or permit fresh reviews after completion',async()=>{
    expect((await post('/planning/batches/'+batch+'/steps/1/evidence',{
      eventId:randomUUID(),kind:'started',
    })).statusCode).toBe(201);
    expect((await post('/planning/batches/'+batch+'/steps/1/evidence',{
      eventId:randomUUID(),kind:'completed',quantity:'99',quantityUnit:'kg',
    })).statusCode).toBe(201);
    const result=await close();
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe('completed');
    expect((await post(reviewUrl(),decision(randomUUID(),
      'follow_up_required','New event after completion'))).json())
      .toMatchObject({error:'batch_not_open_for_inspection'});
    expect((await post(reviewUrl(),decision(reviewId,
      'follow_up_required','Further visual examination needed'))).json())
      .toMatchObject({alreadyRecorded:true,reviewNumber:1});
    expect((await reviews()).statusCode).toBe(200);
  });
});
