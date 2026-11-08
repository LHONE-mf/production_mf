import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('PostgreSQL sync operation JSONB idempotency', () => {
  const connectionString = process.env.POSTGRES_TEST_URL;
  const pool = new Pool({ connectionString });
  const app = buildApp(pool);
  const org = randomUUID(), user = randomUUID(), task = randomUUID(), operationId = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  const keys = generateKeyPairSync('ed25519');
  const headers = { authorization: 'Bearer ' + accessToken };
  let deviceId: string;
  let proofToken: string;
  const payload = {
    schemaVersion: 1, title: 'Retry test', description: '', status: 'created',
    priority: 'medium', assignedTo: null, createdBy: user,
    createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
    dueDate: null, techCardId: null, stage: null, workshopId: null,
    comments: [], attachments: [],
  };
  const push = (body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/sync/push',
    headers: { ...headers, 'x-device-proof': proofToken },
    payload: { operations: [{
      operationId, deviceId, entityType: 'task', entityId: task,
      operationType: 'upsert', expectedRevision: 0, payload: body,
    }] },
  });

  beforeAll(async () => {
    const target = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci')
      throw new Error('Refusing a non-disposable database for integration tests');
    const database = await pool.query('SELECT current_database() AS name');
    expect(database.rows[0].name).toBe('production_mf_ci');
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [org, 'Disposable sync idempotency']);
    await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$3,$4,'chief')",
      [user, org, 'sync-test-' + user, 'not-a-password']);
    await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
      [randomUUID(), org, user, tokenHash(accessToken)]);
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const enrolled = await app.inject({
      method: 'POST', url: '/devices', headers, payload: { publicKey },
    });
    expect(enrolled.statusCode).toBe(201);
    deviceId = enrolled.json().id;
    const issued = await app.inject({
      method: 'POST', url: '/devices/challenge', headers, payload: { deviceId },
    });
    expect(issued.statusCode).toBe(200);
    const { challengeId, challenge } = issued.json();
    const signature = sign(null, Buffer.from('production-mf:device-proof:v1:' + challenge),
      keys.privateKey).toString('base64url');
    const verified = await app.inject({
      method: 'POST', url: '/devices/challenge/verify', headers,
      payload: { deviceId, challengeId, challenge, signature },
    });
    expect(verified.statusCode).toBe(200);
    proofToken = verified.json().proofToken;
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM sync_operations WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM sync_entities WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM device_proof_grants WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM device_challenges WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM sessions WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM devices WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM users WHERE organization_id=$1', [org]);
      await pool.query('DELETE FROM organizations WHERE id=$1', [org]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('accepts exact retries regardless of JSON field order and rejects modified payload', async () => {
    const accepted = await push(payload);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().results).toEqual([{ operationId, status: 'accepted', revision: 1 }]);

    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    const duplicate = await push(reordered);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().results).toEqual([{ operationId, status: 'duplicate', revision: 1 }]);

    const altered = await push({ ...payload, title: 'Changed after delivery' });
    expect(altered.statusCode).toBe(200);
    expect(altered.json().results).toEqual([
      { operationId, status: 'rejected', reason: 'operation_id_reused' },
    ]);

    const operations = await pool.query('SELECT count(*)::int AS count FROM sync_operations WHERE operation_id=$1', [operationId]);
    expect(operations.rows[0].count).toBe(1);
    const entity = await pool.query('SELECT revision,payload FROM sync_entities WHERE organization_id=$1 AND entity_id=$2', [org, task]);
    expect(entity.rows).toHaveLength(1);
    expect(entity.rows[0].revision).toBe(1);
    expect(entity.rows[0].payload.title).toBe(payload.title);
  });
});
