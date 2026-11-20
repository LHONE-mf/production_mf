import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {expect} from 'vitest';
import {Pool} from 'pg';
import {buildApp} from './app.js';
import {tokenHash} from './auth.js';
/** Synthetic fixtures; every stock/QA/handoff transition uses the actual API. */
export async function createInventoryHandoffFixture(searchPath?:string,withCoating=false,withCalendaring=false,withCutting=false,withSorting=false){
  if(searchPath&&!/^room_upgrade_[a-f0-9]{32}$/.test(searchPath))throw Error('Invalid isolated test schema');
  const applicationName='inventory-outcome-'+randomUUID();
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL,application_name:applicationName,...(searchPath?{options:'-c search_path='+searchPath}:{}) }), app = buildApp(pool);
  const org = randomUUID(), epoch = randomUUID(), material = randomUUID(), location = randomUUID(), batch = randomUUID(), workshop = 'issue-' + randomUUID();
  const actors = ['chief', 'worker', 'worker', 'master', 'worker', 'worker', ...(withCalendaring?['worker']:[]),...(withCutting?['worker']:[]),...(withSorting?['worker']:[])].map(role => ({ id: randomUUID(), role, token: randomBytes(32).toString('base64url'), device: '', proof: '' }));
  const headers = (i = 0) => ({ authorization: 'Bearer ' + actors[i].token, 'x-device-proof': actors[i].proof, 'x-inventory-epoch': epoch });
  const post = (url: string, payload: object, i = 0) => app.inject({ method: 'POST', url, headers: headers(i), payload });
  const get = (url: string, i = 0) => app.inject({ method: 'GET', url, headers: headers(i) });
  const operation = (kind: string, revision: number, i = 1, extras: object = {}) => ({ operationId: randomUUID(), deviceId: actors[i].device, kind, expectedIssueRevision: revision, reason: 'Accountable synthetic physical handoff', evidence: 'CI signed handoff record', ...extras });
  const act = (id: string, body: object, i = 1) => post('/inventory/issues/' + id + '/operations', body, i);
  async function request(quantity = 500, i = 2, productionBatchId = batch) {
    const body = { operationId: randomUUID(), issueId: randomUUID(), deviceId: actors[i].device, materialId: material, productionBatchId, stepNumber: 1, recipientId: actors[4].id, quantity, reason: 'Synthetic production request', evidence: 'Batch material requirement' };
    const response = await post('/inventory/issues', body, i); expect(response.statusCode, response.body).toBe(201); return { body, issue: response.json().issue };
  }
  async function stock(expiresOn?:string) {
    const id = randomUUID();
    const receipt = await post('/inventory/receipts', { operationId: randomUUID(), stockId: id, deviceId: actors[2].device, materialId: material, locationId: location, manufacturerLot: 'SAME-MAKER-LOT', quantity: 1000, expectedRevision: 0, reason: 'Synthetic sealed receipt',...(expiresOn?{expiresOn,manufacturedOn:'2026-01-01'}:{}) }, 2); expect(receipt.statusCode, receipt.body).toBe(201);
    const qa = await post('/inventory/stocks/' + id + '/quality-dispositions', { operationId: randomUUID(), stockId: id, deviceId: actors[0].device, expectedRevision: 1, disposition: 'release', reason: 'Chief actual API disposition', evidence: 'QA certificate CI' }); expect(qa.statusCode, qa.body).toBe(201); return id;
  }
  async function reserved(quantity = 500,expiresOn?:string) {
    const id = await stock(expiresOn), req = await request(quantity);
    const response = await act(req.issue.id, operation('reserve', 1, 1, { stockId: id, expectedStockRevision: 2 })); expect(response.statusCode, response.body).toBe(201); return { id, issue: response.json().issue };
  }
  await (async () => {
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
    if(withCoating){
      await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop+'-coating']);
      await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',[org,actors[5].id,workshop+'-coating']);
      await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,2,'Coat','coating',$3,'cathode')",[org,route,workshop+'-coating']);
    }
    if(withCalendaring){
      await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop+'-calendaring']);
      await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',[org,actors[6].id,workshop+'-calendaring']);
      await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,3,'Calender','calendaring',$3,'cathode')",[org,route,workshop+'-calendaring']);
    }
    if(withCutting){
      await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop+'-cutting']);
      await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',[org,actors[7].id,workshop+'-cutting']);
      await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,4,'Cut','cutting',$3,'cathode')",[org,route,workshop+'-cutting']);
    }
    if(withSorting){
      await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop+'-sorting']);
      await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',[org,actors[8].id,workshop+'-sorting']);
      await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,5,'Sort','sorting',$3,'cathode')",[org,route,workshop+'-sorting']);
      // Include the downstream common-cell stage before approval; approved routes cannot be edited.
      await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,6,'Assembly custody','assembly',$3,'common')",[org,route,workshop]);
    }
    await pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2", [org, route, actors[0].id]);
    await pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'NMC',$3,1,'released',1,'kg',$4)", [org, order, route, actors[0].id]);
    await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cathode','created',$4)", [org, batch, order, actors[0].id]);
  })();
  return {pool,app,applicationName,org,epoch,material,location,batch,actors,headers,post,get,stock,request,reserved,operation,act};
}
