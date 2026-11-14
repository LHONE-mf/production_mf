import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('Storage authoritative receipt API (disposable PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),chief=randomUUID(),worker=randomUUID();
  const adminToken=randomBytes(32).toString('base64url');
  const workerToken=randomBytes(32).toString('base64url');
  const keys=generateKeyPairSync('ed25519');
  const headers=(token:string,proof?:string)=>({
    authorization:'Bearer '+token,...(proof?{'x-device-proof':proof}:{}),
  });
  let deviceId='',adminProof='',workerProof='',workerDevice='';
  const post=(url:string,payload:object,token=adminToken,proof=adminProof)=>
    app.inject({method:'POST',url,headers:headers(token,proof),payload});
  const get=(url:string,token=adminToken,proof=adminProof)=>
    app.inject({method:'GET',url,headers:headers(token,proof)});
  const materialId=randomUUID(),warehouseId=randomUUID(),cabinetId=randomUUID(),shelfId=randomUUID();
  const receipt=(stockId=randomUUID(),opId=randomUUID())=>({
    operationId:opId,stockId,deviceId:workerDevice,materialId,locationId:shelfId,
    manufacturerLot:'Supplier-2026-04',quantity:2_125_000,
    expectedRevision:0,reason:'Measured package and goods document #42',
  });

  async function enroll(userId:string,token:string) {
    const enrolled=await post('/devices',{userId,publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString()},
      adminToken,'');
    expect(enrolled.statusCode,enrolled.body).toBe(201);
    const id=enrolled.json().id as string;
    const challenge=await post('/devices/challenge',{deviceId:id},token,'');
    expect(challenge.statusCode,challenge.body).toBe(200);
    const {challengeId,challenge:nonce}=challenge.json();
    const signature=sign(null,Buffer.from('production-mf:device-proof:v1:'+nonce),keys.privateKey).toString('base64url');
    const grant=await post('/devices/challenge/verify',{deviceId:id,challengeId,challenge:nonce,signature},token,'');
    expect(grant.statusCode,grant.body).toBe(200);
    return {id,proof:grant.json().proofToken as string};
  }

  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/production_mf_ci')
      throw new Error('Refusing non-disposable database');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[org,'Disposable Storage test']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$3,$4,'test-only','chief'),($2,$3,$5,'test-only','worker')`,
      [chief,worker,org,'chief-'+chief,'worker-'+worker]);
    for(const [id,token] of [[chief,adminToken],[worker,workerToken]]) {
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),org,id,tokenHash(token)]);
    }
    ({id:deviceId,proof:adminProof}=await enroll(chief,adminToken));
    ({id:workerDevice,proof:workerProof}=await enroll(worker,workerToken));
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('requires an authenticated authorized device, then grants scoped warehouse permission',async()=>{
    expect((await get('/inventory/stocks?deviceId='+workerDevice,workerToken,workerProof)).statusCode).toBe(403);
    expect((await get('/inventory/stocks?deviceId='+deviceId,adminToken,'')).statusCode).toBe(403);
    expect((await get('/inventory/stocks?deviceId='+deviceId,'invalid','')).statusCode).toBe(401);
    const changeId=randomUUID();
    const request={changeId,deviceId,userId:worker,level:'operator',action:'grant'};
    const grant=await post('/inventory/access',request);
    expect(grant.statusCode,grant.body).toBe(201);
    const duplicate=await post('/inventory/access',request);
    expect(duplicate.statusCode,duplicate.body).toBe(200);
    expect((await post('/inventory/access',{...request,level:'manager'})).statusCode).toBe(409);
    expect((await get('/inventory/stocks?deviceId='+workerDevice,workerToken,workerProof)).statusCode).toBe(200);
    expect((await post('/inventory/access',{...request,changeId:randomUUID()},
      workerToken,workerProof)).statusCode).toBe(403);
  });

  it('creates explicit material and location hierarchy with server-side permission',async()=>{
    const material=await post('/inventory/materials',{
      deviceId,id:materialId,code:'NMC-811',name:'Cathode active powder',
      category:'raw_material',baseUnit:'mg'});
    expect(material.statusCode,material.body).toBe(201);
    expect((await post('/inventory/materials',{
      deviceId:workerDevice,id:randomUUID(),code:'UNAUTHORIZED',name:'Powder',
      category:'raw_material',baseUnit:'mg'},workerToken,workerProof)).statusCode).toBe(403);
    for(const entry of [
      {id:warehouseId,parentId:null,label:'Warehouse',kind:'warehouse'},
      {id:cabinetId,parentId:warehouseId,label:'Cabinet 1',kind:'cabinet'},
      {id:shelfId,parentId:cabinetId,label:'Shelf B',kind:'shelf'},
    ]) {
      const saved=await post('/inventory/locations',{deviceId,...entry});
      expect(saved.statusCode,saved.body).toBe(201);
    }
    expect((await post('/inventory/locations',{deviceId,id:randomUUID(),parentId:null,
      label:'Invalid isolated shelf',kind:'shelf'})).statusCode).toBe(400);
  });

  it('posts a quarantined stock receipt once and returns an immutable exact-retry snapshot',async()=>{
    const input=receipt(),first=await post('/inventory/receipts',input,workerToken,workerProof);
    expect(first.statusCode,first.body).toBe(201);
    expect(first.json().stock).toMatchObject({stockId:input.stockId,
      manufacturerLot:'Supplier-2026-04',onHand:2_125_000,reserved:0,
      available:2_125_000,quality:'quarantine',unit:'mg',revision:1});
    const retry=await post('/inventory/receipts',Object.fromEntries(Object.entries(input).reverse()),
      workerToken,workerProof);
    expect(retry.statusCode,retry.body).toBe(200);
    expect(retry.json().stock).toEqual(first.json().stock);
    const altered=await post('/inventory/receipts',{...input,quantity:1_000_000},workerToken,workerProof);
    expect(altered.statusCode,altered.body).toBe(409);
    expect(altered.json()).toEqual({error:'operation_id_reused'});
    const duplicateStock=await post('/inventory/receipts',receipt(input.stockId),workerToken,workerProof);
    expect(duplicateStock.statusCode,duplicateStock.body).toBe(409);
    const list=await get('/inventory/stocks?deviceId='+workerDevice,workerToken,workerProof);
    expect(list.statusCode,list.body).toBe(200);
    expect(list.json().stocks).toContainEqual(first.json().stock);
    const recorded=await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2',
      [org,input.stockId]);
    expect(recorded.rows[0].n).toBe(1);
  });

  it('replicates only confirmed receipts with stable cursors to two authorized devices',async()=>{
    const url='/inventory/changes?deviceId='+workerDevice+'&cursor=0&limit=1';
    const workerFeed=await get(url,workerToken,workerProof);
    expect(workerFeed.statusCode,workerFeed.body).toBe(200);
    expect(workerFeed.json().changes).toHaveLength(1);
    expect(workerFeed.json().changes[0]).toMatchObject({
      kind:'receive',stock:{quality:'quarantine',revision:1,onHand:2_125_000},
      deviceId:workerDevice,quantity:2_125_000,actorId:expect.any(String),reason:expect.any(String),
    });
    const cursor=workerFeed.json().nextCursor as number;
    expect(Number.isSafeInteger(cursor)).toBe(true);
    const chiefFeed=await get('/inventory/changes?deviceId='+deviceId+'&cursor=0&limit=1');
    expect(chiefFeed.statusCode,chiefFeed.body).toBe(200);
    expect(chiefFeed.json().changes).toEqual(workerFeed.json().changes);
    const replay=await get('/inventory/changes?deviceId='+workerDevice+'&cursor='+cursor,
      workerToken,workerProof);
    expect(replay.statusCode,replay.body).toBe(200);
    expect(replay.json()).toMatchObject({changes:[],nextCursor:cursor,hasMore:false});
    const future=await get('/inventory/changes?deviceId='+workerDevice+'&cursor='+(cursor+10000),
      workerToken,workerProof);
    expect(future.statusCode).toBe(409);
  });

  it('rejects missing catalog identities and invalid stock quantities without ledger writes',async()=>{
    const invalid=receipt();
    for(const quantity of [-1,0,0.5,1e18]) {
      const result=await post('/inventory/receipts',{...invalid,quantity},workerToken,workerProof);
      expect(result.statusCode).toBe(400);
    }
    expect((await post('/inventory/receipts',{...receipt(),materialId:randomUUID()},workerToken,workerProof)).statusCode).toBe(404);
    expect((await post('/inventory/receipts',{...receipt(),locationId:randomUUID()},workerToken,workerProof)).statusCode).toBe(404);
    const attempts=await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE operation_id=$1',[invalid.operationId]);
    expect(attempts.rows[0].n).toBe(0);
  });

  it('serializes competing device submissions and denies revoked warehouse access',async()=>{
    const id=randomUUID();
    const [a,b]=await Promise.all([
      post('/inventory/receipts',receipt(id),workerToken,workerProof),
      post('/inventory/receipts',receipt(id),workerToken,workerProof),
    ]);
    expect([a.statusCode,b.statusCode].sort()).toEqual([201,409]);
    expect((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE stock_id=$1',[id])).rows[0].n).toBe(1);
    const revoke=await post('/inventory/access',{changeId:randomUUID(),deviceId,userId:worker,
      level:'operator',action:'revoke'});
    expect(revoke.statusCode,revoke.body).toBe(201);
    expect((await get('/inventory/stocks?deviceId='+workerDevice,workerToken,workerProof)).statusCode).toBe(403);
    expect((await post('/inventory/receipts',receipt(),workerToken,workerProof)).statusCode).toBe(403);
  });
});
