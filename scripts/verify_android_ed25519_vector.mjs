#!/usr/bin/env node
/**
 * Cross-runtime authentication check: verify a TEST-ONLY AndroidKeyStore Ed25519
 * signature with node:crypto, the primitive used by Production MF's Fastify server.
 *
 * The vector is emitted by DeviceProofKeystoreTest; it contains no private key,
 * production credentials or real server-issued challenge.
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/verify_android_ed25519_vector.mjs <emulator-logcat>');
  process.exit(2);
}

const log = readFileSync(path, 'utf8');
const vectors = [...log.matchAll(/\bVECTOR spki=([A-Za-z0-9_-]+) signature=([A-Za-z0-9_-]+)/g)];
assert.equal(vectors.length, 1, 'Expected exactly one instrumentation Ed25519 vector in logcat');

const spki = Buffer.from(vectors[0][1], 'base64url');
const signature = Buffer.from(vectors[0][2], 'base64url');
assert.equal(spki.length, 44, 'Expected 44-byte RFC 8410 Ed25519 SPKI');
assert.equal(signature.length, 64, 'Expected 64-byte Ed25519 signature');
const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
assert.equal(key.asymmetricKeyType, 'ed25519');

const challenge = 'A'.repeat(43);
const payload = Buffer.from('production-mf:device-proof:v1:' + challenge, 'utf8');
assert.equal(verify(null, payload, key, signature), true,
  'Android-generated signature must verify using Node Ed25519');
assert.equal(verify(null, Buffer.from('production-mf:device-proof:v1:' + 'B'.repeat(43)), key, signature), false,
  'A signature must not validate against a different challenge');
assert.equal(verify(null, Buffer.from(challenge), key, signature), false,
  'A signature must not validate without device-proof domain separation');

console.log('PASS: AndroidKeyStore Ed25519 signature verified by Node crypto; wrong challenge/domain rejected.');
