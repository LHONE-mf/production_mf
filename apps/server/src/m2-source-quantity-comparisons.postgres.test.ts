import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 local source quantity comparisons (PostgreSQL)', () => {
  const pool = new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app = buildApp(pool);
  const org=randomUUID(),foreignOrg=randomUUID();
  const users=[randomUUID(),randomUUID(),randomUUID()];
  const tokens=users.map(() => randomBytes(32).toString('base64url'));
  const headers=(actor=0) => ({authorization:'Bearer '+tokens[actor]});
  const post=async (url:string,payload:object,expected=201) => {
    const result=await app.inject({method:'POST',url,headers:headers(),payload});
    expect(result.statusCode,result.body).toBe(expected);
    return result.json();
  };
  const read=(id:string,actor=0) => app.inject({method:'GET',
    url:'/planning/batches/'+id+'/quantity-flow',headers:headers(actor)});
  async function scenario(stage:string,unit:string) {
    const line=stage==='assembly' ? 'cell' : 'cathode';
    const route=await post('/planning/routes',{code:randomUUID(),name:'Comparison fixture',
      steps:[{name:stage,stage,workshopId:'test',electrodeLine:line==='cell'?'common':line}]});
    await post('/planning/routes/'+route.id+'/versions/1/approve',{},200);
    const order=await post('/planning/orders',{orderCode:randomUUID(),productCode:'TEST',
      routeId:route.id,routeVersion:1,plannedQuantity:'100',quantityUnit:unit});
    await post('/planning/orders/'+order.id+'/release',{},200);
    const batch=await post('/planning/orders/'+order.id+'/batches',{
      batchCode:randomUUID(),materialLine:line,plannedQuantity:'100',quantityUnit:unit});
    await post('/planning/batches/'+batch.id+'/status',
      {expectedStatus:'created',status:'in_progress'},200);
    return {id:batch.id,stage,unit};
  }
  async function complete(b:{id:string;unit:string},quantity:string) {
    await post('/planning/batches/'+b.id+'/steps/1/evidence',{eventId:randomUUID(),kind:'started'});
    await post('/planning/batches/'+b.id+'/steps/1/evidence',
      {eventId:randomUUID(),kind:'completed',quantity,quantityUnit:b.unit});
  }
  async function link(b:{id:string;stage:string},kind:string,metric?:string,value='12.500001') {
    const linkId=randomUUID(),sourceEntryId=randomUUID();
    await post('/planning/batches/'+b.id+'/steps/1/journal-links',{
      linkId,sourceEntryId,sourceKind:kind,sourceStage:b.stage,
      sourceCreatedAt:'2026-11-10T10:00:00Z',summary:'Local fixture reference',
      ...(metric ? {sourceMeasure:{kind:metric,value}} : {}),
    });
    return {linkId,sourceEntryId};
  }
  beforeAll(async () => {
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname!=='/production_mf_ci')
      throw new Error('Source comparison tests require disposable PostgreSQL');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Source comparison fixture',foreignOrg,'Foreign fixture']);
    for (const [i,id] of users.entries()) {
      const tenant=i===2 ? foreignOrg:org;
      await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
        VALUES($1,$2,$3,'test-only',$4)`,[id,tenant,'source-'+id,i===1?'worker':'chief']);
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,[randomUUID(),tenant,id,tokenHash(tokens[i])]);
    }
    await pool.query("INSERT INTO workshops(organization_id,id,name) VALUES($1,'test','Test')",[org]);
  });
  afterAll(async () => {await app.close();await pool.end();});

  it.each([
    ['calendaring','m','calender_run','calendered_length_m','999999999999.999998','999999999999.999999','-0.000001'],
    ['cutting','pieces','cut_run','cut_good_pieces','100','99','1.000000'],
    ['assembly','cells','assembly_run','assembled_cells_out','100','100','0.000000'],
  ])('compares a single %s output reference with exact decimals',async (stage,unit,kind,metric,output,value,difference) => {
    const b=await scenario(stage,unit);
    await complete(b,output);
    const source=await link(b,kind,metric,value);
    // A generic narrative link is not a second quantity measurement.
    await link(b,'journal');
    const response=await read(b.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().steps).toHaveLength(1);
    expect(response.json().steps[0].sourceComparison).toMatchObject({
      status:'compared',sourceCount:1,difference,
      source:{...source,summary:'Local fixture reference',
        measure:{kind:metric,value:value.includes('.') ? value : value+'.000000'}},
    });
    expect((await read(b.id,1)).statusCode).toBe(403);
    expect((await read(b.id,2)).statusCode).toBe(404);
    const stored=await pool.query(`SELECT status FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[org,b.id]);
    expect(stored.rows[0].status).toBe('in_progress');
  });

  it('distinguishes absent references, missing output and incompatible units',async () => {
    const b=await scenario('calendaring','kg');
    const comparison=async () => (await read(b.id)).json().steps[0].sourceComparison;
    expect(await comparison()).toEqual({status:'no_source',sourceCount:0,source:null,difference:null});
    await link(b,'calender_run','calendered_length_m');
    expect(await comparison()).toMatchObject({status:'output_missing',difference:null});
    await complete(b,'10');
    expect(await comparison()).toMatchObject({status:'unit_mismatch',difference:null});
  });

  it.each([
    ['slurry','kg','mix_batch','dry_solids_kg'],
    ['coating','m','coat_run','coated_side_a_m'],
    ['sorting','pieces','sort_run','sort_input_good_pieces'],
  ])('keeps %s input/partial metrics informational even when units match',async (stage,unit,kind,metric) => {
    const b=await scenario(stage,unit);
    await complete(b,'100');
    await link(b,kind,metric,'100');
    expect((await read(b.id)).json().steps[0].sourceComparison).toMatchObject({
      status:'reference_only',sourceCount:1,difference:null,
      source:{measure:{kind:metric,value:'100.000000'}},
    });
  });

  it('never silently sums or chooses among several measured local references',async () => {
    const b=await scenario('cutting','pieces');
    await complete(b,'100');
    await link(b,'cut_run','cut_good_pieces','50');
    await link(b,'cut_run','cut_good_pieces','50');
    expect((await read(b.id)).json().steps[0].sourceComparison).toEqual({
      status:'multiple_sources',sourceCount:2,source:null,difference:null,
    });
  });
});
