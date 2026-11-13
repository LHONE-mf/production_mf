import { randomBytes,randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('M2 advisory exact-decimal inspection comparisons (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),user=randomUUID(),token=randomBytes(32).toString('base64url');
  const auth={authorization:'Bearer '+token};
  const post=(url:string,payload:object)=>app.inject({method:'POST',url,headers:auth,payload});
  const get=(url:string)=>app.inject({method:'GET',url,headers:auth});
  let batch='',routeId='';
  const code=(prefix:string)=>prefix+'-'+randomUUID().slice(0,8);
  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||
      url.pathname!=='/production_mf_ci')
      throw new Error('Advisory comparison requires disposable CI PostgreSQL');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [org,'Inspection comparison test']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$2,$3,'test-only','chief')`,[user,org,'compare-'+user]);
    await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
      [randomUUID(),org,user,tokenHash(token)]);
    await pool.query(`INSERT INTO workshops(organization_id,id,name)
      VALUES($1,'coating','Coating')`,[org]);
    const route=await post('/planning/routes',{
      code:code('CMP'),name:'Measurement comparison route',
      steps:[{name:'Cathode coat',stage:'coating',workshopId:'coating',
        electrodeLine:'cathode'}],
    });
    expect(route.statusCode).toBe(201);
    routeId=route.json().id;
    expect((await post('/planning/routes/'+routeId+'/versions/1/approve',{}))
      .statusCode).toBe(200);
    for(const item of [
      {characteristic:'Coating thickness',unit:'um',lowerLimit:'12.000001',
        upperLimit:'14.000001'},
      {characteristic:'Coating mass',unit:'g',lowerLimit:'0.500000'},
    ]){
      expect((await post('/planning/routes/'+routeId+
        '/versions/1/steps/1/inspection-criteria',{
          criterionId:randomUUID(),...item,
        })).statusCode).toBe(201);
    }
    const order=await post('/planning/orders',{
      orderCode:code('ORDER'),productCode:'NMC',routeId,routeVersion:1,
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(order.statusCode).toBe(201);
    const orderId=order.json().id;
    expect((await post('/planning/orders/'+orderId+'/release',{}))
      .statusCode).toBe(200);
    const b=await post('/planning/orders/'+orderId+'/batches',{
      batchCode:code('BATCH'),materialLine:'cathode',
      plannedQuantity:'100',quantityUnit:'kg',
    });
    expect(b.statusCode).toBe(201);
    batch=b.json().id;
    expect((await post('/planning/batches/'+batch+'/status',{
      expectedStatus:'created',status:'in_progress',
    })).statusCode).toBe(200);
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('compares exact boundaries and excludes mismatched names and units',async()=>{
    const cases=[
      {name:'Coating thickness',unit:'um',value:'12.000000',
        result:'below_reference'},
      {name:'Coating thickness',unit:'um',value:'12.000001',
        result:'within_reference'},
      {name:'Coating thickness',unit:'um',value:'14.000001',
        result:'within_reference'},
      {name:'Coating thickness',unit:'um',value:'14.000002',
        result:'above_reference'},
      {name:'coating thickness',unit:'um',value:'13.000000',
        result:'within_reference'},
      {name:'Coating thickness',unit:'mm',value:'13.000000',
        result:'no_reference'},
      {name:'Unspecified coating',unit:'um',value:'13.000000',
        result:'no_reference'},
      {name:'Coating mass',unit:'g',value:'0.499999',
        result:'below_reference'},
      {name:'Coating mass',unit:'g',value:'100.000000',
        result:'within_reference'},
    ] as const;
    const ids:string[]=[];
    for(const item of cases){
      const id=randomUUID();ids.push(id);
      const response=await post('/planning/batches/'+batch+
        '/steps/1/inspections',{
          observationId:id,kind:'measurement',characteristic:item.name,
          observedValue:item.value,observedUnit:item.unit,
          attentionRequired:false,
        });
      expect(response.statusCode).toBe(201);
    }
    const history=await get('/planning/batches/'+batch+'/inspections');
    expect(history.statusCode).toBe(200);
    for(const [index,item] of cases.entries()){
      const row=history.json().observations.find((o:{id:string})=>o.id===ids[index]);
      expect(row.referenceComparison).toBe(item.result);
      expect(row.observedValue).toBe(item.value);
      expect(row.referenceCriterionId===null).toBe(item.result==='no_reference');
      if(item.name.toLowerCase()==='coating thickness'&&item.unit==='um'){
        expect(row.referenceLowerLimit).toBe('12.000001');
        expect(row.referenceUpperLimit).toBe('14.000001');
      }
    }
    const b=await pool.query(`SELECT status FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[org,batch]);
    expect(b.rows[0].status).toBe('in_progress');
    const evidence=await pool.query(`SELECT count(*)::int AS n FROM production_step_evidence
      WHERE organization_id=$1 AND batch_id=$2`,[org,batch]);
    expect(evidence.rows[0].n).toBe(0);
  });
});
