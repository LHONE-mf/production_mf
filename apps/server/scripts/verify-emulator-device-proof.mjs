#!/usr/bin/env node
/**
 * CI-only bridge test: enroll an emulator-generated Ed25519 SPKI through the
 * real Fastify route, then verify its signature with a disposable PostgreSQL DB.
 *
 * The emulator instrumentation signs a fixed *test-only* challenge. We seed
 * that exact challenge into the isolated database to exercise verification and
 * replay protection; this is NOT a full dynamically-issued challenge round trip.
 * Never run this against an existing or production database.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { buildApp } from '../dist/app.js';

const url = process.env.POSTGRES_TEST_URL;
const logFile = process.argv[2];
if (!logFile || !url || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('Requires emulator log path, isolated POSTGRES_TEST_URL and GitHub Actions');
const parsedUrl = new URL(url);
if (parsedUrl.hostname !== 'localhost' || parsedUrl.pathname !== '/production_mf_emulator_ci')
  throw new Error('Refusing non-isolated PostgreSQL database');

const log = await readFile(logFile, 'utf8');
const matches = [...log.matchAll(/\bVECTOR spki=([A-Za-z0-9_-]+) signature=([A-Za-z0-9_-]+)/g)];
assert.equal(matches.length, 1, 'Exactly one AndroidKeyStore test vector required');
const spki = Buffer.from(matches[0][1], 'base64url');
const signature = matches[0][2];
assert.equal(spki.length, 44);
assert.equal(Buffer.from(signature, 'base64url').length, 64);
const pem = createPublicKey({ key: spki, type: 'spki', format: 'der' })
  .export({ type: 'spki', format: 'pem' }).toString();

const sha256 = (input) => createHash('sha256').update(input).digest('hex');
const challenge = 'A'.repeat(43);
const organizationId = randomUUID();
const userId = randomUUID();
const sessionToken = randomBytes(32).toString('base64url');
const headers = { authorization: 'Bearer ' + sessionToken };
const pool = new Pool({ connectionString: url });
const app = buildApp(pool);
let deviceId;
try {
  const db = await pool.query('SELECT current_database() AS name');
  assert.equal(db.rows[0].name, 'production_mf_emulator_ci');
  await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [organizationId, 'Emulator CI only']);
  await pool.query(`INSERT INTO users(id, organization_id, login, password_hash, role)
    VALUES($1,$2,$3,$4,'chief')`, [userId, organizationId, 'emulator-' + userId, 'unused-ci']);
  await pool.query(`INSERT INTO sessions(id, organization_id, user_id, token_hash, expires_at)
    VALUES($1,$2,$3,$4,now() + interval '30 minutes')`,
  [randomUUID(), organizationId, userId, sha256(sessionToken)]);

  const enrollment = await app.inject({
    method: 'POST', url: '/devices', headers, payload: { publicKey: pem },
  });
  assert.equal(enrollment.statusCode, 201, 'Android public key must be enrollable');
  deviceId = enrollment.json().id;

  const issued = await app.inject({
    method: 'POST', url: '/devices/challenge', headers, payload: { deviceId },
  });
  assert.equal(issued.statusCode, 200, 'Server must issue random challenges');
  assert.match(issued.json().challenge, /^[A-Za-z0-9_-]{43}$/);
  const issuedHash = await pool.query('SELECT challenge_hash FROM device_challenges WHERE id=$1', [issued.json().challengeId]);
  assert.equal(issuedHash.rows[0].challenge_hash, sha256(issued.json().challenge));

  // Production endpoint stays unchanged. Seed fixed signed fixture in disposable CI DB only.
  const challengeId = randomUUID();
  await pool.query(`INSERT INTO device_challenges
    (id,organization_id,user_id,device_id,session_token_hash,challenge_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now() + interval '2 minutes')`,
  [challengeId, organizationId, userId, deviceId, sha256(sessionToken), sha256(challenge)]);

  const request = {
    method: 'POST', url: '/devices/challenge/verify', headers,
    payload: { deviceId, challengeId, challenge, signature },
  };
  const verified = await app.inject(request);
  assert.equal(verified.statusCode, 200,
    'Fastify must accept AndroidKeyStore signature with PostgreSQL challenge');
  assert.equal(verified.json().deviceId, deviceId);
  assert.equal(verified.json().expiresIn, 300);
  const storedGrant = await pool.query(
    'SELECT token_hash FROM device_proof_grants WHERE token_hash=$1',
    [sha256(verified.json().proofToken)],
  );
  assert.equal(storedGrant.rowCount, 1, 'Grant must persist only a hashed token');

  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 403, 'Signature replay must fail');
  assert.equal(replay.json().error, 'invalid_or_expired_challenge');

  const wrongChallenge = await app.inject({
    ...request, payload: { ...request.payload, challenge: 'B'.repeat(43) },
  });
  assert.equal(wrongChallenge.statusCode, 403, 'Wrong challenge must fail');

  console.log('PASS: emulator Ed25519 public key enrolled, Android signature accepted by Fastify/PostgreSQL, replay rejected.');
} finally {
  // The database is disposable, but clean test rows to detect schema/FK issues.
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
}
