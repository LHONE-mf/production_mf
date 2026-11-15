import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('Chief quality disposition of genuine receipts (real PostgreSQL)', () => {
  const applicationName = 'inventory-quality-' + randomUUID();
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL, application_name: applicationName }), app = buildApp(pool);
  const org = randomUUID(), epoch = randomUUID(), material = randomUUID(), place = randomUUID();
  const actors = ['chief', 'worker', 'worker', 'master'].map(role => ({ id: randomUUID(), role, token: randomBytes(32).toString('base64url'), device: '', proof: '' }));
  const key = generateKeyPairSync('ed25519');
  const headers = (index = 0) => ({ authorization: 'Bearer ' + actors[index].token, 'x-device-proof': actors[index].proof, 'x-inventory-epoch': epoch });
  const post = (path: string, body: object, index = 0) => app.inject({ method: 'POST', url: path, headers: headers(index), payload: body });
  const get = (path: string, index = 0) => app.inject({ method: 'GET', url: path, headers: headers(index) });
  async function receive(expiresOn?: string) {
    const stockId = randomUUID();
    const response = await post('/inventory/receipts', { operationId: randomUUID(), stockId, deviceId: actors[2].device, materialId: material, locationId: place, manufacturerLot: 'QA-CI-LOT', quantity: 2125000, expectedRevision: 0, reason: 'Synthetic actual receipt through authenticated API', ...(expiresOn ? { expiresOn } : {}) }, 2);
    expect(response.statusCode, response.body).toBe(201); expect(response.json().stock.quality).toBe('quarantine'); return response.json().stock;
  }
  const action = (stockId: string, expectedRevision = 1, disposition = 'release') => ({ operationId: randomUUID(), stockId, deviceId: actors[0].device, expectedRevision, disposition, reason: 'Chief reviewed supplier certificate and physical sample', evidence: 'CI certificate and inspection report #42' });
  const qa = (body: ReturnType<typeof action>, index = 0) => post('/inventory/stocks/' + body.stockId + '/quality-dispositions', body, index);
  beforeAll(async () => {
    const url = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/production_mf_ci') throw Error('Disposable database required');
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic Chief QA CI')", [org]);
    await pool.query('INSERT INTO inventory_streams(organization_id,epoch) VALUES($1,$2)', [org, epoch]);
    for (const actor of actors) {
      await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1::uuid,$2,$1::uuid::text,'test-only',$3)", [actor.id, org, actor.role]);
      await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [randomUUID(), org, actor.id, tokenHash(actor.token)]);
    }
    for (const [index, actor] of actors.entries()) {
      const enrolled = await post('/devices', { userId: actor.id, publicKey: key.publicKey.export({ format: 'pem', type: 'spki' }).toString() }); expect(enrolled.statusCode, enrolled.body).toBe(201); actor.device = enrolled.json().id;
      const issued = await post('/devices/challenge', { deviceId: actor.device }, index); const { challengeId, challenge } = issued.json();
      const verified = await post('/devices/challenge/verify', { deviceId: actor.device, challengeId, challenge, signature: sign(null, Buffer.from('production-mf:device-proof:v1:' + challenge), key.privateKey).toString('base64url') }, index); expect(verified.statusCode, verified.body).toBe(200); actor.proof = verified.json().proofToken;
    }
    for (const [index, level] of [[1, 'manager'], [2, 'operator'], [3, 'operator']] as const) expect((await post('/inventory/access', { deviceId: actors[0].device, changeId: randomUUID(), userId: actors[index].id, level, action: 'grant' })).statusCode).toBe(201);
    expect((await post('/inventory/materials', { id: material, deviceId: actors[0].device, code: 'QA-' + material, name: 'QA synthetic powder', category: 'raw_material', baseUnit: 'mg' })).statusCode).toBe(201);
    expect((await post('/inventory/locations', { id: place, deviceId: actors[0].device, parentId: null, label: 'QA synthetic warehouse', kind: 'warehouse' })).statusCode).toBe(201);
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  it('releases quarantine only as current Chief with evidence; exact retry records no quantity movement or duplicate decision', async () => {
    const stock = await receive('2099-12-31'), body = action(stock.stockId);
    expect(stock.expiresAt).toBe('2100-01-01T00:00:00.000Z');
    for (const index of [1, 2, 3]) expect((await qa({ ...body, deviceId: actors[index].device }, index)).statusCode).toBe(403);
    expect((await qa({ ...body, evidence: '' })).statusCode).toBe(400);
    expect((await qa({ ...body, deviceId: actors[1].device })).statusCode).toBe(403);
    const receiveId=(await pool.query("SELECT operation_id FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2 AND kind='receive'",[org,stock.stockId])).rows[0].operation_id;
    expect((await qa({...body,operationId:receiveId})).statusCode).toBe(409);
    const accepted = await qa(body); expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().stock).toMatchObject({ quality: 'released', disposition: 'release', onHand: 2125000, reserved: 0, revision: 2, expiresAt: stock.expiresAt });
    expect((await qa(body)).json().stock).toEqual(accepted.json().stock);
    expect((await qa({ ...body, evidence: 'Changed intent' })).statusCode).toBe(409);
    expect((await qa({ ...body, operationId: randomUUID() })).statusCode).toBe(409);
    expect((await pool.query('SELECT quantity::text,kind FROM inventory_operations WHERE operation_id=$1', [body.operationId])).rows[0]).toEqual({ quantity: '0', kind: 'quality_change' });
    expect((await pool.query('SELECT count(*)::int AS n FROM inventory_quality_dispositions WHERE operation_id=$1', [body.operationId])).rows[0].n).toBe(1);
    await expect(pool.query("UPDATE inventory_quality_dispositions SET evidence='rewrite' WHERE operation_id=$1", [body.operationId])).rejects.toThrow('immutable');
  });
  it('holds/blocks/rejects with evidence and never releases rejected or expired stock', async () => {
    const stock = await receive(); expect((await qa(action(stock.stockId, 1, 'hold'))).statusCode).toBe(201);
    expect((await qa(action(stock.stockId, 2, 'block'))).statusCode).toBe(201);
    expect((await qa(action(stock.stockId, 3, 'reject'))).statusCode).toBe(201);
    expect((await qa(action(stock.stockId, 4, 'release'))).statusCode).toBe(409);
    const expired = await receive('2000-01-01'); expect((await qa(action(expired.stockId))).statusCode).toBe(409);
    const query = '/inventory/stocks/' + stock.stockId + '/quality-history?deviceId=' + actors[2].device;
    const first = await get(query + '&limit=1', 2); expect(first.statusCode, first.body).toBe(200); expect(first.json().items[0]).toMatchObject({ disposition: 'hold', evidence: expect.any(String), actorId: actors[0].id }); expect(first.json().hasMore).toBe(true);
    const next = await get(query + '&limit=2&after=' + first.json().nextAfter, 2); expect(next.json().items.map((row: { disposition: string }) => row.disposition)).toEqual(['block', 'reject']);
    expect((await get(query + '&limit=101', 2)).statusCode).toBe(400);
  });
  it('blocks reservation after genuine release expires and denies direct non-Chief disposition inserts at the DB boundary', async () => {
    const stock = await receive('2099-01-01'), body = action(stock.stockId); expect((await qa(body)).statusCode).toBe(201);
    await pool.query("UPDATE inventory_stocks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [stock.stockId]); // Disposable clock-advance fixture, never a runtime bypass.
    const reserve = await post('/inventory/stocks/' + stock.stockId + '/operations', { operationId: randomUUID(), deviceId: actors[0].device, kind: 'reserve', expectedRevision: 2, quantity: 1, productionBatchId: randomUUID(), reservationId: randomUUID(), reason: 'Expired stock must fail before reservation' }); expect(reserve.statusCode).toBe(409); expect(reserve.json().error).toBe('expired');
    await expect(pool.query("INSERT INTO inventory_quality_dispositions(operation_id,organization_id,stock_id,actor_id,device_id,disposition,reason,evidence,expected_revision,resulting_revision) VALUES($1,$2,$3,$4,$5,'release','Forbidden','Forbidden',1,2)", [randomUUID(), org, stock.stockId, actors[1].id, actors[1].device])).rejects.toThrow('chief_quality_required');
  });
  it('fails closed for malformed dates, wrong organization, absent/rotated history and revoked proof',async()=>{
    const stock=await receive(),body=action(stock.stockId);
    const missing=await app.inject({method:'POST',url:'/inventory/stocks/'+stock.stockId+'/quality-dispositions',headers:{authorization:'Bearer '+actors[0].token,'x-device-proof':actors[0].proof},payload:body});expect(missing.statusCode).toBe(428);
    const foreign=randomUUID(),foreignMaterial=randomUUID(),foreignPlace=randomUUID(),foreignStock=randomUUID();
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Other synthetic QA organization')",[foreign]);
    await pool.query("INSERT INTO inventory_materials(id,organization_id,material_code,display_name,category,base_unit) VALUES($1,$2,'OTHER','Other','component','pieces')",[foreignMaterial,foreign]);
    await pool.query("INSERT INTO inventory_locations(id,organization_id,label,kind) VALUES($1,$2,'Other','warehouse')",[foreignPlace,foreign]);
    await pool.query("INSERT INTO inventory_stocks(id,organization_id,material_id,manufacturer_lot,location_id,quality,on_hand) VALUES($1,$2,$3,'Other',$4,'quarantine',1)",[foreignStock,foreign,foreignMaterial,foreignPlace]);
    expect((await qa(action(foreignStock))).statusCode).toBe(404);expect((await get('/inventory/stocks/'+foreignStock+'/quality-history?deviceId='+actors[0].device)).statusCode).toBe(404);
    try{await pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[org,randomUUID()]);expect((await qa(body)).json().error).toBe('inventory_epoch_changed');}finally{await pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[org,epoch]);}
    try{await pool.query('UPDATE device_proof_grants SET revoked_at=clock_timestamp() WHERE token_hash=$1',[tokenHash(actors[0].proof)]);expect((await qa(body)).statusCode).toBe(403);}finally{await pool.query('UPDATE device_proof_grants SET revoked_at=NULL WHERE token_hash=$1',[tokenHash(actors[0].proof)]);}
    for(const expiresOn of ['2026-02-30','9999-12-31','not-a-date'])expect((await post('/inventory/receipts',{operationId:randomUUID(),stockId:randomUUID(),deviceId:actors[2].device,materialId:material,locationId:place,manufacturerLot:'Invalid date fixture',quantity:1,expectedRevision:0,reason:'Must reject invalid dates',expiresOn},2)).statusCode).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE operation_id=$1',[body.operationId])).rows[0].n).toBe(0);
  });

  it('rechecks Chief role after waiting for the actual stock lock and preserves the rejected original intent', async () => {
    const stock = await receive(), body = action(stock.stockId), blocker = await pool.connect(); let pending: Promise<Awaited<ReturnType<typeof qa>>> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [org + ':inventory-sequence']); await blocker.query("UPDATE users SET role='worker' WHERE id=$1", [actors[0].id]);
      pending = Promise.resolve(qa(body)); const deadline = Date.now() + 4000;
      while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_advisory_xact_lock(hashtextextended%' AND wait_event_type='Lock'", [applicationName])).rowCount) { if (Date.now() > deadline) throw Error('Quality transaction did not wait for lock'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await blocker.query('COMMIT'); expect((await pending).statusCode).toBe(403); expect((await pool.query('SELECT revision,quality FROM inventory_stocks WHERE id=$1', [stock.stockId])).rows[0]).toEqual({ revision: 1, quality: 'quarantine' });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; await pool.query("UPDATE users SET role='chief' WHERE id=$1", [actors[0].id]); }
  }, 10000);
});
