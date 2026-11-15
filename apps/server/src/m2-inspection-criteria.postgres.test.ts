import { randomBytes,randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('M2 frozen inspection criteria (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),otherOrg=randomUUID();
  const users=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  const tokens=users.map(()=>randomBytes(32).toString('base64url'));
  const auth=(n=0)=>({authorization:'Bearer '+tokens[n]});
  const post=(url:string,payload:object,actor=0)=>
    app.inject({method:'POST',url,headers:auth(actor),payload});
  const get=(url:string,actor=0)=>app.inject({method:'GET',url,headers:auth(actor)});
  const code=(s:string)=>s+'-'+randomUUID().slice(0,8);
  let routeId='',orderId='',batchId='',cellId='';
  const routeUrl=()=>'/planning/routes/'+routeId+'/versions/1/inspection-criteria';
  const stepUrl=(n=1)=>'/planning/routes/'+routeId+'/versions/1/steps/'+n+'/inspection-criteria';
  const batchUrl=(id=batchId)=>'/planning/batches/'+id+'/inspection-criteria';
  const coating={
    criterionId:randomUUID(),characteristic:'Coating thickness',unit:'um',
    lowerLimit:'75.000001',upperLimit:'150.250000',note:'Reference only',
  };
  const assembly={
    criterionId:randomUUID(),characteristic:'Cell voltage',unit:'V',
    lowerLimit:'-0.125000',upperLimit:'9.000000',
  };

  beforeAll(async()=>{
    const target=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(target.hostname)||
      target.pathname!=='/production_mf_ci')
      throw new Error('Inspection criteria tests require disposable CI PostgreSQL');
    expect((await pool.query('SELECT current_database() AS db')).rows[0].db)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Criteria CI',otherOrg,'Other criteria CI']);
    for(const [i,user] of users.entries()){
      const tenant=i===3?otherOrg:org;
      const role=['chief','master','technologist','chief'][i];
      await pool.query('INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$3,$4,$5)',
        [user,tenant,'criteria-'+user,'test-only',role]);
      await pool.query('INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval \'30 minutes\')',
        [randomUUID(),tenant,user,tokenHash(tokens[i])]);
    }
    await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$3),($1,$4,$5)',
      [org,'coating','Coating','assembly','Assembly']);
    const route=await post('/planning/routes',{
      code:code('CRT'),name:'Criteria route',
      steps:[
        {name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
        {name:'Assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
      ],
    });
    expect(route.statusCode).toBe(201);
    routeId=route.json().id;
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('requires login, chief writes and approved route with strict limits',async()=>{
    expect((await app.inject({method:'GET',url:routeUrl()})).statusCode).toBe(401);
    expect((await get(routeUrl(),1)).statusCode).toBe(403);
    expect((await get(routeUrl(),3)).statusCode).toBe(404);
    expect((await get(routeUrl(),2)).statusCode).toBe(200);
    expect((await post(stepUrl(),coating,1)).statusCode).toBe(403);
    expect((await post(stepUrl(),coating,2)).statusCode).toBe(403);
    expect((await post(stepUrl(),coating,3)).statusCode).toBe(404);
    expect((await post(stepUrl(),coating)).json())
      .toMatchObject({error:'criterion_route_not_approved'});
    expect((await post(stepUrl(3),coating)).json())
      .toMatchObject({error:'criterion_step_not_found'});
    for(const invalid of [
      {...coating,criterionId:'demo'},
      {...coating,characteristic:' '},
      {...coating,lowerLimit:undefined,upperLimit:undefined},
      {...coating,lowerLimit:'200',upperLimit:'100'},
      {...coating,lowerLimit:'1.0000001'},
      {...coating,lowerLimit:'1000000000000'},
      {...coating,unit:'invalid'},
      {...coating,extra:true},
    ])expect((await post(stepUrl(),invalid)).statusCode).toBe(400);
  });

  it('stores append-only references and freezes edits after the route is used',async()=>{
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{}))
      .statusCode).toBe(200);
    expect((await post(stepUrl(),coating)).statusCode).toBe(201);
    expect((await post(stepUrl(2),assembly)).statusCode).toBe(201);
    expect((await post(stepUrl(),coating)).json())
      .toMatchObject({alreadyRecorded:true,id:coating.criterionId});
    expect((await post(stepUrl(),{...coating,upperLimit:'160'})).json())
      .toMatchObject({error:'inspection_criterion_id_reused'});
    expect((await post(stepUrl(),{...coating,criterionId:randomUUID(),
      characteristic:'coating thickness'})).json())
      .toMatchObject({error:'inspection_criterion_already_defined'});
    const list=(await get(routeUrl())).json();
    expect(list).toMatchObject({routeId,version:1,state:'approved',frozen:false});
    expect(list.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({id:coating.criterionId,stepNumber:1,
        lowerLimit:'75.000001',upperLimit:'150.250000'}),
      expect.objectContaining({id:assembly.criterionId,stepNumber:2,
        lowerLimit:'-0.125000',upperLimit:'9.000000'}),
    ]));
    expect(list.criteria).toHaveLength(2);
    await expect(pool.query('UPDATE production_inspection_criteria SET note=$3 WHERE organization_id=$1 AND id=$2',
      [org,coating.criterionId,'changed'])).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM production_inspection_criteria WHERE organization_id=$1 AND id=$2',
      [org,coating.criterionId])).rejects.toThrow('append-only');
    const order=await post('/planning/orders',{
      orderCode:code('ORD'),productCode:'NMC',routeId,routeVersion:1,
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    orderId=order.json().id;
    expect((await post(stepUrl(),{...coating,criterionId:randomUUID(),
      characteristic:'Width'})).json())
      .toMatchObject({error:'inspection_criteria_frozen'});
    expect((await post(stepUrl(),coating)).json()).toMatchObject({alreadyRecorded:true});
    expect((await get(routeUrl())).json().frozen).toBe(true);
  });

  it('shows criteria only for the applicable batch branch, never QA approval',async()=>{
    expect((await post('/planning/orders/'+orderId+'/release',{})).statusCode).toBe(200);
    const cath=await post('/planning/orders/'+orderId+'/batches',{
      batchCode:code('CATH'),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(cath.statusCode).toBe(201);
    batchId=cath.json().id;
    const cell=await post('/planning/orders/'+orderId+'/batches',{
      batchCode:code('CELL'),materialLine:'cell',
      plannedQuantity:'10',quantityUnit:'cells',
    });
    expect(cell.statusCode).toBe(201);
    cellId=cell.json().id;
    expect((await get(batchUrl(),1)).statusCode).toBe(403);
    expect((await get(batchUrl(),3)).statusCode).toBe(404);
    expect((await get(batchUrl(randomUUID()))).statusCode).toBe(404);
    expect((await get(batchUrl('bad'))).statusCode).toBe(400);
    expect((await get(batchUrl())).json().criteria).toEqual([
      expect.objectContaining({id:coating.criterionId,stepNumber:1}),
    ]);
    expect((await get(batchUrl(cellId))).json().criteria).toEqual([
      expect.objectContaining({id:assembly.criterionId,stepNumber:2}),
    ]);
    const reviewCount=await pool.query('SELECT count(*)::int AS n FROM production_inspection_reviews WHERE organization_id=$1',[org]);
    expect(reviewCount.rows[0].n).toBe(0);
  });
});