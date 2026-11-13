import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('Storage authoritative ledger: transactions and two-device conflicts (PostgreSQL)',()=>{
  const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL,max:8});
  const app=buildApp(pool);
  const org=randomUUID(),foreignOrg=randomUUID();
  const chief=randomUUID(),worker=randomUUID(),foreign=randomUUID();
  const users=[chief,worker,foreign];
  const tokens=users.map(()=>randomBytes(32).toString('base64url'));
  const devices=[0,1,2,3].map(()=>({
    id:randomUUID(),proof:randomBytes(32).toString('base64url'),
  }));
  const deviceOwner=[0,0,1,2];
  const headers=(device=0)=>({
    authorization:'Bearer '+tokens[deviceOwner[device]],
    'x-device-proof':devices[device].proof,
  });
  const post=(url:string,body:object,device=0)=>app.inject({
    method:'POST',url,headers:headers(device),payload:body,
  });
  const read=(url:string,device=0)=>app.inject({method:'GET',url,headers:headers(device)});
  const authBody=(device=0)=>({operationId:randomUUID(),deviceId:devices[device].id});
  const material=randomUUID(),location=randomUUID(),otherLocation=randomUUID();
  const makeMaterial=()=>post('/storage/materials',{
    ...authBody(),id:material,name:'NMC powder',category:'raw',unit:'kg',
  });
  const makeLocation=(where:string,id:string)=>post('/storage/locations',{
    ...authBody(),id,warehouse:'Materials',cabinet:'Cabinet 1',shelf:where,container:'Container 4',
  });
  const receipt=async(quantity:string,device=0,lotId?:string)=>{
    const body={
      ...authBody(device),receiptId:randomUUID(),stockUnitId:randomUUID(),
      materialId:material,lotId:lotId??randomUUID(),
      manufacturerLotCode:'LOT-A',manufacturer:'Producer A',locationId:location,
      quantity,evidence:'Weighed on receiving; document 17',supplier:'Supplier X',
    };
    const response=await post('/storage/receipts',body,device);
    expect(response.statusCode).toBe(201);
    return {body,result:response.json()};
  };
  const stock=(stockId:string,device=0)=>read('/storage/stock?deviceId='+devices[device].id,device)
    .then(r=>{expect(r.statusCode).toBe(200);return r.json().items.find((x:{id:string})=>x.id===stockId);});
  const change=(stockId:string,command:'release'|'issue'|'move'|'reconcile',payload:object,device=0)=>
    post('/storage/stock/'+stockId+'/'+command,{...authBody(device),...payload},device);

  beforeAll(async()=>{
    const target=new URL(process.env.POSTGRES_TEST_URL!);
    if(!['localhost','127.0.0.1'].includes(target.hostname)||
      target.pathname!=='/production_mf_ci')
      throw Error('Storage tests refuse a non-disposable PostgreSQL database');
    const db=await pool.query('SELECT current_database() AS database');
    expect(db.rows[0].database).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [org,'Storage disposable tenant',foreignOrg,'Storage foreign tenant']);
    for(let i=0;i<users.length;i++){
      const tenant=i===2?foreignOrg:org;
      await pool.query("INSERT INTO users (id,organization_id,login,password_hash,role) VALUES($1,$2,$3,'test-only',$4)",
        [users[i],tenant,'storage-'+users[i],i===0?'chief':'worker']);
      await pool.query("INSERT INTO sessions (id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
        [randomUUID(),tenant,users[i],tokenHash(tokens[i])]);
    }
    for(let i=0;i<devices.length;i++){
      const tenant=deviceOwner[i]===2?foreignOrg:org,user=users[deviceOwner[i]];
      await pool.query('INSERT INTO devices(id,organization_id,user_id) VALUES($1,$2,$3)',
        [devices[i].id,tenant,user]);
      await pool.query("INSERT INTO device_proof_grants(token_hash,organization_id,user_id,device_id,session_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes')",
        [tokenHash(devices[i].proof),tenant,user,devices[i].id,tokenHash(tokens[deviceOwner[i]])]);
    }
    expect((await makeMaterial()).statusCode).toBe(201);
    expect((await makeLocation('Shelf 2',location)).statusCode).toBe(201);
    expect((await makeLocation('Shelf 3',otherLocation)).statusCode).toBe(201);
  });
  afterAll(async()=>{await app.close();await pool.end();});

  it('requires signed device proof and tenant identity for every shared stock read/write',async()=>{
    const missing=await app.inject({method:'GET',
      url:'/storage/stock?deviceId='+devices[0].id,
      headers:{authorization:'Bearer '+tokens[0]}});
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toBe('device_proof_required');
    expect((await read('/storage/stock?deviceId='+devices[0].id,3)).statusCode).toBe(403);
    const receiptBody={...authBody(3),receiptId:randomUUID(),stockUnitId:randomUUID(),
      materialId:material,lotId:randomUUID(),manufacturerLotCode:'FOREIGN',
      locationId:location,quantity:'1',evidence:'Foreign stock attempt'};
    expect((await post('/storage/receipts',receiptBody,3)).statusCode).toBe(404);
  });

  it('records separate receipts for the same manufacturer lot without fabricating released stock',async()=>{
    const lotId=randomUUID();
    const a=await receipt('2.125',0,lotId);
    const b=await receipt('3.500',0,lotId);
    const first=await stock(a.body.stockUnitId);
    const second=await stock(b.body.stockUnitId,1);
    expect(first).toMatchObject({manufacturerLotCode:'LOT-A',onHand:'2.125000',
      disposition:'quarantine',available:'0',unit:'kg'});
    expect(second).toMatchObject({onHand:'3.500000',receiptId:b.body.receiptId,
      disposition:'quarantine'});
    const replay=await post('/storage/receipts',a.body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({alreadyRecorded:true,receiptId:a.body.receiptId});
    expect((await post('/storage/receipts',{...a.body,quantity:'4.000'})).json())
      .toMatchObject({error:'operation_id_reused'});
    const entries=await pool.query('SELECT count(*)::int AS count FROM storage_ledger_entries WHERE organization_id=$1 AND stock_unit_id=$2',
      [org,a.body.stockUnitId]);
    expect(entries.rows[0].count).toBe(1);
  });

  it('serializes conflicting issues on separate devices and prevents negative stock',async()=>{
    const {body}=await receipt('10');
    const before=await stock(body.stockUnitId);
    expect((await change(body.stockUnitId,'issue',{
      expectedRevision:before.revision,quantity:'1',destination:'Slurry',
      reason:'Must be released first',
    })).json()).toMatchObject({error:'stock_not_released'});
    const released=await change(body.stockUnitId,'release',{
      expectedRevision:before.revision,reason:'Chief reviewed release evidence',
    });
    expect(released.statusCode).toBe(201);
    const commandA={...authBody(0),expectedRevision:2,quantity:'7',destination:'Slurry',
      reason:'Approved manual issue'};
    const commandB={...authBody(1),expectedRevision:2,quantity:'5',destination:'Slurry',
      reason:'Competing manual issue'};
    const [a,b]=await Promise.all([
      post('/storage/stock/'+body.stockUnitId+'/issue',commandA,0),
      post('/storage/stock/'+body.stockUnitId+'/issue',commandB,1),
    ]);
    expect([a.statusCode,b.statusCode].sort()).toEqual([201,409]);
    const accepted=a.statusCode===201?commandA:commandB;
    const acceptedDevice=a.statusCode===201?0:1;
    const acceptedQuantity=a.statusCode===201?'7.000000':'5.000000';
    const current=await stock(body.stockUnitId,1);
    expect(current.revision).toBe(3);
    expect(current.onHand).toBe(acceptedQuantity==='7.000000'?'3.000000':'5.000000');
    const retry=await post('/storage/stock/'+body.stockUnitId+'/issue',accepted,acceptedDevice);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({alreadyRecorded:true,revision:3});
    expect((await stock(body.stockUnitId)).onHand).toBe(current.onHand);
    const entries=await pool.query('SELECT kind,quantity_delta::text FROM storage_ledger_entries WHERE organization_id=$1 AND stock_unit_id=$2 ORDER BY recorded_at,id',
      [org,body.stockUnitId]);
    expect(entries.rows.filter(row=>row.kind==='issue')).toHaveLength(1);
  });

  it('enforces stocktake correction permissions, conservation on split moves and immutable ledger',async()=>{
    const {body}=await receipt('5');
    const unprivileged=await change(body.stockUnitId,'reconcile',{
      expectedRevision:1,physicalQuantity:'6',reason:'Counted',
    },2);
    expect(unprivileged.statusCode).toBe(403);
    const managerChange=await post('/storage/warehouse-managers',{
      ...authBody(),userId:worker,enabled:true,reason:'Authorized warehouse operator',
    });
    expect(managerChange.statusCode).toBe(200);
    const moved=await change(body.stockUnitId,'move',{
      expectedRevision:1,quantity:'1.500000',destinationLocationId:otherLocation,
      destinationStockUnitId:randomUUID(),reason:'Shelving transfer',
    },2);
    expect(moved.statusCode).toBe(201);
    expect(moved.json().sourceOnHand).toBe('3.500000');
    const source=await stock(body.stockUnitId),dest=await stock(moved.json().destinationStockUnitId);
    expect(source.onHand).toBe('3.500000');
    expect(dest.onHand).toBe('1.500000');
    expect(dest.disposition).toBe('quarantine');
    expect((await change(body.stockUnitId,'reconcile',{
      expectedRevision:2,physicalQuantity:'3.250000',reason:'Physical count discrepancy',
    },2)).statusCode).toBe(201);
    expect((await stock(body.stockUnitId)).onHand).toBe('3.250000');
    const ledger=await pool.query("SELECT id FROM storage_ledger_entries WHERE organization_id=$1 AND stock_unit_id=$2 AND kind='reconcile'",
      [org,body.stockUnitId]);
    expect(ledger.rowCount).toBe(1);
    await expect(pool.query('UPDATE storage_ledger_entries SET quantity_delta=9 WHERE organization_id=$1 AND id=$2',
      [org,ledger.rows[0].id])).rejects.toThrow('storage history is append-only');
    const revoke=await post('/storage/warehouse-managers',{
      ...authBody(),userId:worker,enabled:false,reason:'Warehouse access ended',
    });
    expect(revoke.statusCode).toBe(200);
    expect((await change(body.stockUnitId,'reconcile',{
      expectedRevision:3,physicalQuantity:'4',reason:'Unauthorized after revocation',
    },2)).statusCode).toBe(403);
  });

  it('streams committed operations to another device and keeps legacy local history separate',async()=>{
    const response=await read('/storage/changes?deviceId='+devices[1].id+'&cursor=0&limit=100',1);
    expect(response.statusCode).toBe(200);
    const body=response.json();
    expect(body.changes.some((event:{kind:string})=>event.kind==='receipt')).toBe(true);
    expect(body.changes.some((event:{kind:string})=>event.kind==='issue')).toBe(true);
    expect(body.nextCursor).toBeGreaterThan(0);
    const next=await read('/storage/changes?deviceId='+devices[1].id+'&cursor='+body.nextCursor+'&limit=100',1);
    expect(next.statusCode).toBe(200);
    const existing=await pool.query('SELECT count(*)::int AS count FROM storage_receipts WHERE organization_id=$1',
      [org]);
    expect(existing.rows[0].count).toBe(4);
  });
});
