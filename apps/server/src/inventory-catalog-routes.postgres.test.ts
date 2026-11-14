import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;

integration('Storage material/location discovery (disposable PostgreSQL)',()=>{
  const applicationName='inventory-admin-'+randomUUID();
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL,application_name:applicationName});
  const app=buildApp(pool);
  const epoch=randomUUID();
  const org=randomUUID(),otherOrg=randomUUID(),chief=randomUUID(),worker=randomUUID();
  const chiefToken=randomBytes(32).toString('base64url');
  const workerToken=randomBytes(32).toString('base64url');
  const keys=generateKeyPairSync('ed25519');
  let chiefDevice='',workerDevice='',chiefProof='',workerProof='';

  const headers=(token:string,proof='')=>({
    authorization:'Bearer '+token,'x-inventory-epoch':epoch,...(proof?{'x-device-proof':proof}:{}),
  });
  const post=(url:string,payload:object,token=chiefToken,proof=chiefProof)=>
    app.inject({method:'POST',url,headers:headers(token,proof),payload});
  const get=(url:string,token=chiefToken,proof=chiefProof)=>
    app.inject({method:'GET',url,headers:headers(token,proof)});

  async function enroll(userId:string,token:string){
    const registered=await post('/devices',{
      userId,publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),
    },chiefToken,'');
    expect(registered.statusCode,registered.body).toBe(201);
    const deviceId=registered.json().id as string;
    const issued=await post('/devices/challenge',{deviceId},token,'');
    expect(issued.statusCode,issued.body).toBe(200);
    const {challengeId,challenge}=issued.json();
    const signature=sign(null,Buffer.from('production-mf:device-proof:v1:'+challenge),
      keys.privateKey).toString('base64url');
    const verified=await post('/devices/challenge/verify',
      {deviceId,challengeId,challenge,signature},token,'');
    expect(verified.statusCode,verified.body).toBe(200);
    return {deviceId,proof:verified.json().proofToken as string};
  }

  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||
        url.pathname!=='/production_mf_ci')
      throw new Error('Refusing non-disposable database');
    const db=await pool.query('SELECT current_database() AS name');
    expect(db.rows[0].name).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$3),($2,$4)',
      [org,otherOrg,'Warehouse catalogue test','Unrelated organization']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$3,$4,'test-only','chief'),($2,$3,$5,'test-only','worker')`,
      [chief,worker,org,'chief-'+chief,'worker-'+worker]);
    for(const [id,token] of [[chief,chiefToken],[worker,workerToken]]){
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),org,id,tokenHash(token)]);
    }
    await pool.query('INSERT INTO inventory_streams(organization_id,epoch) VALUES($1,$2)',[org,epoch]);
    ({deviceId:chiefDevice,proof:chiefProof}=await enroll(chief,chiefToken));
    ({deviceId:workerDevice,proof:workerProof}=await enroll(worker,workerToken));
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('requires session, inventory grant and actor-bound proof for catalog reads',async()=>{
    const url='/inventory/materials?deviceId='+workerDevice;
    expect((await get(url,workerToken,workerProof)).statusCode).toBe(403);
    expect((await get(url,'invalid',workerProof)).statusCode).toBe(401);
    expect((await get('/inventory/locations?deviceId='+chiefDevice,chiefToken,'')).statusCode).toBe(403);
    expect((await get('/inventory/access/me?deviceId='+chiefDevice)).json()).toMatchObject({
      level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,
      correctionRoleEligible:true,offlineView:{organizationId:org,actorId:chief,deviceId:chiefDevice,issuedAt:expect.any(String),expiresAt:expect.any(String)},
    });
    const access=await post('/inventory/access',{changeId:randomUUID(),
      deviceId:chiefDevice,userId:worker,level:'operator',action:'grant'});
    expect(access.statusCode,access.body).toBe(201);
    expect((await get(url,workerToken,workerProof)).statusCode).toBe(200);
    expect((await get('/inventory/access/me?deviceId='+workerDevice,workerToken,workerProof)).json())
      .toMatchObject({level:'operator',canManageCatalog:false,canCorrectStock:false,
        correctionRoleEligible:false});
    expect((await get('/inventory/materials?deviceId='+chiefDevice,workerToken,workerProof)).statusCode).toBe(403);
    expect((await get('/inventory/materials?deviceId=invalid',workerToken,workerProof)).statusCode).toBe(400);
  });

  it('bounds cached view access by the original session and returns no authentication secret',async()=>{
    const prior=(await pool.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[tokenHash(chiefToken)])).rows[0].expires_at;
    try{
      const expiry=(await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 minute' WHERE token_hash=$1 RETURNING expires_at",[tokenHash(chiefToken)])).rows[0].expires_at;
      const response=await get('/inventory/access/me?deviceId='+chiefDevice);
      expect(response.statusCode,response.body).toBe(200);
      const grant=response.json().offlineView;
      expect(grant).toMatchObject({organizationId:org,actorId:chief,deviceId:chiefDevice});
      expect(Date.parse(grant.expiresAt)).toBe(expiry.getTime());
      expect(Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt)).toBeLessThanOrEqual(60000);
      expect(response.body).not.toContain(chiefToken);expect(response.body).not.toContain(chiefProof);
    }finally{await pool.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1',[tokenHash(chiefToken),prior]);}
  });

  it('lists exact authorized material and location catalogues with stable cursor pages',async()=>{
    const materialIds=[randomUUID(),randomUUID(),randomUUID()];
    for(let i=0;i<materialIds.length;i++){
      const created=await post('/inventory/materials',{deviceId:chiefDevice,id:materialIds[i],
        code:'CAT-'+materialIds[i],name:'Material '+i,category:'raw_material',
        baseUnit:'mg'});
      expect(created.statusCode,created.body).toBe(201);
    }
    const foreignId=randomUUID();
    await pool.query('INSERT INTO inventory_materials (id,organization_id,material_code,display_name,category,base_unit) VALUES($1,$2,$3,$4,$5,$6)',
      [foreignId,otherOrg,'FOREIGN','Do not expose','component','pieces']);

    const first=await get('/inventory/materials?deviceId='+workerDevice+'&limit=2',
      workerToken,workerProof);
    expect(first.statusCode,first.body).toBe(200);
    expect(first.json().materials).toHaveLength(2);
    expect(first.json().hasMore).toBe(true);
    const second=await get('/inventory/materials?deviceId='+workerDevice+
      '&limit=2&after='+first.json().nextAfter,workerToken,workerProof);
    expect(second.statusCode,second.body).toBe(200);
    expect(second.json().materials).toHaveLength(1);
    expect(second.json().hasMore).toBe(false);
    const combined=[...first.json().materials,...second.json().materials];
    expect(combined.map((x:{id:string})=>x.id))
      .toEqual([...materialIds].sort());
    expect(combined.some((x:{id:string})=>x.id===foreignId)).toBe(false);
    expect(combined[0]).toMatchObject({category:'raw_material',baseUnit:'mg'});

    const warehouse=randomUUID(),cabinet=randomUUID(),shelf=randomUUID();
    for(const l of [
      {id:warehouse,parentId:null,label:'Warehouse',kind:'warehouse'},
      {id:cabinet,parentId:warehouse,label:'Cabinet',kind:'cabinet'},
      {id:shelf,parentId:cabinet,label:'Shelf',kind:'shelf'},
    ]){
      const created=await post('/inventory/locations',{deviceId:chiefDevice,...l});
      expect(created.statusCode,created.body).toBe(201);
    }
    const locations=await get('/inventory/locations?deviceId='+workerDevice+'&limit=3',
      workerToken,workerProof);
    expect(locations.statusCode,locations.body).toBe(200);
    expect(locations.json().locations).toHaveLength(3);
    const leaf=locations.json().locations.find((x:{id:string})=>x.id===shelf);
    expect(leaf).toMatchObject({id:shelf,parentId:cabinet,active:true});
    expect((await get('/inventory/locations?deviceId='+workerDevice+
      '&after=wrong',workerToken,workerProof)).statusCode).toBe(400);
  });

  it('replays exact catalogue creation after a lost acknowledgement and retains immutable actor/device audit',async()=>{
    const body={deviceId:chiefDevice,id:randomUUID(),code:'IDEMP-'+randomUUID(),name:'Repeated exact creation',category:'component',baseUnit:'pieces'};
    const first=await post('/inventory/materials',body);
    expect(first.statusCode,first.body).toBe(201);
    const retry=await post('/inventory/materials',body);
    expect(retry.statusCode,retry.body).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await post('/inventory/materials',{...body,name:'Changed intent'})).statusCode).toBe(409);
    expect((await post('/inventory/materials',{...body,id:randomUUID()},workerToken,workerProof)).statusCode).toBe(403);
    const audit=await pool.query('SELECT actor_id,device_id,request_payload,result_payload FROM inventory_catalog_events WHERE change_id=$1',[body.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({actor_id:chief,device_id:chiefDevice,request_payload:body,result_payload:first.json()});
    await expect(pool.query('DELETE FROM inventory_catalog_events WHERE change_id=$1',[body.id])).rejects.toThrow('immutable');
    const root={deviceId:chiefDevice,id:randomUUID(),parentId:null,label:'Retry warehouse',kind:'warehouse'};
    const created=await post('/inventory/locations',root);
    expect(created.statusCode,created.body).toBe(201);
    expect((await post('/inventory/locations',root)).statusCode).toBe(200);
    expect((await post('/inventory/locations',{...root,label:'Changed label'})).statusCode).toBe(409);
  });

  it('allows Chief alone to discover scoped effective warehouse grants with bounded pagination',async()=>{
    const route='/inventory/access/users?deviceId=';
    expect((await get(route+workerDevice,workerToken,workerProof)).statusCode).toBe(403);
    expect((await get(route+chiefDevice,chiefToken,'')).statusCode).toBe(403);
    expect((await get(route+chiefDevice+'&limit=101')).statusCode).toBe(400);
    const first=await get(route+chiefDevice+'&limit=1');
    expect(first.statusCode,first.body).toBe(200);
    expect(first.json().hasMore).toBe(true);
    const next=await get(route+chiefDevice+'&limit=1&after='+first.json().nextAfter);
    const rows=[...first.json().users,...next.json().users];
    expect(rows.map((row:{id:string})=>row.id).sort()).toEqual([chief,worker].sort());
    expect(rows.find((row:{id:string})=>row.id===worker)).toMatchObject({warehouseLevel:'operator',role:'worker',active:true});
    expect(rows.find((row:{id:string})=>row.id===chief)).toMatchObject({warehouseLevel:'chief'});
  });

  it('suspending inventory posting also prevents catalogue creation without side effects',async()=>{
    await get('/inventory/stream?deviceId='+chiefDevice);
    try {
      await pool.query('UPDATE inventory_streams SET posting_enabled=false WHERE organization_id=$1',[org]);
      const created=await post('/inventory/materials',{deviceId:chiefDevice,id:randomUUID(),code:'SUSPENDED',name:'Must not exist',category:'component',baseUnit:'pieces'});
      expect(created.statusCode,created.body).toBe(409);
      expect(created.json()).toEqual({error:'inventory_posting_suspended'});
      expect((await pool.query("SELECT count(*)::int AS n FROM inventory_materials WHERE organization_id=$1 AND material_code='SUSPENDED'",[org])).rows[0].n).toBe(0);
    } finally {await pool.query('UPDATE inventory_streams SET posting_enabled=true WHERE organization_id=$1',[org]);}
  });

  it('rechecks catalogue and grant authority after waiting for the real organization lock',async()=>{
    for(const path of ['/inventory/materials','/inventory/access']) {
      const blocker=await pool.connect();let pending:Promise<Awaited<ReturnType<typeof post>>>|undefined;
      const id=randomUUID();
      const body=path.endsWith('materials')?{deviceId:chiefDevice,id,code:'RACE-'+id,name:'Rejected after revocation',category:'component',baseUnit:'pieces'}:
        {deviceId:chiefDevice,changeId:id,userId:worker,level:'manager',action:'grant'};
      try{
        await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[org+':inventory-sequence']);
        await blocker.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[tokenHash(chiefToken)]);
        pending=Promise.resolve(post(path,body));const deadline=Date.now()+4000;
        while(!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_advisory_xact_lock(hashtextextended%' AND wait_event_type='Lock'",[applicationName])).rowCount){if(Date.now()>deadline)throw Error('Admin transaction did not reach authorization barrier');await new Promise(resolve=>setTimeout(resolve,10));}
        await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);
        expect((await pool.query('SELECT count(*)::int AS n FROM inventory_catalog_events WHERE change_id=$1',[id])).rows[0].n).toBe(0);
        expect((await pool.query('SELECT count(*)::int AS n FROM inventory_access_events WHERE id=$1',[id])).rows[0].n).toBe(0);
      }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await pool.query('UPDATE sessions SET revoked_at=NULL WHERE token_hash=$1',[tokenHash(chiefToken)]);}
    }
  },10000);

  it('requires an explicit manager grant, never grants manager powers to a production Master by role',async()=>{
    const body={deviceId:workerDevice,id:randomUUID(),code:'MANAGER-'+randomUUID(),name:'Manager-created',category:'component',baseUnit:'pieces'};
    try{
      await pool.query("UPDATE users SET role='master' WHERE id=$1",[worker]);
      expect((await post('/inventory/materials',body,workerToken,workerProof)).statusCode).toBe(403);
      expect((await post('/inventory/access',{deviceId:chiefDevice,changeId:randomUUID(),userId:worker,level:'manager',action:'grant'})).statusCode).toBe(201);
      expect((await post('/inventory/materials',body,workerToken,workerProof)).statusCode).toBe(201);
      expect((await get('/inventory/access/users?deviceId='+workerDevice,workerToken,workerProof)).statusCode).toBe(403);
      expect((await post('/inventory/access',{deviceId:workerDevice,changeId:randomUUID(),userId:chief,level:'manager',action:'grant'},workerToken,workerProof)).statusCode).toBe(403);
    }finally{
      await pool.query("UPDATE users SET role='worker' WHERE id=$1",[worker]);
      await post('/inventory/access',{deviceId:chiefDevice,changeId:randomUUID(),userId:worker,level:'operator',action:'grant'});
    }
  });

  it('reapplies additive catalogue audit migration without changing populated records or accepted history',async()=>{
    const tables=['inventory_materials','inventory_locations','inventory_stocks','inventory_operations','inventory_access','inventory_access_events','inventory_catalog_events'];
    async function snapshot(){const result:Record<string,string[]>={};for(const table of tables)result[table]=(await pool.query('SELECT row_to_json(t) AS row FROM '+table+' t WHERE organization_id=$1',[org])).rows.map(row=>JSON.stringify(row.row)).sort();return result;}
    const before=await snapshot(),migration=await readFile('migrations/023_inventory_catalog_audit.sql','utf8');
    await pool.query(migration);await pool.query(migration);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT device_id,epoch FROM inventory_access_events WHERE organization_id=$1 ORDER BY recorded_at DESC LIMIT 1',[org])).rows[0].device_id).toBe(chiefDevice);
  });

  it('revoking warehouse access immediately disables all discovery endpoints',async()=>{
    const revoked=await post('/inventory/access',{
      changeId:randomUUID(),deviceId:chiefDevice,userId:worker,
      level:'operator',action:'revoke',
    });
    expect(revoked.statusCode,revoked.body).toBe(201);
    for(const path of ['/inventory/materials','/inventory/locations','/inventory/access/me']){
      const result=await get(path+'?deviceId='+workerDevice,workerToken,workerProof);
      expect(result.statusCode,result.body).toBe(403);
    }
  });
});
