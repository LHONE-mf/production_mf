import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

/**
 * Real PostgreSQL integration test. Only enabled in CI with an isolated database.
 * Never point POSTGRES_TEST_URL at an existing production database.
 */
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('Ed25519 challenge replay protection with PostgreSQL', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL, max: 8 });
  const app = buildApp(pool);
  const organizationId = randomUUID();
  const userId = randomUUID();
  const accessToken = randomBytes(32).toString('base64url');
  const headers = { authorization: 'Bearer ' + accessToken };
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  let deviceId: string;

  const signChallenge = (challenge: string) =>
    sign(null, Buffer.from('production-mf:device-proof:v1:' + challenge, 'utf8'), keys.privateKey).toString('base64url');

  const issue = async () => {
    const result = await app.inject({
      method: 'POST', url: '/devices/challenge', headers, payload: { deviceId },
    });
    expect(result.statusCode).toBe(200);
    return result.json() as { challengeId: string; challenge: string };
  };

  const verify = (challengeId: string, challenge: string, signature = signChallenge(challenge)) =>
    app.inject({
      method: 'POST', url: '/devices/challenge/verify', headers,
      payload: { deviceId, challengeId, challenge, signature },
    });

  beforeAll(async () => {
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Isolated CI integration']);
    await pool.query(`INSERT INTO users (id, organization_id, login, password_hash, role)
      VALUES ($1, $2, $3, $4, 'chief')`, [userId, organizationId, 'pg-integration-' + userId, 'test-not-a-login']);
    await pool.query(`INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
      [randomUUID(), organizationId, userId, tokenHash(accessToken)]);
    const enrolled = await app.inject({
      method: 'POST', url: '/devices', headers, payload: { publicKey },
    });
    expect(enrolled.statusCode).toBe(201);
    deviceId = (enrolled.json() as { id: string }).id;
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM device_proof_grants WHERE organization_id=$1', [organizationId]);
      await pool.query('DELETE FROM device_challenges WHERE organization_id=$1', [organizationId]);
      await pool.query('DELETE FROM sessions WHERE organization_id=$1', [organizationId]);
      await pool.query('DELETE FROM devices WHERE organization_id=$1', [organizationId]);
      await pool.query('DELETE FROM users WHERE organization_id=$1', [organizationId]);
      await pool.query('DELETE FROM organizations WHERE id=$1', [organizationId]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('enrolls Ed25519 and stores only a challenge hash before issuing proof', async () => {
    const issued = await issue();
    const rows = await pool.query(
      'SELECT challenge_hash, consumed_at, expires_at FROM device_challenges WHERE id=$1',
      [issued.challengeId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].challenge_hash).toBe(tokenHash(issued.challenge));
    expect(rows.rows[0].challenge_hash).not.toBe(issued.challenge);
    expect(rows.rows[0].consumed_at).toBeNull();
    const response = await verify(issued.challengeId, issued.challenge);
    expect(response.statusCode).toBe(200);
    const grant = response.json() as { proofToken: string; deviceId: string; expiresIn: number };
    expect(grant.deviceId).toBe(deviceId);
    expect(grant.expiresIn).toBe(300);
    expect(grant.proofToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await pool.query('SELECT token_hash FROM device_proof_grants WHERE token_hash=$1', [tokenHash(grant.proofToken)]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].token_hash).not.toBe(grant.proofToken);
  });

  it('consumes a challenge exactly once under simultaneous verified requests', async () => {
    const issued = await issue();
    const signature = signChallenge(issued.challenge);
    const results = await Promise.all([
      verify(issued.challengeId, issued.challenge, signature),
      verify(issued.challengeId, issued.challenge, signature),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 403]);
    expect(results.filter(result => result.statusCode === 403)[0].json())
      .toEqual({ error: 'invalid_or_expired_challenge' });
    const consumed = await pool.query(
      'SELECT consumed_at FROM device_challenges WHERE id=$1', [issued.challengeId],
    );
    expect(consumed.rows[0].consumed_at).not.toBeNull();
    const grants = await pool.query(
      'SELECT count(*)::int AS count FROM device_proof_grants WHERE organization_id=$1 AND device_id=$2',
      [organizationId, deviceId],
    );
    // One earlier grant + exactly one newly issued by the concurrent race.
    expect(grants.rows[0].count).toBe(2);
  });

  it('rejects a bad signature without consuming the challenge', async () => {
    const issued = await issue();
    const invalid = sign(null, Buffer.from('wrong message'), keys.privateKey).toString('base64url');
    const response = await verify(issued.challengeId, issued.challenge, invalid);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'invalid_device_proof' });
    const state = await pool.query('SELECT consumed_at FROM device_challenges WHERE id=$1', [issued.challengeId]);
    expect(state.rows[0].consumed_at).toBeNull();
  });

  it('rejects an expired challenge even with a genuine signature', async () => {
    const issued = await issue();
    await pool.query(`UPDATE device_challenges SET expires_at=now() - interval '1 second' WHERE id=$1`, [issued.challengeId]);
    const response = await verify(issued.challengeId, issued.challenge);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'invalid_or_expired_challenge' });
  });
});
