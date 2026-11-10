import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('master workshop task authorization (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const app = buildApp(pool);
  const org = randomUUID(), chief = randomUUID(), master = randomUUID(), worker = randomUUID();
  const chiefDevice = randomUUID(), masterDevice = randomUUID(), workerDevice = randomUUID();
  const taskA = randomUUID(), taskB = randomUUID();
  const credentials = [chief, master, worker].map(user => ({
    user, token: randomBytes(32).toString('base64url'),
    proof: randomBytes(32).toString('base64url'),
  }));
  let disposable = false;
  const auth = (index: number) => ({
    authorization: 'Bearer ' + credentials[index].token,
    'x-device-proof': credentials[index].proof,
  });
  const base = (id: string, workshopId: string | null) => ({
    schemaVersion: 1, title: 'Workshop task', description: '', status: 'created',
    priority: 'medium', assignedTo: null as string | null, createdBy: chief,
    createdAt: '2026-11-08T10:00:00.000Z', updatedAt: '2026-11-08T10:00:00.000Z',
    dueDate: null, techCardId: null, stage: null, workshopId,
    comments: [], attachments: [],
  });
  const push = (index: number, id: string, payload: ReturnType<typeof base>, expectedRevision: number, operationId = randomUUID()) =>
    app.inject({
      method: 'POST', url: '/sync/push', headers: auth(index),
      payload: { operations: [{
        operationId, deviceId: index === 0 ? chiefDevice : index === 1 ? masterDevice : workerDevice,
        entityType: 'task', entityId: id, operationType: 'upsert',
        expectedRevision, payload,
      }] },
    });
  const pull = (index: number) => app.inject({
    method: 'GET', url: '/sync/pull?cursor=0&limit=100&deviceId=' + (index === 0 ? chiefDevice : index === 1 ? masterDevice : workerDevice),
    headers: auth(index),
  });
  const access = (index: number) => app.inject({
    method: 'GET', url: '/sync/task-access?deviceId=' + (index === 0 ? chiefDevice : index === 1 ? masterDevice : workerDevice),
    headers: auth(index),
  });
  const comparison = (index: number, id: string) => app.inject({
    method: 'GET', url: '/sync/task/' + id + '?deviceId=' + (index === 0 ? chiefDevice : index === 1 ? masterDevice : workerDevice),
    headers: auth(index),
  });

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/production_mf_ci')
      throw new Error('Refusing a non-disposable database');
    const db = await pool.query('SELECT current_database() AS name');
    expect(db.rows[0].name).toBe('production_mf_ci');
    disposable = true;
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [org, 'Workshop authorization fixture']);
    for (const [index, person] of credentials.entries()) {
      await pool.query('INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$3,$4,$5)', [
        person.user, org, 'scope-test-' + person.user, 'test-only', index === 0 ? 'chief' : index === 1 ? 'master' : 'worker',
      ]);
      const device = index === 0 ? chiefDevice : index === 1 ? masterDevice : workerDevice;
      await pool.query('INSERT INTO devices(id,organization_id,user_id) VALUES($1,$2,$3)', [device,org,person.user]);
      await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
        [randomUUID(),org,person.user,tokenHash(person.token)]);
      await pool.query("INSERT INTO device_proof_grants(token_hash,organization_id,user_id,device_id,session_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes')",
        [tokenHash(person.proof),org,person.user,device,tokenHash(person.token)]);
    }
    await pool.query("INSERT INTO workshops(organization_id,id,name) VALUES($1,'assembly','Assembly'),($1,'coating','Coating')",[org]);
    await pool.query("INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,'assembly')",[org,master]);
    await pool.query("INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,'assembly')",[org,worker]);
  });

  afterAll(async () => {
    try {
      if (disposable) {
        for (const table of ['sync_operations','sync_entities','user_workshop_memberships','device_proof_grants','device_challenges','sessions','devices','workshops','users']) {
          await pool.query('DELETE FROM ' + table + ' WHERE organization_id=$1',[org]);
        }
        await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
      }
    } finally { await app.close(); await pool.end(); }
  });

  it('restricts master pull and comparison to authorized workshops', async () => {
    for (const [id,workshop] of [[taskA,'assembly'],[taskB,'coating']] as const) {
      const created = await push(0,id,base(id,workshop),0);
      expect(created.statusCode).toBe(200);
      expect(created.json().results[0].status).toBe('accepted');
    }
    const chiefChanges = await pull(0);
    expect(chiefChanges.statusCode).toBe(200);
    expect(chiefChanges.json().changes.map((change: {entity_id: string}) => change.entity_id)).toEqual([taskA,taskB]);
    const masterChanges = await pull(1);
    expect(masterChanges.statusCode).toBe(200);
    expect(masterChanges.json().changes.map((change: {entity_id: string}) => change.entity_id)).toEqual([taskA]);
    expect((await access(0)).json().ids).toEqual([taskA, taskB].sort());
    expect((await access(1)).json().ids).toEqual([taskA]);
    expect((await access(2)).json().ids).toEqual([]);
    expect((await comparison(1,taskA)).statusCode).toBe(200);
    expect((await comparison(1,taskB)).statusCode).toBe(404);
  });

  it('lets a proven worker submit only assigned task progress, and revocation cuts access', async () => {
    const ownId = randomUUID(), otherId = randomUUID();
    const assigned = { ...base(ownId, 'assembly'), assignedTo: worker, status: 'assigned' };
    expect((await push(0, ownId, assigned, 0)).json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });
    expect((await push(0, otherId, base(otherId, 'assembly'), 0)).json().results[0])
      .toMatchObject({ status: 'accepted', revision: 1 });
    const visible = await pull(2);
    expect(visible.statusCode).toBe(200);
    expect(visible.json().changes.map((c: { entity_id: string }) => c.entity_id)).toContain(ownId);
    expect(visible.json().changes.map((c: { entity_id: string }) => c.entity_id)).not.toContain(otherId);
    expect((await access(2)).json().ids).toContain(ownId);
    expect((await access(2)).json().ids).not.toContain(otherId);
    expect((await comparison(2, ownId)).statusCode).toBe(200);
    expect((await comparison(2, otherId)).statusCode).toBe(404);

    const started = { ...assigned, status: 'in_progress', updatedAt: '2026-11-08T11:00:00.000Z' };
    const submitted = { ...assigned, status: 'checked', updatedAt: '2026-11-08T12:00:00.000Z' };
    const operationId = randomUUID();
    expect((await push(2, ownId, started, 1, operationId)).json().results[0])
      .toMatchObject({ status: 'accepted', revision: 2 });
    expect((await push(2, ownId, started, 1, operationId)).json().results[0])
      .toMatchObject({ status: 'duplicate', revision: 2 });
    expect((await push(2, ownId, submitted, 2)).json().results[0])
      .toMatchObject({ status: 'accepted', revision: 3 });
    const forbiddenEdit = await push(2, ownId, {
      ...submitted, status: 'in_progress', description: 'rewritten work instructions',
      updatedAt: '2026-11-08T13:00:00.000Z',
    }, 3);
    expect(forbiddenEdit.json().results[0]).toMatchObject({ status: 'rejected', reason: 'worker_may_only_update_status' });
    const forbiddenApproval = await push(2, ownId, {
      ...submitted, status: 'completed', updatedAt: '2026-11-08T13:00:00.000Z',
    }, 3);
    expect(forbiddenApproval.json().results[0]).toMatchObject({ status: 'rejected', reason: 'worker_status_transition_forbidden' });
    expect((await push(2, otherId, { ...base(otherId, 'assembly'), status: 'in_progress' }, 1)).json().results[0])
      .toMatchObject({ status: 'rejected', reason: 'task_not_assigned_to_worker' });
    expect((await push(2, randomUUID(), assigned, 0)).json().results[0])
      .toMatchObject({ status: 'rejected', reason: 'worker_cannot_create_task' });
    const stored = await pool.query('SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [org, ownId]);
    expect(stored.rows[0].revision).toBe(3);
    expect(stored.rows[0].payload.status).toBe('checked');
    expect(stored.rows[0].payload.description).toBe('');

    await pool.query('UPDATE devices SET revoked_at=now() WHERE id=$1',[workerDevice]);
    try {
      expect((await pull(2)).statusCode).toBe(403);
      expect((await comparison(2, ownId)).statusCode).toBe(403);
      expect((await access(2)).statusCode).toBe(403);
    } finally {
      await pool.query('UPDATE devices SET revoked_at=NULL WHERE id=$1',[workerDevice]);
    }
  });

  it('allows a master to update an authorized task but rejects foreign workshop writes', async () => {
    const accepted = await push(1,taskA,{ ...base(taskA,'assembly'), status: 'assigned', updatedAt: '2026-11-08T11:00:00.000Z' },1);
    expect(accepted.json().results[0]).toMatchObject({ status:'accepted', revision:2 });
    const denied = await push(1,taskB,{ ...base(taskB,'coating'), status: 'assigned', updatedAt: '2026-11-08T11:00:00.000Z' },1);
    expect(denied.json().results[0]).toMatchObject({ status:'rejected', reason:'workshop_access_denied' });
    const moved = await push(1,taskA,{ ...base(taskA,'coating'), status: 'assigned', updatedAt: '2026-11-08T12:00:00.000Z' },2);
    expect(moved.json().results[0]).toMatchObject({ status:'rejected', reason:'workshop_access_denied' });
    const stored = await pool.query('SELECT revision,payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',[org,taskA]);
    expect(stored.rows[0].revision).toBe(2);
    expect(stored.rows[0].payload.workshopId).toBe('assembly');
  });

  it('rejects out-of-workshop assignees for chiefs and masters, without changing stored revisions', async () => {
    const invalid = await push(0,taskB,{ ...base(taskB,'coating'), assignedTo: worker, updatedAt: '2026-11-08T12:00:00.000Z' },1);
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().results[0]).toMatchObject({ status: 'rejected', reason: 'assignee_outside_workshop' });

    const valid = await push(1,taskA,{ ...base(taskA,'assembly'), assignedTo: worker, status: 'assigned', updatedAt: '2026-11-08T12:00:00.000Z' },2);
    expect(valid.json().results[0]).toMatchObject({ status: 'accepted', revision: 3 });

    await pool.query("INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,'coating')",[org,worker]);
    const allowed = await push(0,taskB,{ ...base(taskB,'coating'), assignedTo: worker, status: 'assigned', updatedAt: '2026-11-08T12:00:00.000Z' },1);
    expect(allowed.json().results[0]).toMatchObject({ status: 'accepted', revision: 2 });

    await pool.query("DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2 AND workshop_id='assembly'",[org,worker]);
    const revoked = await push(1,taskA,{ ...base(taskA,'assembly'), assignedTo: worker, status: 'in_progress', updatedAt: '2026-11-08T13:00:00.000Z' },3);
    expect(revoked.json().results[0]).toMatchObject({ status: 'rejected', reason: 'assignee_outside_workshop' });
    const stored = await pool.query('SELECT revision FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',[org,taskA]);
    expect(stored.rows[0].revision).toBe(3);
  });

  it('rejects replay of a previously accepted operation after workshop access is revoked', async () => {
    const replayTask = randomUUID();
    const payload = base(replayTask, 'assembly');
    const operationId = randomUUID();
    const created = await push(0, replayTask, payload, 0);
    expect(created.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });
    const updatedPayload = { ...payload, status: 'assigned', updatedAt: '2026-11-08T11:00:00.000Z' };
    const first = await push(1, replayTask, updatedPayload, 1, operationId);
    expect(first.statusCode).toBe(200);
    expect(first.json().results[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const repeat = await push(1, replayTask, updatedPayload, 1, operationId);
    expect(repeat.json().results[0]).toMatchObject({ status: 'duplicate', revision: 2 });

    await pool.query(
      "DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2 AND workshop_id='assembly'",
      [org, master],
    );
    try {
      const denied = await push(1, replayTask, updatedPayload, 1, operationId);
      expect(denied.statusCode).toBe(200);
      expect(denied.json().results[0]).toMatchObject({
        status: 'rejected', reason: 'workshop_access_denied',
      });
      expect((await comparison(1, replayTask)).statusCode).toBe(404);
      expect((await access(1)).json().ids).not.toContain(replayTask);
      const count = await pool.query(
        'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1 AND entity_id=$2',
        [org, replayTask],
      );
      expect(count.rows[0].count).toBe(2);
    } finally {
      await pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,'assembly') ON CONFLICT DO NOTHING",
        [org, master],
      );
    }
  });

  it('does not let a master claim a chief-owned task that has no workshop', async () => {
    const unscopedTask = randomUUID();
    const original = base(unscopedTask, 'assembly');
    const created = await push(0, unscopedTask, { ...original, workshopId: null }, 0);
    expect(created.statusCode).toBe(200);
    expect(created.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });

    // A master is enrolled in assembly, but must not gain ownership by changing
    // an unscoped task's workshop to one where that master has membership.
    const attemptedClaim = await push(1, unscopedTask, {
      ...original, status: 'assigned', updatedAt: '2026-11-08T11:00:00.000Z',
    }, 1);
    expect(attemptedClaim.statusCode).toBe(200);
    expect(attemptedClaim.json().results[0]).toMatchObject({
      status: 'rejected', reason: 'workshop_access_denied',
    });
    expect((await comparison(1, unscopedTask)).statusCode).toBe(404);
    const persisted = await pool.query(
      'SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [org, unscopedTask],
    );
    expect(persisted.rows[0].revision).toBe(1);
    expect(persisted.rows[0].payload.workshopId).toBeNull();
    const operations = await pool.query(
      'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1 AND entity_id=$2',
      [org, unscopedTask],
    );
    expect(operations.rows[0].count).toBe(1);
  });

  it('converges two enrolled devices after competing offline edits without duplicate writes', async () => {
    const id = randomUUID();
    const initial = base(id, 'assembly');
    const created = await push(0, id, initial, 0);
    expect(created.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });

    // Each separately authenticated device sees the same initial server task.
    for (const index of [0, 1]) {
      const snapshot = await comparison(index, id);
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({ revision: 1 });
    }

    // Two offline snapshots both expect revision 1. Device A arrives first.
    const aOperation = randomUUID(), bOperation = randomUUID();
    const aEdit = { ...initial, title: 'Device A offline edit', updatedAt: '2026-11-08T14:00:00.000Z' };
    const bEdit = { ...initial, title: 'Device B offline edit', updatedAt: '2026-11-08T14:01:00.000Z' };
    expect((await push(0, id, aEdit, 1, aOperation)).json().results[0])
      .toMatchObject({ status: 'accepted', revision: 2 });
    const conflict = await push(1, id, bEdit, 1, bOperation);
    expect(conflict.statusCode).toBe(200);
    expect(conflict.json().results[0]).toMatchObject({ status: 'conflict', actualRevision: 2 });

    // A retry of the accepted operation is idempotent, not a third revision.
    expect((await push(0, id, aEdit, 1, aOperation)).json().results[0])
      .toMatchObject({ status: 'duplicate', revision: 2 });
    const authoritative = await comparison(1, id);
    expect(authoritative.json()).toMatchObject({ revision: 2 });
    expect(authoritative.json().payload.title).toBe('Device A offline edit');

    // Both device identities see the same authoritative version.
    const onA = await comparison(0, id);
    expect(onA.json()).toEqual(authoritative.json());
    const stored = await pool.query(
      'SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [org, id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].revision).toBe(2);
    expect(stored.rows[0].payload.title).toBe('Device A offline edit');
    const operations = await pool.query(
      'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1 AND entity_id=$2',
      [org, id],
    );
    expect(operations.rows[0].count).toBe(2);
  });

  it('removes access immediately when a master membership is revoked', async () => {
    await pool.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[org,master]);
    expect((await pull(1)).json().changes).toEqual([]);
    expect((await comparison(1,taskA)).statusCode).toBe(404);
    const denied = await push(1,taskA,{ ...base(taskA,'assembly'), status: 'assigned', updatedAt: '2026-11-08T13:00:00.000Z' },2);
    expect(denied.json().results[0]).toMatchObject({ status:'rejected', reason:'workshop_access_denied' });
  });
});
