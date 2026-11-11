import {randomBytes,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';

const integration=process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('M2 whole-count writes and historical retries (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),chief=randomUUID(),route=randomUUID();
  const token=randomBytes(32).toString('base64url');
  let order='';
  const post=(url:string,payload:object)=>app.inject({method:'POST',url,
    headers:{authorization:'Bearer '+token},payload});
  const batch=async(unit='cells',quantity='100')=>{
    const r=await post('/planning/orders/'+order+'/batches',{
      batchCode:randomUUID(),materialLine:'cell',plannedQuantity:quantity,quantityUnit:unit});
    expect(r.statusCode,r.body).toBe(201);return r.json().id as string;
  };
  const active=async()=>{
    const id=await batch();
    expect((await post('/planning/batches/'+id+'/status',{
      expectedStatus:'created',status:'in_progress'})).statusCode).toBe(200);
    return id;
  };
  const evidence=(id:string,eventId:string,kind:string,quantity='100',quantityUnit='cells')=>
    post('/planning/batches/'+id+'/steps/1/evidence',{eventId,kind,
      ...(kind==='completed'?{quantity,quantityUnit}:{})});
  const countError=(r:{statusCode:number;json:()=>unknown})=>{
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({error:'quantity_requires_whole_count'});
  };
  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/production_mf_ci')
      throw new Error('Whole-count tests require disposable PostgreSQL');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe('production_mf_ci');
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Count fixture')",[org]);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$2,$3,'test-only','chief')`,[chief,org,'counts-'+chief]);
    await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,[randomUUID(),org,chief,tokenHash(token)]);
    await pool.query("INSERT INTO workshops(organization_id,id,name) VALUES($1,'test','Test')",[org]);
    await pool.query(`INSERT INTO process_routes(organization_id,id,code,name,created_by)
      VALUES($1,$2,$3,'Count route',$4)`,[org,route,randomUUID(),chief]);
    await pool.query(`INSERT INTO process_route_versions(organization_id,route_id,version)
      VALUES($1,$2,1)`,[org,route]);
    await pool.query(`INSERT INTO process_route_steps
      (organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line)
      VALUES($1,$2,1,1,'Assembly','assembly','test','common'),
            ($1,$2,1,2,'Formation','formation','test','common')`,[org,route]);
    await pool.query(`UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3
      WHERE organization_id=$1 AND route_id=$2 AND version=1`,[org,route,chief]);
    const r=await post('/planning/orders',{orderCode:randomUUID(),productCode:'TEST',routeId:route,
      routeVersion:1,plannedQuantity:'100',quantityUnit:'cells'});
    expect(r.statusCode).toBe(201);order=r.json().id;
    expect((await post('/planning/orders/'+order+'/release',{})).statusCode).toBe(200);
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('requires whole counts for new orders and batches while preserving decimal physical units',async()=>{
    for(const unit of ['cells','pieces','kg','m','m2']){
      const payload={orderCode:randomUUID(),productCode:'TEST',routeId:route,routeVersion:1,
        plannedQuantity:'12.500001',quantityUnit:unit};
      const r=await post('/planning/orders',payload);
      if(['cells','pieces'].includes(unit)){
        countError(r);
        expect((await pool.query('SELECT id FROM production_orders WHERE organization_id=$1 AND order_code=$2',
          [org,payload.orderCode])).rowCount).toBe(0);
        countError(await post('/planning/orders/'+order+'/batches',{
          batchCode:randomUUID(),materialLine:'cell',plannedQuantity:'12.500001',quantityUnit:unit}));
        await batch(unit,'12.000000');
      }else{
        expect(r.statusCode,r.body).toBe(201);
        await batch(unit,'12.500001');
      }
    }
  });

  it('rejects fractional completion counts without consuming the event UUID',async()=>{
    const id=await active(),eventId=randomUUID();
    expect((await evidence(id,randomUUID(),'started')).statusCode).toBe(201);
    countError(await evidence(id,eventId,'completed','1.5'));
    expect((await evidence(id,eventId,'completed','2.000000')).statusCode).toBe(201);
    expect((await evidence(id,eventId,'completed','2.000000')).statusCode).toBe(200);
    const physical=await active();
    expect((await evidence(physical,randomUUID(),'started')).statusCode).toBe(201);
    expect((await evidence(physical,randomUUID(),'completed','1.500001','kg')).statusCode).toBe(201);
  });

  it('rejects fractional handovers and still accepts exact historical fractional retries',async()=>{
    const id=await active(),handoffId=randomUUID();
    expect((await evidence(id,randomUUID(),'started')).statusCode).toBe(201);
    expect((await evidence(id,randomUUID(),'completed')).statusCode).toBe(201);
    const url='/planning/batches/'+id+'/handoffs';
    const payload={handoffId,fromStep:1,toStep:2,quantity:'1.5',quantityUnit:'cells'};
    countError(await post(url,payload));
    expect((await post(url,{...payload,quantity:'2.000000'})).statusCode).toBe(201);
    const legacy=await active(),legacyId=randomUUID();
    // Synthetic pre-validation records stay immutable; do not rewrite history.
    await pool.query(`INSERT INTO production_stage_handoffs
      (organization_id,id,batch_id,from_step,to_step,from_workshop_id,to_workshop_id,
        quantity,quantity_unit,sent_by) VALUES($1,$2,$3,1,2,'test','test',1.5,'cells',$4)`,
      [org,legacyId,legacy,chief]);
    const replay=await post('/planning/batches/'+legacy+'/handoffs',{
      ...payload,handoffId:legacyId});
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json().status).toBe('already_sent');
  });

  it('preserves exact historical completion retries without permitting new fractional events',async()=>{
    const id=await active(),eventId=randomUUID();
    await pool.query(`INSERT INTO production_step_evidence
      (organization_id,id,batch_id,order_id,route_id,route_version,step_number,workshop_id,
        kind,actor_id,quantity,quantity_unit)
      VALUES($1,$2,$3,$4,$5,1,1,'test','completed',$6,1.5,'cells')`,[org,eventId,id,order,route,chief]);
    const replay=await evidence(id,eventId,'completed','1.500000');
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json().alreadyRecorded).toBe(true);
    countError(await evidence(id,randomUUID(),'completed','1.5'));
  });

  it('checks both genealogy quantities and preserves exact historical declaration retries',async()=>{
    const source=randomUUID(),target=await batch();
    await pool.query(`INSERT INTO production_batches
      (organization_id,id,order_id,batch_code,material_line,status,planned_quantity,quantity_unit,created_by)
      VALUES($1,$2,$3,$4,'cell','completed',100,'cells',$5)`,[org,source,order,randomUUID(),chief]);
    const payload={declarationId:randomUUID(),sourceBatchId:source,kind:'merge',
      sourceQuantity:'1.5',sourceUnit:'cells',targetQuantity:'1',targetUnit:'cells'};
    const url='/planning/batches/'+target+'/links';
    countError(await post(url,payload));
    countError(await post(url,{...payload,sourceQuantity:'2',targetQuantity:'1.5',targetUnit:'pieces'}));
    expect((await post(url,{...payload,sourceQuantity:'2'})).statusCode).toBe(201);
    const legacyId=randomUUID();
    await pool.query(`INSERT INTO production_batch_links
      (organization_id,id,order_id,source_batch_id,target_batch_id,link_kind,
        source_quantity,source_unit,target_quantity,target_unit,actor_id)
      VALUES($1,$2,$3,$4,$5,'merge',1.5,'cells',1,'cells',$6)`,[org,legacyId,order,source,target,chief]);
    const replay=await post(url,{...payload,declarationId:legacyId});
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json().alreadyRecorded).toBe(true);
    const stored=await pool.query(`SELECT source_quantity::text FROM production_batch_links
      WHERE organization_id=$1 AND id=$2`,[org,legacyId]);
    expect(stored.rows[0].source_quantity).toBe('1.500000');
  });
});
