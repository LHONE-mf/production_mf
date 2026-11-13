import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;

integration('Storage material/location discovery (disposable PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),otherOrg=randomUUID(),chief=randomUUID(),worker=randomUUID();
  const chiefToken=randomBytes(32).toString('base64url');
  const workerToken=randomBytes(32).toString('base64url');
  const keys=generateKeyPairSync('ed25519');
  let chiefDevice='',workerDevice='',chiefProof='',workerProof='';

  const headers=(token:string,proof='')=>({
    authorization:'Bearer '+token,...(proof?{'x-device-proof':proof}:{}),
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
    });
    const access=await post('/inventory/access',{changeId:randomUUID(),
      deviceId:chiefDevice,userId:worker,level:'operator',action:'grant'});
    expect(access.statusCode,access.body).toBe(201);
    expect((await get(url,workerToken,workerProof)).statusCode).toBe(200);
    expect((await get('/inventory/access/me?deviceId='+workerDevice,workerToken,workerProof)).json())
      .toMatchObject({level:'operator',canManageCatalog:false,canCorrectStock:false});
    expect((await get('/inventory/materials?deviceId='+chiefDevice,workerToken,workerProof)).statusCode).toBe(403);
    expect((await get('/inventory/materials?deviceId=invalid',workerToken,workerProof)).statusCode).toBe(400);
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
