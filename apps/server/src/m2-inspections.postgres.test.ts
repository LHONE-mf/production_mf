import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration=process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 route-scoped inspection observations (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),outsideOrg=randomUUID();
  const chief=randomUUID(),master=randomUUID(),outsideChief=randomUUID();
  const actors=[chief,master,outsideChief];
  const tokens=actors.map(()=>randomBytes(32).toString('base64url'));
  const auth=(n=0)=>({authorization:'Bearer '+tokens[n]});
  let batchId='',cellId='';
  const code=(prefix:string)=>prefix+'-'+randomUUID().slice(0,8);
  const at=(step=1,batch=batchId)=>'/planning/batches/'+batch+'/steps/'+step+'/inspections';
  const history=(batch=batchId,actor=0)=>app.inject({
    method:'GET',url:'/planning/batches/'+batch+'/inspections',headers:auth(actor),
  });
  const post=(url:string,payload:object,actor=0)=>app.inject({
    method:'POST',url,headers:auth(actor),payload,
  });
  const measured={
    observationId:randomUUID(),kind:'measurement',characteristic:'Film thickness',
    observedValue:'0.012345',observedUnit:'mm',attentionRequired:false,
    note:'Recorded with micrometer',
  };
  const visual={
    observationId:randomUUID(),kind:'visual',characteristic:'Edge surface',
    attentionRequired:true,note:'Visible coating flakes; review required',
  };

  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||
      url.pathname!=='/production_mf_ci')
      throw new Error('Inspection test requires disposable CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS db')).rows[0].db)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Inspection CI',outsideOrg,'Other inspection CI']);
    for(const [n,user] of actors.entries()){
      const tenant=n===2?outsideOrg:org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,
        [user,tenant,'inspection-'+user,n===1?'master':'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),tenant,user,tokenHash(tokens[n])]);
    }
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating'),($1,'assembly','Assembly')`,[org]);
    const route=await post('/planning/routes',{
      code:code('IR'),name:'Inspection pilot route',
      steps:[
        {name:'Cathode coat',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Cell assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
      ],
    });
    expect(route.statusCode).toBe(201);
    const routeId=route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{}))
      .statusCode).toBe(200);
    const order=await post('/planning/orders',{
      orderCode:code('IQ'),productCode:'NMC',routeId,routeVersion:1,
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    const orderId=order.json().id;
    expect((await post('/planning/orders/'+orderId+'/release',{})).statusCode).toBe(200);
    const batch=await post('/planning/orders/'+orderId+'/batches',{
      batchCode:code('IC'),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(batch.statusCode).toBe(201);
    batchId=batch.json().id;
    const cells=await post('/planning/orders/'+orderId+'/batches',{
      batchCode:code('ICELL'),materialLine:'cell',
      plannedQuantity:'10',quantityUnit:'cells',
    });
    expect(cells.statusCode).toBe(201);
    cellId=cells.json().id;
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('scopes inspection access by session, organization and material branch',async()=>{
    expect((await app.inject({method:'GET',url:'/planning/batches/'+batchId+'/inspections'}))
      .statusCode).toBe(401);
    expect((await history(batchId,1)).statusCode).toBe(403);
    expect((await history(batchId,2)).statusCode).toBe(404);
    expect((await history(randomUUID())).statusCode).toBe(404);
    expect((await history('not-uuid')).statusCode).toBe(400);
    expect((await post(at(),measured,1)).statusCode).toBe(403);
    expect((await post(at(),measured,2)).statusCode).toBe(404);
    expect((await post(at(2),measured)).json())
      .toMatchObject({error:'step_not_in_batch_route'});
    expect((await post(at(1,cellId),measured)).json())
      .toMatchObject({error:'step_not_in_batch_route'});
    expect((await history()).json()).toEqual({batchId,observations:[]});
  });

  it('rejects ambiguous findings and refuses writes outside active/held batches',async()=>{
    const invalid=[
      {...measured,observationId:'demo-entry'},
      {...measured,characteristic:' '},
      {...measured,observedUnit:'unknown'},
      {...measured,observedValue:'1.1234567'},
      {...measured,observedValue:'9999999999999'},
      {...measured,observedValue:'not-number'},
      {...measured,kind:'visual',observedValue:undefined,observedUnit:undefined,note:undefined},
      {...measured,kind:'measurement',observedValue:undefined},
      {...measured,attentionRequired:true,note:undefined},
    ];
    for(const payload of invalid){
      const response=await post(at(),payload);
      expect(response.statusCode).toBe(400);
    }
    expect((await post(at(),{...measured,attentionRequired:true,note:undefined}))
      .json()).toMatchObject({error:'inspection_note_required'});
    expect((await post(at(),measured)).json())
      .toMatchObject({error:'batch_not_open_for_inspection'});
  });

  it('writes numeric and visual findings exactly once, without releasing or completing batches',async()=>{
    expect((await post('/planning/batches/'+batchId+'/status',{
      expectedStatus:'created',status:'in_progress',
    })).statusCode).toBe(200);
    const first=await post(at(),measured);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({id:measured.observationId,alreadyRecorded:false});
    expect((await post(at(),measured)).json()).toMatchObject({
      id:measured.observationId,alreadyRecorded:true,
    });
    expect((await post(at(),{...measured,observedValue:'0.012346'})).json())
      .toMatchObject({error:'inspection_id_reused'});
    const signed={...measured,observationId:randomUUID(),observedValue:'-1.500001'};
    expect((await post(at(),signed)).statusCode).toBe(201);
    expect((await post(at(),visual)).statusCode).toBe(201);
    const result=await history();
    expect(result.statusCode).toBe(200);
    expect(result.json().observations).toEqual(expect.arrayContaining([
      expect.objectContaining({id:measured.observationId,stepNumber:1,
        characteristic:'Film thickness',kind:'measurement',
        observedValue:'0.012345',observedUnit:'mm',attentionRequired:false,
        recordedBy:chief}),
      expect.objectContaining({id:signed.observationId,observedValue:'-1.500001'}),
      expect.objectContaining({id:visual.observationId,kind:'visual',
        attentionRequired:true,note:visual.note,
        observedValue:null,observedUnit:null}),
    ]));
    expect(result.json().observations).toHaveLength(3);
    const audit=await pool.query(`SELECT b.status,
      (SELECT count(*)::int FROM production_step_evidence
        WHERE organization_id=$1 AND batch_id=$2) AS completions
      FROM production_batches b WHERE b.organization_id=$1 AND b.id=$2`,[org,batchId]);
    expect(audit.rows[0]).toMatchObject({status:'in_progress',completions:0});

    expect((await post('/planning/batches/'+batchId+'/status',{
      expectedStatus:'in_progress',status:'hold',reason:'Visual finding under review',
    })).statusCode).toBe(200);
    const held={...visual,observationId:randomUUID(),
      note:'Second check after placing batch on hold'};
    expect((await post(at(),held)).statusCode).toBe(201);
    expect((await post(at(),visual)).json()).toMatchObject({alreadyRecorded:true});

    await expect(pool.query(`UPDATE production_inspection_observations
      SET note='rewrite' WHERE organization_id=$1 AND id=$2`,
      [org,visual.observationId])).rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_inspection_observations
      WHERE organization_id=$1 AND id=$2`,
      [org,visual.observationId])).rejects.toThrow('append-only');
    expect((await history()).json().observations).toHaveLength(4);
  });
});
