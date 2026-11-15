import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('Accountable production material handoffs (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL }), app = buildApp(pool);
  const org = randomUUID(), epoch = randomUUID(), material = randomUUID(), location = randomUUID(), batch = randomUUID(), workshop = 'issue-' + randomUUID();
  const actors = ['chief', 'worker', 'worker', 'master', 'worker', 'worker'].map(role => ({ id: randomUUID(), role, token: randomBytes(32).toString('base64url'), device: '', proof: '' }));
  const headers = (i = 0) => ({ authorization: 'Bearer ' + actors[i].token, 'x-device-proof': actors[i].proof, 'x-inventory-epoch': epoch });
  const post = (url: string, payload: object, i = 0) => app.inject({ method: 'POST', url, headers: headers(i), payload });
  const get = (url: string, i = 0) => app.inject({ method: 'GET', url, headers: headers(i) });
  const operation = (kind: string, revision: number, i = 1, extras: object = {}) => ({ operationId: randomUUID(), deviceId: actors[i].device, kind, expectedIssueRevision: revision, reason: 'Accountable synthetic physical handoff', evidence: 'CI signed handoff record', ...extras });
  const act = (id: string, body: object, i = 1) => post('/inventory/issues/' + id + '/operations', body, i);
  async function request(quantity = 500, i = 2, productionBatchId = batch) {
    const body = { operationId: randomUUID(), issueId: randomUUID(), deviceId: actors[i].device, materialId: material, productionBatchId, stepNumber: 1, recipientId: actors[4].id, quantity, reason: 'Synthetic production request', evidence: 'Batch material requirement' };
    const response = await post('/inventory/issues', body, i); expect(response.statusCode, response.body).toBe(201); return { body, issue: response.json().issue };
  }
  async function stock() {
    const id = randomUUID();
    const receipt = await post('/inventory/receipts', { operationId: randomUUID(), stockId: id, deviceId: actors[2].device, materialId: material, locationId: location, manufacturerLot: 'SAME-MAKER-LOT', quantity: 1000, expectedRevision: 0, reason: 'Synthetic sealed receipt' }, 2); expect(receipt.statusCode, receipt.body).toBe(201);
    const qa = await post('/inventory/stocks/' + id + '/quality-dispositions', { operationId: randomUUID(), stockId: id, deviceId: actors[0].device, expectedRevision: 1, disposition: 'release', reason: 'Chief actual API disposition', evidence: 'QA certificate CI' }); expect(qa.statusCode, qa.body).toBe(201); return id;
  }
  async function reserved(quantity = 500) {
    const id = await stock(), req = await request(quantity);
    const response = await act(req.issue.id, operation('reserve', 1, 1, { stockId: id, expectedStockRevision: 2 })); expect(response.statusCode, response.body).toBe(201); return { id, issue: response.json().issue };
  }
  beforeAll(async () => {
    const url = new URL(process.env.POSTGRES_TEST_URL!); if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/production_mf_ci') throw Error('Disposable database required');
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic material issue CI')", [org]); await pool.query('INSERT INTO inventory_streams(organization_id,epoch) VALUES($1,$2)', [org, epoch]);
    const keys = generateKeyPairSync('ed25519');
    for (const [i, actor] of actors.entries()) {
      await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1::uuid,$2,$1::uuid::text,'test-only',$3)", [actor.id, org, actor.role]);
      await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [randomUUID(), org, actor.id, tokenHash(actor.token)]);
      const enrolled = await post('/devices', { userId: actor.id, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }); expect(enrolled.statusCode, enrolled.body).toBe(201); actor.device = enrolled.json().id;
      const challenge = (await post('/devices/challenge', { deviceId: actor.device }, i)).json();
      const verified = await post('/devices/challenge/verify', { deviceId: actor.device, challengeId: challenge.challengeId, challenge: challenge.challenge, signature: sign(null, Buffer.from('production-mf:device-proof:v1:' + challenge.challenge), keys.privateKey).toString('base64url') }, i); expect(verified.statusCode, verified.body).toBe(200); actor.proof = verified.json().proofToken;
    }
    for (const [i, level] of [[1, 'manager'], [2, 'operator']] as const) expect((await post('/inventory/access', { deviceId: actors[0].device, changeId: randomUUID(), userId: actors[i].id, level, action: 'grant' })).statusCode).toBe(201);
    expect((await post('/inventory/materials', { id: material, deviceId: actors[0].device, code: 'ISS-' + material, name: 'Synthetic issue powder', category: 'raw_material', baseUnit: 'mg' })).statusCode).toBe(201);
    expect((await post('/inventory/locations', { id: location, deviceId: actors[0].device, parentId: null, label: 'Issue warehouse', kind: 'warehouse' })).statusCode).toBe(201);
    await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)', [org, workshop]);
    for (const i of [3, 4]) await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)', [org, actors[i].id, workshop]);
    const route = randomUUID(), order = randomUUID();
    await pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Issue route',$3)", [org, route, actors[0].id]);
    await pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)', [org, route]);
    await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Weigh','slurry',$3,'cathode')", [org, route, workshop]);
    await pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2", [org, route, actors[0].id]);
    await pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'NMC',$3,1,'released',1,'kg',$4)", [org, order, route, actors[0].id]);
    await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cathode','created',$4)", [org, batch, order, actors[0].id]);
  });
  afterAll(async () => { await app.close(); await pool.end(); });
  it('keeps request, reservation, approval, dispatch and recipient acknowledgement distinct and exactly once', async () => {
    const source = await stock(), req = await request(), id = req.issue.id;
    expect((await post('/inventory/issues', req.body, 2)).json().issue).toEqual(req.issue);
    expect((await post('/inventory/issues', { ...req.body, quantity: 501 }, 2)).statusCode).toBe(409);
    expect((await act(id, operation('dispatch', 1, 1, { expectedStockRevision: 2 }))).statusCode).toBe(409);
    for (const i of [2, 3, 4]) expect((await act(id, operation('reserve', 1, i, { stockId: source, expectedStockRevision: 2 }), i)).statusCode).toBe(403);
    const reserved = await act(id, operation('reserve', 1, 1, { stockId: source, expectedStockRevision: 2 })); expect(reserved.statusCode, reserved.body).toBe(201); expect(reserved.json().stock).toMatchObject({ onHand: 1000, reserved: 500, revision: 3 });
    expect((await act(id, operation('dispatch', 2, 1, { expectedStockRevision: 3 }))).statusCode).toBe(409);
    expect((await act(id, operation('approve', 2, 2, { expectedStockRevision: 3 }), 2)).statusCode).toBe(403);
    const approval = await act(id, operation('approve', 2, 1, { expectedStockRevision: 3 })); expect(approval.statusCode, approval.body).toBe(201); expect(approval.json().issue.state).toBe('approved'); expect(approval.json().stock).toBeUndefined();
    const dispatch = operation('dispatch', 3, 1, { expectedStockRevision: 3 }), sent = await act(id, dispatch); expect(sent.statusCode, sent.body).toBe(201); expect(sent.json().stock).toMatchObject({ onHand: 500, reserved: 0, revision: 4 }); expect(sent.json().issue).toMatchObject({ state: 'dispatched', quantity: 500, stockId: source, recipientId: actors[4].id });
    expect((await act(id, dispatch)).json().stock).toEqual(sent.json().stock);
    expect((await act(id, { ...dispatch, evidence: 'Changed evidence' })).statusCode).toBe(409);
    expect((await act(id, operation('receive', 4, 3), 3)).statusCode).toBe(404);
    const receipt = operation('receive', 4, 4), received = await act(id, receipt, 4); expect(received.statusCode, received.body).toBe(201); expect(received.json().issue.state).toBe('received'); expect(received.json().stock).toBeUndefined(); expect((await act(id, receipt, 4)).json().issue).toEqual(received.json().issue);
    expect((await pool.query('SELECT on_hand::int,reserved::int,revision FROM inventory_stocks WHERE id=$1', [source])).rows[0]).toEqual({ on_hand: 500, reserved: 0, revision: 4 });
    expect((await pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2 AND kind='issue'", [org, source])).rows[0].n).toBe(1);
    await expect(pool.query("UPDATE inventory_issue_events SET reason='rewrite' WHERE issue_id=$1", [id])).rejects.toThrow('immutable');
  });
  it('gives assigned production users scoped discovery, request and receipt without exposing warehouse balances', async () => {
    const req = await request(10, 3), id = req.issue.id;
    const context = await get('/inventory/issues/context?deviceId=' + actors[4].device, 4); expect(context.statusCode, context.body).toBe(200); expect(context.json()).toMatchObject({ warehouseLevel: null, epoch, actorId: actors[4].id });
    const options = await get('/inventory/issue-batches?deviceId=' + actors[4].device, 4); expect(options.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: batch, stepNumber: 1, workshopId: workshop })]));
    const own = await get('/inventory/issues?deviceId=' + actors[4].device, 4); expect(own.statusCode, own.body).toBe(200); expect(own.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id })])); expect(JSON.stringify(own.json())).not.toContain('onHand');
    expect((await get('/inventory/stocks?deviceId=' + actors[4].device, 4)).statusCode).toBe(403);
    expect((await act(id, operation('approve', 1, 3, { expectedStockRevision: 1 }), 3)).statusCode).toBe(403);
    expect((await get('/inventory/issues/' + id + '/history?deviceId=' + actors[5].device, 5)).statusCode).toBe(404);
    expect((await post('/inventory/issues', { ...req.body, issueId: randomUUID(), operationId: randomUUID(), deviceId: actors[5].device }, 5)).statusCode).toBe(403);
    expect((await post('/inventory/issues', { ...req.body, issueId: randomUUID(), operationId: randomUUID(), recipientId: actors[5].id }, 3)).statusCode).toBe(409);
  });
  it('protects issue-owned reservations from the generic release API and cancels without stock deduction', async () => {
    const { id, issue } = await reserved();
    const generic = await post('/inventory/stocks/' + id + '/operations', { operationId: randomUUID(), deviceId: actors[1].device, kind: 'release_reservation', reservationId: issue.id, productionBatchId: batch, expectedRevision: 3, quantity: 500, reason: 'Cannot bypass handoff state' }, 1); expect(generic.statusCode).toBe(409);
    const cancel = operation('cancel', 2, 1, { expectedStockRevision: 3 }), result = await act(issue.id, cancel); expect(result.statusCode, result.body).toBe(201); expect(result.json().stock).toMatchObject({ onHand: 1000, reserved: 0, revision: 4 }); expect(result.json().issue.state).toBe('cancelled'); expect((await act(issue.id, cancel)).statusCode).toBe(200);
  });
  it('requires Manager authority and a real paired physical handoff even at the database boundary',async()=>{
    const {id,issue}=await reserved();
    await expect(pool.query("INSERT INTO inventory_issue_events(operation_id,organization_id,issue_id,actor_id,device_id,kind,expected_revision,resulting_revision,epoch,reason,evidence,stock_effect,request_payload,result_issue) VALUES($1,$2,$3,$4,$5,'approve',2,3,$6,'Forbidden operator approval','Must fail',false,'{}','{}')",[randomUUID(),org,issue.id,actors[2].id,actors[2].device,epoch])).rejects.toThrow('issue_manager_required');
    await expect(pool.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock) VALUES($1,$2,$3,$4,$5,'issue',1,3,4,'Unpaired debit',$6,'{}','{}')",[randomUUID(),org,id,actors[1].id,actors[1].device,batch])).rejects.toThrow('inventory_issue_handoff_required');
  });
  it('blocks held/expired/stale approval and revoked approvers; reapproval is explicit and does not deduct', async () => {
    const { id, issue } = await reserved();
    expect((await act(issue.id, operation('approve', 2, 1, { expectedStockRevision: 3 }))).statusCode).toBe(201);
    const hold = { operationId: randomUUID(), stockId: id, deviceId: actors[0].device, expectedRevision: 3, disposition: 'hold', reason: 'QA hold after approval', evidence: 'CI hold report' };
    expect((await post('/inventory/stocks/' + id + '/quality-dispositions', hold)).statusCode).toBe(201);
    expect((await act(issue.id, operation('dispatch', 3, 1, { expectedStockRevision: 4 }))).statusCode).toBe(409);
    expect((await post('/inventory/stocks/' + id + '/quality-dispositions', { ...hold, operationId: randomUUID(), expectedRevision: 4, disposition: 'release' })).statusCode).toBe(201);
    expect((await act(issue.id, operation('dispatch', 3, 1, { expectedStockRevision: 5 }))).json().error).toBe('issue_approval_stale');
    expect((await act(issue.id, operation('approve', 3, 1, { expectedStockRevision: 5 }))).statusCode).toBe(201);
    try {
      await pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2', [org, actors[1].id]);
      expect((await act(issue.id, operation('dispatch', 4, 0, { expectedStockRevision: 5 }), 0)).json().error).toBe('issue_approval_revoked');
    } finally { await pool.query('UPDATE inventory_access SET active=true WHERE organization_id=$1 AND user_id=$2', [org, actors[1].id]); }
    try {
      await pool.query("UPDATE inventory_stocks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      expect((await act(issue.id, operation('dispatch', 4, 1, { expectedStockRevision: 5 }))).json().error).toBe('expired');
    } finally { await pool.query('UPDATE inventory_stocks SET expires_at=NULL WHERE id=$1', [id]); }
    expect((await act(issue.id, operation('dispatch', 4, 1, { expectedStockRevision: 5 }))).statusCode).toBe(201);
    const history = await get('/inventory/issues/' + issue.id + '/history?deviceId=' + actors[4].device + '&limit=2', 4); expect(history.statusCode).toBe(200); expect(history.json().items.map((r: { kind: string }) => r.kind)).toEqual(['request', 'reserve']); expect(history.json().hasMore).toBe(true);
    await pool.query("UPDATE production_batches SET status='hold' WHERE organization_id=$1 AND id=$2", [org, batch]);
    try { expect((await act(issue.id, operation('receive', 5, 4), 4)).statusCode).toBe(201); }
    finally { await pool.query("UPDATE production_batches SET status='created' WHERE organization_id=$1 AND id=$2", [org, batch]); }
  });
  it('serializes competing reservations and dispatch retries without taking another batch reservation', async () => {
    const source = await stock(), a = await request(700), b = await request(700);
    const reservations = await Promise.all([a, b].map(req => act(req.issue.id, operation('reserve', 1, 1, { stockId: source, expectedStockRevision: 2 }))));
    expect(reservations.map(r => r.statusCode).sort()).toEqual([201, 409]); const winner = reservations[0].statusCode === 201 ? a : b;
    expect((await act(winner.issue.id, operation('approve', 2, 1, { expectedStockRevision: 3 }))).statusCode).toBe(201);
    const dispatch = operation('dispatch', 3, 1, { expectedStockRevision: 3 });
    const results = await Promise.all([act(winner.issue.id, dispatch), act(winner.issue.id, dispatch), act(winner.issue.id, { ...dispatch, operationId: randomUUID() })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 201, 409]);
    expect((await pool.query('SELECT on_hand::int,reserved::int FROM inventory_stocks WHERE id=$1', [source])).rows[0]).toEqual({ on_hand: 300, reserved: 0 });
  });
  it('issues one package to two batches while preserving the other reservation and requiring current reapproval',async()=>{
    const otherBatch=randomUUID();
    await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) SELECT organization_id,$2,order_id,$3,material_line,'created',created_by FROM production_batches WHERE organization_id=$1 AND id=$4",[org,otherBatch,'Second-'+otherBatch,batch]);
    const source=await stock(),a=await request(400),b=await request(300,2,otherBatch);
    expect((await act(a.issue.id,operation('reserve',1,1,{stockId:source,expectedStockRevision:2}))).statusCode).toBe(201);
    expect((await act(b.issue.id,operation('reserve',1,1,{stockId:source,expectedStockRevision:3}))).statusCode).toBe(201);
    for(const req of [a,b])expect((await act(req.issue.id,operation('approve',2,1,{expectedStockRevision:4}))).statusCode).toBe(201);
    const first=await act(a.issue.id,operation('dispatch',3,1,{expectedStockRevision:4}));expect(first.statusCode,first.body).toBe(201);expect(first.json().stock).toMatchObject({onHand:600,reserved:300,available:300});
    expect((await act(b.issue.id,operation('dispatch',3,1,{expectedStockRevision:4}))).json().error).toBe('revision_conflict');
    expect((await act(b.issue.id,operation('approve',3,1,{expectedStockRevision:5}))).statusCode).toBe(201);
    const second=await act(b.issue.id,operation('dispatch',4,1,{expectedStockRevision:5}));expect(second.statusCode,second.body).toBe(201);expect(second.json().stock).toMatchObject({onHand:300,reserved:0,available:300});
    expect((await pool.query("SELECT production_batch_id,quantity::int FROM inventory_operations WHERE stock_id=$1 AND kind='issue' ORDER BY sequence",[source])).rows).toEqual([{production_batch_id:batch,quantity:400},{production_batch_id:otherBatch,quantity:300}]);
  });
  it('rejects cross-endpoint ID reuse in both directions, wrong tenant, malformed intent and stale history', async () => {
    const { id, issue } = await reserved(), req = await request();
    expect((await post('/inventory/stocks/' + id + '/operations', { operationId: req.body.operationId, deviceId: actors[2].device, kind: 'transfer', expectedRevision: 3, quantity: 1000, toLocationId: randomUUID(), reason: 'Reused workflow ID' }, 2)).statusCode).toBe(409);
    const receiptId = (await pool.query("SELECT operation_id FROM inventory_operations WHERE stock_id=$1 AND kind='receive'", [id])).rows[0].operation_id;
    expect((await act(issue.id, operation('approve', 2, 1, { operationId: receiptId, expectedStockRevision: 3 }))).json().error).toBe('operation_id_reused');
    expect((await act(issue.id, { ...operation('approve', 2, 1, { expectedStockRevision: 3 }), undocumented: true })).statusCode).toBe(400);
    expect((await act(randomUUID(), operation('approve', 2, 1, { expectedStockRevision: 3 }))).statusCode).toBe(404);
    try {
      await pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1', [org, randomUUID()]);
      expect((await act(issue.id, operation('approve', 2, 1, { expectedStockRevision: 3 }))).json().error).toBe('inventory_epoch_changed');
    } finally { await pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1', [org, epoch]); }
    expect((await get('/inventory/issues?deviceId=' + actors[4].device + '&limit=101', 4)).statusCode).toBe(400);
  });
  it('rechecks warehouse authority and recipient membership after waiting for the actual stock lock', async () => {
    const { issue } = await reserved(), blocker = await pool.connect(); let pending: Promise<Awaited<ReturnType<typeof act>>> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [org + ':inventory-sequence']);
      await blocker.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2', [org, actors[1].id]);
      pending = Promise.resolve(act(issue.id, operation('approve', 2, 1, { expectedStockRevision: 3 })));
      const deadline = Date.now() + 4000;
      while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE query LIKE '%pg_advisory_xact_lock(hashtextextended%' AND wait_event_type='Lock' AND pid<>pg_backend_pid()")).rowCount) { if (Date.now() > deadline) throw Error('Issue transaction did not wait'); await new Promise(resolve => setTimeout(resolve, 10)); }
      await blocker.query('COMMIT'); expect((await pending).statusCode).toBe(403);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; await pool.query('UPDATE inventory_access SET active=true WHERE organization_id=$1 AND user_id=$2', [org, actors[1].id]); }
    await pool.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2 AND workshop_id=$3', [org, actors[4].id, workshop]);
    try { expect((await act(issue.id, operation('approve', 2, 1, { expectedStockRevision: 3 }))).json().error).toBe('recipient_workshop_required'); }
    finally { await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)', [org, actors[4].id, workshop]); }
  }, 10000);
});
