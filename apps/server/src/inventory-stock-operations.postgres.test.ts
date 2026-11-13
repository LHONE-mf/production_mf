import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';

// A disposable real PostgreSQL test. Never use this against a deployed system.
const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;

integration('Storage controlled stock operations (disposable PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL});
  const app=buildApp(pool);
  const org=randomUUID(),chief=randomUUID(),warehouseUser=randomUUID();
  const chiefToken=randomBytes(32).toString('base64url');
  const warehouseToken=randomBytes(32).toString('base64url');
  const keys=generateKeyPairSync('ed25519');
  let chiefDevice='',workerDevice='',chiefProof='',workerProof='';
  const headers=(token:string,proof='')=>({
    authorization:'Bearer '+token,...(proof?{'x-device-proof':proof}:{}),
  });
  const post=(url:string,payload:object,token=chiefToken,proof=chiefProof)=>
    app.inject({method:'POST',url,headers:headers(token,proof),payload});
  const get=(url:string,token=chiefToken,proof=chiefProof)=>
    app.inject({method:'GET',url,headers:headers(token,proof)});
  const materialId=randomUUID(),root=randomUUID(),shelfA=randomUUID(),shelfB=randomUUID();
  const stockId=randomUUID(),batchId=randomUUID();

  async function enroll(userId:string,token:string){
    const enrolled=await post('/devices',{
      userId,publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),
    },chiefToken,'');
    expect(enrolled.statusCode,enrolled.body).toBe(201);
    const deviceId=enrolled.json().id as string;
    const challenge=await post('/devices/challenge',{deviceId},token,'');
    expect(challenge.statusCode,challenge.body).toBe(200);
    const {challengeId,challenge:nonce}=challenge.json();
    const signature=sign(null,Buffer.from('production-mf:device-proof:v1:'+nonce),
      keys.privateKey).toString('base64url');
    const grant=await post('/devices/challenge/verify',
      {deviceId,challengeId,challenge:nonce,signature},token,'');
    expect(grant.statusCode,grant.body).toBe(200);
    return {deviceId,proof:grant.json().proofToken as string};
  }

  beforeAll(async()=>{
    const url=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||
      url.pathname!=='/production_mf_ci')
      throw new Error('Refusing non-disposable inventory test database');
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name)
      .toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [org,'Controlled stock operations test']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$3,$4,'test-only','chief'),($2,$3,$5,'test-only','worker')`,
      [chief,warehouseUser,org,'chief-'+chief,'worker-'+warehouseUser]);
    for(const [user,token] of [[chief,chiefToken],[warehouseUser,warehouseToken]]){
      await pool.query(`INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 minutes')`,
        [randomUUID(),org,user,tokenHash(token)]);
    }
    ({deviceId:chiefDevice,proof:chiefProof}=await enroll(chief,chiefToken));
    ({deviceId:workerDevice,proof:workerProof}=await enroll(warehouseUser,warehouseToken));
    await post('/inventory/access',{deviceId:chiefDevice,changeId:randomUUID(),
      userId:warehouseUser,level:'operator',action:'grant'});
    expect((await post('/inventory/materials',{
      id:materialId,deviceId:chiefDevice,code:'MAT-'+materialId,
      name:'Receiving test powder',category:'raw_material',baseUnit:'mg',
    })).statusCode).toBe(201);
    for(const l of [
      {id:root,parentId:null,label:'Warehouse',kind:'warehouse'},
      {id:shelfA,parentId:root,label:'Cabinet A',kind:'cabinet'},
      {id:shelfB,parentId:root,label:'Cabinet B',kind:'cabinet'},
    ]){
      const added=await post('/inventory/locations',{deviceId:chiefDevice,...l});
      expect(added.statusCode,added.body).toBe(201);
    }
  });
  afterAll(async()=>{await app.close();await pool.end();});

  const op=(kind:'transfer'|'adjust'|'reserve'|'release_reservation',
            expectedRevision:number,quantity:number,extras:Record<string,unknown>={})=>({
    operationId:randomUUID(),deviceId:workerDevice,kind,
    expectedRevision,quantity,reason:'Confirmed warehouse operation',...extras,
  });
  const send=(body:object,token=warehouseToken,proof=workerProof)=>
    post('/inventory/stocks/'+stockId+'/operations',body,token,proof);

  it('serializes all stock changes, audits exact retries, and protects reservations',async()=>{
    const input={operationId:randomUUID(),stockId,deviceId:workerDevice,
      materialId,locationId:shelfA,manufacturerLot:'LOT-42',quantity:2000,
      expectedRevision:0,reason:'Received sealed package'};
    const received=await post('/inventory/receipts',input,warehouseToken,workerProof);
    expect(received.statusCode,received.body).toBe(201);

    const full=op('transfer',1,2000,{toLocationId:shelfB});
    expect((await send(full,warehouseToken,'')).statusCode).toBe(403);
    expect((await send(op('adjust',1,1,{adjustment:'decrease'}))).statusCode).toBe(403);
    expect((await send(op('reserve',1,1,{
      reservationId:randomUUID(),productionBatchId:batchId
    }))).statusCode).toBe(403);
    const partial=await send(op('transfer',1,500,{toLocationId:shelfB}));
    expect(partial.statusCode,partial.body).toBe(400);
    const moved=await send(full);
    expect(moved.statusCode,moved.body).toBe(201);
    expect(moved.json().stock).toMatchObject({
      locationId:shelfB,onHand:2000,reserved:0,revision:2,
    });
    expect((await send(full)).statusCode).toBe(200);
    expect((await send({...full,operationId:randomUUID()})).json())
      .toMatchObject({error:'revision_conflict'});
    expect((await send({...full,toLocationId:shelfA})).json())
      .toMatchObject({error:'operation_id_reused'});

    const elevation=await post('/inventory/access',{deviceId:chiefDevice,
      changeId:randomUUID(),userId:warehouseUser,level:'manager',action:'grant'});
    expect(elevation.statusCode,elevation.body).toBe(201);
    const tooMuch=op('adjust',2,2001,{adjustment:'decrease'});
    expect((await send(tooMuch)).json()).toMatchObject({error:'insufficient_stock'});
    const correction=op('adjust',2,300,{adjustment:'decrease'});
    const corrected=await send(correction);
    expect(corrected.statusCode,corrected.body).toBe(201);
    expect(corrected.json().stock).toMatchObject({
      onHand:1700,reserved:0,available:1700,revision:3,
    });
    expect((await send(correction)).json()).toMatchObject({
      status:'duplicate',stock:{revision:3,onHand:1700},
    });
    expect((await send({...correction,quantity:400})).statusCode).toBe(409);

    // There is no production QA release endpoint yet. The disposable fixture
    // below represents an approved released-stock state solely to test the
    // reservation engine; it must never become a real application workflow.
    await pool.query(`UPDATE inventory_stocks SET quality='released'
      WHERE organization_id=$1 AND id=$2`,[org,stockId]);
    const routeId=randomUUID(),orderId=randomUUID();
    await pool.query(`INSERT INTO process_routes
      (organization_id,id,code,name,created_by) VALUES($1,$2,$3,'Test route',$4)`,
      [org,routeId,'R-'+routeId,chief]);
    await pool.query(`INSERT INTO process_route_versions
      (organization_id,route_id,version,state,approved_at,approved_by)
      VALUES($1,$2,1,'approved',now(),$3)`,[org,routeId,chief]);
    await pool.query(`INSERT INTO production_orders
      (organization_id,id,order_code,product_code,route_id,route_version,status,
        planned_quantity,quantity_unit,created_by)
      VALUES($1,$2,$3,'NMC',$4,1,'released',10,'kg',$5)`,
      [org,orderId,'O-'+orderId,routeId,chief]);
    await pool.query(`INSERT INTO production_batches
      (organization_id,id,order_id,batch_code,material_line,status,created_by)
      VALUES($1,$2,$3,$4,'cathode','created',$5)`,
      [org,batchId,orderId,'B-'+batchId,chief]);

    const reservationId=randomUUID();
    const initial=op('reserve',3,1000,{productionBatchId:batchId,reservationId});
    const reserved=await send(initial);
    expect(reserved.statusCode,reserved.body).toBe(201);
    expect(reserved.json().stock).toMatchObject({
      quality:'released',onHand:1700,reserved:1000,available:700,revision:4,
    });
    const concurrent=[
      op('reserve',4,500,{productionBatchId:batchId,reservationId:randomUUID()}),
      op('reserve',4,500,{productionBatchId:batchId,reservationId:randomUUID()}),
    ];
    const replies=await Promise.all(concurrent.map(sendBody=>send(sendBody)));
    expect(replies.map(x=>x.statusCode).sort()).toEqual([201,409]);
    const retry=await send(initial);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().stock.revision).toBe(4);

    const anotherBatch=op('release_reservation',5,300,{
      productionBatchId:randomUUID(),reservationId,
    });
    expect((await send(anotherBatch)).json())
      .toMatchObject({error:'reservation_not_found'});
    const releaseFirst=op('release_reservation',5,300,{
      productionBatchId:batchId,reservationId,
    });
    const released=await send(releaseFirst);
    expect(released.statusCode,released.body).toBe(201);
    expect(released.json().stock).toMatchObject({
      onHand:1700,reserved:1200,available:500,revision:6,
    });
    const releaseRest=op('release_reservation',6,700,{
      productionBatchId:batchId,reservationId,
    });
    expect((await send(releaseRest)).statusCode).toBe(201);
    expect((await pool.query(`SELECT count(*)::int AS n FROM inventory_reservations
      WHERE organization_id=$1 AND id=$2`,[org,reservationId])).rows[0].n).toBe(0);
    const final=await get('/inventory/stocks?deviceId='+workerDevice,
      warehouseToken,workerProof);
    expect(final.statusCode).toBe(200);
    expect(final.json().stocks.find((x:{stockId:string})=>x.stockId===stockId))
      .toMatchObject({onHand:1700,reserved:500,available:1200,revision:7});
    const ledger=await pool.query(`SELECT kind FROM inventory_operations
      WHERE organization_id=$1 AND stock_id=$2 ORDER BY sequence`,[org,stockId]);
    expect(ledger.rows.map(r=>r.kind)).toEqual([
      'receive','transfer','adjust','reserve','reserve',
      'release_reservation','release_reservation',
    ]);
    await expect(pool.query(`DELETE FROM inventory_operations
      WHERE organization_id=$1 AND stock_id=$2`,[org,stockId])).rejects.toThrow();
  });
});
