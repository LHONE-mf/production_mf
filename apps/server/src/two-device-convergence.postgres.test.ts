import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

/**
 * Two independently enrolled devices, a shared organization session and a
 * disposable real PostgreSQL server. This tests the sync wire contract rather
 * than pretending that two in-memory objects are separate Android devices.
 */
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('two-device offline conflict and reconnection (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL, max: 8 });
  const app = buildApp(pool);
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const taskId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const devices = [0, 1].map(() => ({
    id: randomUUID(), proof: randomBytes(32).toString('base64url'),
  }));
  let disposable = false;

  const headers = (deviceIndex: number) => ({
    authorization: 'Bearer ' + token,
    'x-device-proof': devices[deviceIndex].proof,
  });
  const task = (title: string, status: 'created' | 'assigned', updatedAt: string) => ({
    schemaVersion: 1, title, description: 'Operator instructions',
    status, priority: 'medium', assignedTo: null, createdBy: actorId,
    createdAt: '2026-11-08T10:00:00.000Z', updatedAt,
    dueDate: null, techCardId: null, stage: null, workshopId: null,
    comments: [], attachments: [],
  });
  const create = task('Original task', 'created', '2026-11-08T10:00:00.000Z');
  const deviceEdit = (index: number, operationId: string, expectedRevision: number,
    payload: ReturnType<typeof task>) => app.inject({
      method: 'POST', url: '/sync/push', headers: headers(index),
      payload: { operations: [{
        operationId, deviceId: devices[index].id, entityType: 'task',
        entityId: taskId, operationType: 'upsert', expectedRevision, payload,
      }] },
    });
  const compare = (index: number) => app.inject({
    method: 'GET', url: '/sync/task/' + taskId + '?deviceId=' + devices[index].id,
    headers: headers(index),
  });
  const pull = (index: number, cursor: number) => app.inject({
    method: 'GET', url: '/sync/pull?cursor=' + cursor + '&limit=100&deviceId=' + devices[index].id,
    headers: headers(index),
  });

  beforeAll(async () => {
    const destination = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(destination.hostname) ||
        destination.pathname !== '/production_mf_ci') {
      throw new Error('Refusing to run two-device tests outside disposable CI PostgreSQL');
    }
    const db = await pool.query('SELECT current_database() AS database');
    expect(db.rows[0].database).toBe('production_mf_ci');
    disposable = true;
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [organizationId, 'Disposable two-device test']);
    await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$3,'test-only','chief')",
      [actorId, organizationId, 'two-device-' + actorId]);
    await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
      [randomUUID(), organizationId, actorId, tokenHash(token)]);
    for (const device of devices) {
      await pool.query('INSERT INTO devices(id,organization_id,user_id) VALUES($1,$2,$3)',
        [device.id, organizationId, actorId]);
      await pool.query("INSERT INTO device_proof_grants(token_hash,organization_id,user_id,device_id,session_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes')",
        [tokenHash(device.proof), organizationId, actorId, device.id, tokenHash(token)]);
    }
  });

  afterAll(async () => {
    try {
      if (disposable) {
        for (const table of [
          'sync_operations', 'sync_entities', 'device_proof_grants',
          'device_challenges', 'sessions', 'devices', 'users',
        ]) await pool.query('DELETE FROM ' + table + ' WHERE organization_id=$1', [organizationId]);
        await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
      }
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('converges after conflicting offline updates without accepting the stale write', async () => {
    const created = await deviceEdit(0, randomUUID(), 0, create);
    expect(created.statusCode).toBe(200);
    expect(created.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });

    // Both devices have downloaded the original revision before disconnecting.
    for (const index of [0, 1]) {
      const snapshot = await compare(index);
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({ revision: 1, payload: { title: 'Original task' } });
    }
    const initialCursor = Number((await pull(0, 0)).json().nextCursor);
    expect(initialCursor).toBeGreaterThan(0);
    const editA = task('Approved by device A', 'assigned', '2026-11-08T11:00:00.000Z');
    const editB = task('Offline changes on device B', 'assigned', '2026-11-08T12:00:00.000Z');
    const opA = randomUUID(), opB = randomUUID();

    // Both started from the same revision; only the first may commit.
    const winner = await deviceEdit(0, opA, 1, editA);
    expect(winner.statusCode).toBe(200);
    expect(winner.json().results[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const losing = await deviceEdit(1, opB, 1, editB);
    expect(losing.statusCode).toBe(200);
    expect(losing.json().results[0]).toMatchObject({ status: 'conflict', actualRevision: 2 });
    expect((await compare(1)).json()).toMatchObject({
      revision: 2, payload: { title: 'Approved by device A' },
    });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1',
      [organizationId],
    )).rows[0].count).toBe(2);

    const afterFirstEdit = await pull(1, initialCursor);
    expect(afterFirstEdit.json().changes).toHaveLength(1);
    const firstEditCursor = Number(afterFirstEdit.json().nextCursor);

    // Replaying an accepted operation is idempotent, not a second mutation.
    const retried = await deviceEdit(0, opA, 1, editA);
    expect(retried.json().results[0]).toMatchObject({ status: 'duplicate', revision: 2 });

    // After manual review, device B creates a fresh operation against revision 2.
    const merged = task('Device B revision after review', 'assigned', '2026-11-08T13:00:00.000Z');
    const rebased = await deviceEdit(1, randomUUID(), 2, merged);
    expect(rebased.json().results[0]).toMatchObject({ status: 'accepted', revision: 3 });

    // Both devices reconnect: the ledger and direct read agree on one revision.
    const changesA = await pull(0, firstEditCursor);
    const changesB = await pull(1, initialCursor);
    expect(changesA.statusCode).toBe(200);
    expect(changesB.statusCode).toBe(200);
    expect(changesA.json().changes).toEqual([expect.objectContaining({
      revision: 3, payload: expect.objectContaining({ title: merged.title }),
    })]);
    expect(changesB.json().changes.map((change: {revision: number}) => change.revision)).toEqual([2, 3]);
    for (const index of [0, 1]) {
      expect((await compare(index)).json()).toMatchObject({
        revision: 3, payload: { title: merged.title, status: 'assigned' },
      });
    }
    const final = await pool.query(
      'SELECT revision,payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [organizationId, taskId],
    );
    expect(final.rows).toHaveLength(1);
    expect(final.rows[0].revision).toBe(3);
    expect(final.rows[0].payload.title).toBe(merged.title);
    const committed = await pool.query(
      'SELECT revision FROM sync_operations WHERE organization_id=$1 AND entity_id=$2 ORDER BY sequence',
      [organizationId, taskId],
    );
    expect(committed.rows.map(row => row.revision)).toEqual([1, 2, 3]);
  });
  it('serializes truly simultaneous device submissions and commits only one revision', async () => {
    const concurrentTaskId = randomUUID();
    const send = (index: number, expectedRevision: number, payload: ReturnType<typeof task>) =>
      app.inject({
        method: 'POST', url: '/sync/push', headers: headers(index),
        payload: { operations: [{
          operationId: randomUUID(), deviceId: devices[index].id,
          entityType: 'task', entityId: concurrentTaskId,
          operationType: 'upsert', expectedRevision, payload,
        }] },
      });
    const created = await send(0, 0, create);
    expect(created.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });
    const results = await Promise.all([
      send(0, 1, task('Concurrent A', 'assigned', '2026-11-08T11:00:00.000Z')),
      send(1, 1, task('Concurrent B', 'assigned', '2026-11-08T12:00:00.000Z')),
    ]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    const acknowledgements = results.map(result => result.json().results[0]);
    expect(acknowledgements.map(result => result.status).sort()).toEqual(['accepted', 'conflict']);
    expect(acknowledgements.find(result => result.status === 'accepted').revision).toBe(2);
    expect(acknowledgements.find(result => result.status === 'conflict').actualRevision).toBe(2);
    const state = await pool.query(
      'SELECT revision,payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [organizationId, concurrentTaskId],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].revision).toBe(2);
    expect(['Concurrent A', 'Concurrent B']).toContain(state.rows[0].payload.title);
    const ledger = await pool.query(
      'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1 AND entity_id=$2',
      [organizationId, concurrentTaskId],
    );
    expect(ledger.rows[0].count).toBe(2);
  });

  it('binds idempotent operation IDs to the originating device and immutable payload', async () => {
    const isolatedTaskId = randomUUID();
    const operationId = randomUUID();
    const original = task('Authenticated device A operation', 'created', '2026-11-08T10:00:00.000Z');
    const attempt = (deviceIndex: number, payload: ReturnType<typeof task>) => app.inject({
      method: 'POST', url: '/sync/push', headers: headers(deviceIndex),
      payload: { operations: [{
        operationId, deviceId: devices[deviceIndex].id, entityType: 'task',
        entityId: isolatedTaskId, operationType: 'upsert', expectedRevision: 0, payload,
      }] },
    });
    const accepted = await attempt(0, original);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().results[0]).toMatchObject({ status: 'accepted', revision: 1 });

    // A lost acknowledgement is safe to retry from the same enrolled device.
    const retried = await attempt(0, original);
    expect(retried.json().results[0]).toMatchObject({ status: 'duplicate', revision: 1 });

    // Even the same signed-in actor cannot transfer an operation to another device.
    const otherDevice = await attempt(1, original);
    expect(otherDevice.json().results[0]).toMatchObject({
      status: 'rejected', reason: 'operation_id_reused',
    });

    // Nor can the original device reuse an operation ID with modified content.
    const altered = await attempt(0, { ...original, title: 'Altered retry' });
    expect(altered.json().results[0]).toMatchObject({
      status: 'rejected', reason: 'operation_id_reused',
    });

    const stored = await pool.query(
      'SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2',
      [organizationId, isolatedTaskId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].revision).toBe(1);
    expect(stored.rows[0].payload.title).toBe(original.title);
    const operations = await pool.query(
      'SELECT count(*)::int AS count FROM sync_operations WHERE organization_id=$1 AND entity_id=$2',
      [organizationId, isolatedTaskId],
    );
    expect(operations.rows[0].count).toBe(1);
  });

});
