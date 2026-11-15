import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    expect(await comparison()).toEqual({status:'no_source',sourceCount:0,withdrawnSourceCount:0,source:null,difference:null});
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
      status:'multiple_sources',sourceCount:2,withdrawnSourceCount:0,source:null,difference:null,
    });
  });

  it('withdraws an incorrect reference with an immutable reason while preserving the original',async()=>{
    const b=await scenario('cutting','pieces');await complete(b,'100');
    const source=await link(b,'cut_run','cut_good_pieces','99');
    const url='/planning/batches/'+b.id+'/journal-links/'+source.linkId+'/withdraw';
    const payload={withdrawalId:randomUUID(),reason:'Wrong local run selected'};
    expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url,headers:headers(1),payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:headers(2),payload})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url,headers:headers(),payload:{...payload,reason:' '}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url,headers:headers(),payload:{...payload,withdrawnBy:users[2]}})).statusCode).toBe(400);
    const simultaneous=await Promise.all([1,2].map(()=>app.inject({method:'POST',url,headers:headers(),payload})));
    expect(simultaneous.map(r=>r.statusCode).sort()).toEqual([200,201]);
    const retried=await post(url,payload,200);
    expect(retried.alreadyRecorded).toBe(true);
    const changed=await app.inject({method:'POST',url,headers:headers(),payload:{...payload,reason:'Changed story'}});
    expect(changed.statusCode).toBe(409);
    const history=await app.inject({method:'GET',url:'/planning/batches/'+b.id+'/journal-links',headers:headers()});
    expect(history.json().links[0]).toMatchObject({id:source.linkId,sourceEntryId:source.sourceEntryId,
      sourceMeasure:{value:'99.000000'},withdrawal:{id:payload.withdrawalId,reason:payload.reason,withdrawnBy:users[0]}});
    expect((await read(b.id)).json().steps[0].sourceComparison).toMatchObject({
      status:'no_source',sourceCount:0,withdrawnSourceCount:1,source:null,difference:null});
    // Reapplying the additive migration must preserve both existing ledgers.
    await pool.query(await readFile('migrations/018_m2_local_source_withdrawals.sql','utf8'));
    expect((await pool.query(`SELECT reason FROM production_local_journal_withdrawals
      WHERE organization_id=$1 AND id=$2`,[org,payload.withdrawalId])).rows[0].reason).toBe(payload.reason);
    await post('/planning/batches/'+b.id+'/steps/1/journal-links',{
      linkId:source.linkId,sourceEntryId:source.sourceEntryId,sourceKind:'cut_run',sourceStage:'cutting',
      sourceCreatedAt:'2026-11-10T10:00:00Z',summary:'Local fixture reference',
      sourceMeasure:{kind:'cut_good_pieces',value:'99'},
    },200);
    expect((await read(b.id)).json().steps[0].sourceComparison.sourceCount).toBe(0);
    await expect(pool.query(`UPDATE production_local_journal_withdrawals SET reason='changed'
      WHERE organization_id=$1 AND id=$2`,[org,payload.withdrawalId])).rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_local_journal_withdrawals
      WHERE organization_id=$1 AND id=$2`,[org,payload.withdrawalId])).rejects.toThrow('append-only');
    expect((await pool.query('SELECT status FROM production_batches WHERE organization_id=$1 AND id=$2',[org,b.id])).rows[0].status)
      .toBe('in_progress');
  });

  it('resolves ambiguity explicitly, serializes competing withdrawals and permits audit corrections after completion',async()=>{
    const b=await scenario('assembly','cells');await complete(b,'100');
    const first=await link(b,'assembly_run','assembled_cells_out','100');
    const second=await link(b,'assembly_run','assembled_cells_out','90');
    await post('/planning/batches/'+b.id+'/status',{expectedStatus:'in_progress',status:'completed'},200);
    const url='/planning/batches/'+b.id+'/journal-links/'+second.linkId+'/withdraw';
    const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url,headers:headers(),
      payload:{withdrawalId:randomUUID(),reason:'Duplicate reference'}})));
    expect(responses.map(r=>r.statusCode).sort()).toEqual([201,409]);
    const comparison=(await read(b.id)).json().steps[0].sourceComparison;
    expect(comparison).toMatchObject({status:'compared',sourceCount:1,withdrawnSourceCount:1,difference:'0.000000',
      source:{linkId:first.linkId}});
    const original=(await pool.query(`SELECT status FROM production_batches WHERE organization_id=$1 AND id=$2`,[org,b.id])).rows[0];
    expect(original.status).toBe('completed');
    const other=await scenario('assembly','cells');
    expect((await app.inject({method:'POST',url:'/planning/batches/'+other.id+'/journal-links/'+first.linkId+'/withdraw',
      headers:headers(),payload:{withdrawalId:randomUUID(),reason:'Wrong batch'}})).statusCode).toBe(404);
  });

  it('atomically replaces a withdrawn source, preserves lineage and handles retries after completion',async()=>{
    const b=await scenario('cutting','pieces');await complete(b,'100');
    const original=await link(b,'cut_run','cut_good_pieces','90');
    const url='/planning/batches/'+b.id+'/steps/1/journal-links';
    const payload={linkId:randomUUID(),sourceEntryId:randomUUID(),sourceKind:'cut_run',sourceStage:'cutting',
      sourceCreatedAt:'2026-11-11T03:00:00Z',summary:'Correct saved run',
      sourceMeasure:{kind:'cut_good_pieces',value:'100'},replacesLinkId:original.linkId,replacementReason:'Wrong run was selected'};
    const submit=(body:object,actor=0)=>app.inject({method:'POST',url,headers:headers(actor),payload:body});
    expect((await submit(payload)).statusCode).toBe(409); // Must first withdraw explicitly.
    await post('/planning/batches/'+b.id+'/journal-links/'+original.linkId+'/withdraw',{
      withdrawalId:randomUUID(),reason:'Wrong saved run'});
    expect((await submit(payload,1)).statusCode).toBe(403);
    expect((await submit(payload,2)).statusCode).toBe(404);
    expect((await submit({...payload,replacementReason:' '})).statusCode).toBe(400);
    expect((await submit({...payload,replacementReason:undefined})).statusCode).toBe(400);
    expect((await submit({...payload,sourceKind:'journal',sourceMeasure:undefined})).statusCode).toBe(409);
    expect((await submit({...payload,sourceEntryId:original.sourceEntryId})).statusCode).toBe(409);
    expect((await pool.query('SELECT id FROM production_local_journal_links WHERE organization_id=$1 AND id=$2',[org,payload.linkId])).rowCount).toBe(0);
    const race=await Promise.all([submit(payload),submit(payload)]);
    expect(race.map(r=>r.statusCode).sort()).toEqual([200,201]);
    expect((await submit({...payload,replacementReason:'Rewritten reason'})).statusCode).toBe(409);
    expect((await submit({...payload,replacesLinkId:undefined,replacementReason:undefined})).statusCode).toBe(409);
    expect((await submit({...payload,linkId:randomUUID(),sourceEntryId:randomUUID()})).statusCode).toBe(409);
    const flow=(await read(b.id)).json().steps[0].sourceComparison;
    expect(flow).toMatchObject({status:'compared',sourceCount:1,withdrawnSourceCount:1,difference:'0.000000',source:{linkId:payload.linkId}});
    const history=(await app.inject({method:'GET',url:'/planning/batches/'+b.id+'/journal-links',headers:headers()})).json().links;
    expect(history.find((r:{id:string})=>r.id===original.linkId)).toMatchObject({replacedBy:payload.linkId,withdrawal:{reason:'Wrong saved run'},sourceMeasure:{value:'90.000000'}});
    expect(history.find((r:{id:string})=>r.id===payload.linkId)).toMatchObject({replacementOf:{linkId:original.linkId,reason:payload.replacementReason,recordedBy:users[0]}});
    await post('/planning/batches/'+b.id+'/status',{expectedStatus:'in_progress',status:'completed'},200);
    expect((await submit(payload)).statusCode).toBe(200);
    await post('/planning/batches/'+b.id+'/journal-links/'+payload.linkId+'/withdraw',{withdrawalId:randomUUID(),reason:'Audit after completion'});
    expect((await submit(payload)).statusCode).toBe(200); // Never reactivates the replacement.
    expect((await read(b.id)).json().steps[0].sourceComparison.sourceCount).toBe(0);
    expect((await submit({...payload,linkId:randomUUID(),sourceEntryId:randomUUID(),replacesLinkId:payload.linkId})).statusCode).toBe(409);
    await expect(pool.query(`UPDATE production_local_journal_replacements SET reason='Changed'
      WHERE organization_id=$1 AND replacement_link_id=$2`,[org,payload.linkId])).rejects.toThrow('append-only');
    await expect(pool.query(`DELETE FROM production_local_journal_replacements
      WHERE organization_id=$1 AND replacement_link_id=$2`,[org,payload.linkId])).rejects.toThrow('append-only');
    await pool.query(await readFile('migrations/019_m2_local_source_replacements.sql','utf8'));
    expect((await pool.query(`SELECT reason FROM production_local_journal_replacements WHERE organization_id=$1 AND replacement_link_id=$2`,[org,payload.linkId])).rows[0].reason).toBe(payload.replacementReason);
  });

  it('rejects cross-batch replacement and rolls back failed replacement source inserts',async()=>{
    const b=await scenario('cutting','pieces'),other=await scenario('cutting','pieces');
    const original=await link(b,'cut_run','cut_good_pieces','99');
    await post('/planning/batches/'+b.id+'/journal-links/'+original.linkId+'/withdraw',{withdrawalId:randomUUID(),reason:'Wrong source'});
    const payload={linkId:randomUUID(),sourceEntryId:randomUUID(),sourceKind:'cut_run',sourceStage:'cutting',
      sourceCreatedAt:'2026-11-11T03:00:00Z',summary:'Replacement',replacesLinkId:original.linkId,replacementReason:'Correct record'};
    expect((await app.inject({method:'POST',url:'/planning/batches/'+other.id+'/steps/1/journal-links',headers:headers(),payload})).statusCode).toBe(409);
    expect((await pool.query('SELECT id FROM production_local_journal_links WHERE organization_id=$1 AND id=$2',[org,payload.linkId])).rowCount).toBe(0);
    await post('/planning/batches/'+b.id+'/steps/1/journal-links',payload);
    expect((await read(b.id)).json().steps[0].sourceComparison).toMatchObject({status:'no_source',sourceCount:0}); // No invented quantity.
    const foreignOriginal=await link(other,'cut_run','cut_good_pieces','98');
    await post('/planning/batches/'+other.id+'/journal-links/'+foreignOriginal.linkId+'/withdraw',{withdrawalId:randomUUID(),reason:'Wrong source'});
    await expect(pool.query(`INSERT INTO production_local_journal_replacements
      (organization_id,original_link_id,replacement_link_id,reason,recorded_by)
      VALUES($1,$2,$3,'Wrong batch',$4)`,[org,foreignOriginal.linkId,payload.linkId,users[0]])).rejects.toThrow('scope mismatch');
  });
});
