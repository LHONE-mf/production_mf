#!/usr/bin/env node
/**
 * CI-only, two-stage fresh challenge verification against real Fastify/PostgreSQL.
 * The Android test reuses a non-exportable TEST-ONLY keystore alias across two
 * instrumentation invocations. The backend enrolls its SPKI, issues a random
 * challenge, and later consumes the signature actually produced by Android.
 *
 * Never point this script at production: it rejects non-local and non-CI DBs.
 * Session token is stored only in a mode-0600 file under RUNNER_TEMP.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { Pool } from 'pg';
import { buildApp } from '../dist/app.js';

const [stage, logPath, statePath] = process.argv.slice(2);
const url = process.env.POSTGRES_TEST_URL;
if (!['prepare', 'finish'].includes(stage) || !logPath || !statePath ||
    process.env.GITHUB_ACTIONS !== 'true' || !url)
  throw new Error('Usage: prepare|finish <test-vector-log> <RUNNER_TEMP/state.json> in CI');
const location = new URL(url);
if (!['localhost', '127.0.0.1'].includes(location.hostname) ||
    location.pathname !== '/production_mf_emulator_ci' ||
    !statePath.startsWith(process.env.RUNNER_TEMP + '/'))
  throw new Error('Refusing non-isolated PostgreSQL or non-temporary state file');

const digest = (s) => createHash('sha256').update(s).digest('hex');
async function vector(path) {
  const log = await readFile(path, 'utf8');
  const matches = [...log.matchAll(/\bVECTOR spki=([A-Za-z0-9_-]+) signature=([A-Za-z0-9_-]+)/g)];
  assert.equal(matches.length, 1, 'Exactly one Android test signature expected');
  const spki = Buffer.from(matches[0][1], 'base64url');
  assert.equal(spki.length, 44, 'Must be RFC8410 Ed25519 SPKI');
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(Buffer.from(matches[0][2], 'base64url').length, 64);
  return { spki: matches[0][1], signature: matches[0][2],
    pem: key.export({ format: 'pem', type: 'spki' }).toString() };
}

const pool = new Pool({ connectionString: url });
const app = buildApp(pool);
let state;
try {
  const database = await pool.query('SELECT current_database() AS name');
  assert.equal(database.rows[0].name, 'production_mf_emulator_ci');
  if (stage === 'prepare') {
    const initial = await vector(logPath);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const sessionToken = randomBytes(32).toString('base64url');
    const headers = { authorization: 'Bearer ' + sessionToken };
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)',
      [organizationId, 'Disposable emulator dynamic challenge']);
    await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$3,$4,'chief')",
      [userId, organizationId, 'emulator-' + userId, 'ci-test-only']);
    await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now() + interval '30 minutes')",
      [randomUUID(), organizationId, userId, digest(sessionToken)]);
    const enrolled = await app.inject({
      method: 'POST', url: '/devices', headers, payload: { publicKey: initial.pem },
    });
    assert.equal(enrolled.statusCode, 201, 'Fastify enrollment failed');
    const deviceId = enrolled.json().id;
    const issued = await app.inject({
      method: 'POST', url: '/devices/challenge', headers, payload: { deviceId },
    });
    assert.equal(issued.statusCode, 200, 'Fastify challenge issuance failed');
    const { challengeId, challenge } = issued.json();
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(challenge, 'A'.repeat(43), 'Server challenge must not use fixed fixture');
    const row = await pool.query('SELECT challenge_hash FROM device_challenges WHERE id=$1', [challengeId]);
    assert.equal(row.rows[0].challenge_hash, digest(challenge));
    state = { organizationId, userId, sessionToken, deviceId, challengeId, challenge, spki: initial.spki };
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    console.log('Prepared a fresh server-issued challenge for the AndroidKeyStore test.');
  } else {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    const signed = await vector(logPath);
    assert.equal(signed.spki, state.spki, 'Android must sign with the same enrolled device key');
    const headers = { authorization: 'Bearer ' + state.sessionToken };
    const request = {
      method: 'POST', url: '/devices/challenge/verify', headers,
      payload: {
        deviceId: state.deviceId, challengeId: state.challengeId,
        challenge: state.challenge, signature: signed.signature,
      },
    };
    const verified = await app.inject(request);
    assert.equal(verified.statusCode, 200, 'Server must accept fresh Android-signed challenge');
    assert.equal(verified.json().deviceId, state.deviceId);
    const stored = await pool.query('SELECT token_hash FROM device_proof_grants WHERE token_hash=$1',
      [digest(verified.json().proofToken)]);
    assert.equal(stored.rowCount, 1, 'Only the hash of the proof grant must be stored');
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 403, 'Fresh challenge must be consumed exactly once');
    assert.equal(replay.json().error, 'invalid_or_expired_challenge');
    console.log('PASS: Fastify-issued fresh challenge signed by AndroidKeyStore, verified with PostgreSQL and replay rejected.');
  }
} finally {
  if (stage === 'finish' && state?.organizationId) {
    try {
      await pool.query('DELETE FROM device_proof_grants WHERE organization_id=$1', [state.organizationId]);
      await pool.query('DELETE FROM device_challenges WHERE organization_id=$1', [state.organizationId]);
      await pool.query('DELETE FROM sessions WHERE organization_id=$1', [state.organizationId]);
      await pool.query('DELETE FROM devices WHERE organization_id=$1', [state.organizationId]);
      await pool.query('DELETE FROM users WHERE organization_id=$1', [state.organizationId]);
      await pool.query('DELETE FROM organizations WHERE id=$1', [state.organizationId]);
      await unlink(statePath);
    } finally {
      await app.close();
      await pool.end();
    }
  } else {
    await app.close();
    await pool.end();
  }
}
