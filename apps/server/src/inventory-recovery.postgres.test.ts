import{randomBytes,randomUUID}from'node:crypto';import{beforeAll,afterAll,describe,it,expect}from'vitest';import{Pool}from'pg';
import{buildApp}from'./app.js';import{tokenHash}from'./auth.js';
const integration=process.env.POSTGRES_TEST_URL?describe:describe.skip;
integration('Chief-reviewed inventory history recovery (real PostgreSQL)',()=>{
 const pool=new Pool({connectionString:process.env.POSTGRES_TEST_URL}),app=buildApp(pool),org=randomUUID();
 const actors=['chief','worker'].map(role=>({id:randomUUID(),role,device:randomUUID(),token:randomBytes(32).toString('base64url'),proof:randomBytes(32).toString('base64url')}));let epoch:string;
 const headers=(i=0)=>({authorization:'Bearer '+actors[i].token,'x-device-proof':actors[i].proof});
 const post=(body:object,i=0)=>app.inject({method:'POST',url:'/inventory/recovery-approvals',headers:headers(i),payload:body});
 const payload=()=>({approvalId:randomUUID(),deviceId:actors[0].device,targetActorId:actors[1].id,targetDeviceId:actors[1].device,epoch,evidenceDigest:'a'.repeat(64),reason:'Compared original device evidence with restored ledger',evidence:'Signed staging review reference'});
 beforeAll(async()=>{const url=new URL(process.env.POSTGRES_TEST_URL!);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/production_mf_ci')throw Error('Disposable local test database required');await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[org,'Recovery approval fixtures']);for(const a of actors){await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1::uuid,$2,$1::uuid::text,'test-only',$3)",[a.id,org,a.role]);await pool.query('INSERT INTO devices(id,organization_id,user_id) VALUES($1,$2,$3)',[a.device,org,a.id]);await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[randomUUID(),org,a.id,tokenHash(a.token)]);await pool.query("INSERT INTO device_proof_grants(token_hash,organization_id,user_id,device_id,session_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[tokenHash(a.proof),org,a.id,a.device,tokenHash(a.token)]);}await pool.query("INSERT INTO inventory_access(organization_id,user_id,level,granted_by) VALUES($1,$2,'operator',$3)",[org,actors[1].id,actors[0].id]);const stream=await app.inject({method:'GET',url:'/inventory/stream?deviceId='+actors[0].device,headers:headers()});epoch=stream.json().epoch;});
 afterAll(async()=>{await app.close();await pool.end();});
 it('allows only current Chief approval, binds exact evidence/device/epoch and retains immutable audit',async()=>{
  expect((await post({...payload(),deviceId:actors[1].device},1)).statusCode).toBe(403);
  const body=payload(),accepted=await post(body);expect(accepted.statusCode,accepted.body).toBe(201);expect((await post(body)).statusCode).toBe(200);expect((await post({...body,evidenceDigest:'b'.repeat(64)})).statusCode).toBe(409);
  const read=await app.inject({method:'GET',url:'/inventory/recovery-approvals?deviceId='+actors[1].device+'&evidenceDigest='+body.evidenceDigest,headers:headers(1)});expect(read.statusCode,read.body).toBe(200);expect(read.json().approval).toMatchObject({approvalId:body.approvalId,epoch,evidenceDigest:body.evidenceDigest,targetActorId:actors[1].id,targetDeviceId:actors[1].device,approvedBy:actors[0].id});
  expect((await post({...payload(),targetActorId:randomUUID(),targetDeviceId:randomUUID()})).statusCode).toBe(404);
  await expect(pool.query('DELETE FROM inventory_recovery_approvals WHERE organization_id=$1',[org])).rejects.toThrow('immutable');
  expect((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n).toBe(0);
 });
 it('requires the actual proven device and current Chief role, and isolates approval reads to the target',async()=>{
  const body=payload();expect((await post(body)).statusCode).toBe(201);
  const own=await app.inject({method:'GET',url:'/inventory/recovery-approvals?deviceId='+actors[0].device+'&evidenceDigest='+body.evidenceDigest,headers:headers()});expect(own.json().approval).toBeNull();
  const foreign=await app.inject({method:'GET',url:'/inventory/recovery-approvals?deviceId='+actors[1].device+'&evidenceDigest='+body.evidenceDigest,headers:headers()});expect(foreign.statusCode).toBe(403);
  const missing=await app.inject({method:'POST',url:'/inventory/recovery-approvals',headers:{authorization:'Bearer '+actors[0].token},payload:payload()});expect(missing.statusCode).toBe(403);
  try{await pool.query("UPDATE users SET role='master' WHERE id=$1",[actors[0].id]);expect((await post(payload())).statusCode).toBe(403);}finally{await pool.query("UPDATE users SET role='chief' WHERE id=$1",[actors[0].id]);}
  try{await pool.query('UPDATE device_proof_grants SET revoked_at=now() WHERE device_id=$1',[actors[0].device]);expect((await post(payload())).statusCode).toBe(403);}finally{await pool.query('UPDATE device_proof_grants SET revoked_at=NULL WHERE device_id=$1',[actors[0].device]);}
  await expect(pool.query("UPDATE inventory_recovery_approvals SET reason='rewrite' WHERE id=$1",[body.approvalId])).rejects.toThrow('immutable');
 });
 it('does not reuse approvals after another restore or approve a stale epoch',async()=>{const original=epoch;try{await pool.query('UPDATE inventory_streams SET epoch=$2,posting_enabled=false WHERE organization_id=$1',[org,randomUUID()]);expect((await post(payload())).json()).toEqual({error:'inventory_epoch_changed'});const read=await app.inject({method:'GET',url:'/inventory/recovery-approvals?deviceId='+actors[1].device+'&evidenceDigest='+('a'.repeat(64)),headers:headers(1)});expect(read.json().approval).toBeNull();}finally{await pool.query('UPDATE inventory_streams SET epoch=$2,posting_enabled=true WHERE organization_id=$1',[org,original]);}});
});
