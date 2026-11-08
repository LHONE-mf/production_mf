import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const actor = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333';
const token = 'A'.repeat(43);
const headers = { authorization: 'Bearer ' + token };
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();

function fakePool() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM sessions s') && sql.includes('JOIN users')) return { rows: [{ id: actor, organization_id: org, role: 'master' }], rowCount: 1 };
    if (sql.includes('SELECT id FROM devices')) return { rows: [{ id: device }], rowCount: 1 };
    if (sql.includes('SELECT public_key FROM devices')) return { rows: [{ public_key: publicKey }], rowCount: 1 };
    if (sql.includes('INSERT INTO device_challenges')) return { rows: [], rowCount: 1 };
    if (sql.includes('WITH consumed AS')) return { rows: [{ token_hash: 'ok' }], rowCount: 1 };
    throw new Error('unexpected SQL: ' + sql);
  });
  return { query };
}

describe('device challenge routes', () => {
  it('requires a session and validates challenge request', async () => {
    const app = buildApp(fakePool() as any);
    expect((await app.inject({ method: 'POST', url: '/devices/challenge', payload: { deviceId: device } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/devices/challenge', headers, payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it('issues a 32-byte challenge without persisting its plaintext', async () => {
    const pool = fakePool();
    const app = buildApp(pool as any);
    const response = await app.inject({ method: 'POST', url: '/devices/challenge', headers, payload: { deviceId: device } });
    expect(response.statusCode).toBe(200);
    expect(response.json().challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const insert = pool.query.mock.calls.find(call => call[0].includes('INSERT INTO device_challenges'))!;
    expect(JSON.stringify(insert[1])).not.toContain(response.json().challenge);
    await app.close();
  });

  it('accepts a valid Ed25519 signature and issues a bounded grant', async () => {
    const pool = fakePool();
    const app = buildApp(pool as any);
    const issued = (await app.inject({ method: 'POST', url: '/devices/challenge', headers, payload: { deviceId: device } })).json();
    const signature = sign(null, Buffer.from('production-mf:device-proof:v1:' + issued.challenge), keys.privateKey).toString('base64url');
    const response = await app.inject({ method: 'POST', url: '/devices/challenge/verify', headers,
      payload: { deviceId: device, challengeId: issued.challengeId, challenge: issued.challenge, signature } });
    expect(response.statusCode).toBe(200);
    expect(response.json().expiresIn).toBe(300);
    expect(response.json().proofToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const consume = pool.query.mock.calls.find(call => call[0].includes('WITH consumed AS'))!;
    expect(consume[0]).toContain('consumed_at IS NULL');
    expect(consume[0]).toContain('expires_at > now()');
    expect(consume[0]).toContain('INSERT INTO device_proof_grants');
    expect(consume[1]![1]).toBe(org);
    expect(consume[1]![2]).toBe(actor);
    expect(consume[1]![3]).toBe(device);
    await app.close();
  });

  it('enforces one-time consumption when the same signed challenge is replayed', async () => {
    const base = fakePool();
    let consumed = false;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('WITH consumed AS')) {
        if (consumed) return { rows: [], rowCount: 0 };
        consumed = true;
        return { rows: [{ token_hash: 'ok' }], rowCount: 1 };
      }
      return base.query(sql, params);
    });
    const app = buildApp({ query } as any);
    const issuedResponse = await app.inject({
      method: 'POST', url: '/devices/challenge', headers, payload: { deviceId: device },
    });
    expect(issuedResponse.statusCode).toBe(200);
    const issued = issuedResponse.json();
    const signature = sign(null, Buffer.from('production-mf:device-proof:v1:' + issued.challenge), keys.privateKey).toString('base64url');
    const request = {
      method: 'POST' as const, url: '/devices/challenge/verify', headers,
      payload: { deviceId: device, challengeId: issued.challengeId, challenge: issued.challenge, signature },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toEqual({ error: 'invalid_or_expired_challenge' });
    expect(query.mock.calls.filter(call => call[0].includes('WITH consumed AS'))).toHaveLength(2);
    await app.close();
  });

  it('rejects an incorrect signature without consuming the challenge', async () => {
    const pool = fakePool();
    const app = buildApp(pool as any);
    const response = await app.inject({ method: 'POST', url: '/devices/challenge/verify', headers,
      payload: { deviceId: device, challengeId: '44444444-4444-4444-8444-444444444444',
        challenge: 'B'.repeat(43), signature: 'A'.repeat(86) } });
    expect(response.statusCode).toBe(403);
    expect(pool.query.mock.calls.some(call => call[0].includes('WITH consumed AS'))).toBe(false);
    await app.close();
  });

  it('rejects consumed or expired challenges when the conditional database write returns no rows', async () => {
    const pool = fakePool();
    const original = pool.query;
    pool.query = vi.fn(async (sql: string, params?: unknown[]) => sql.includes('WITH consumed AS')
      ? { rows: [], rowCount: 0 } : original(sql, params));
    const app = buildApp(pool as any);
    const issued = (await app.inject({ method: 'POST', url: '/devices/challenge', headers, payload: { deviceId: device } })).json();
    const signature = sign(null, Buffer.from('production-mf:device-proof:v1:' + issued.challenge), keys.privateKey).toString('base64url');
    const response = await app.inject({ method: 'POST', url: '/devices/challenge/verify', headers,
      payload: { deviceId: device, challengeId: issued.challengeId, challenge: issued.challenge, signature } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
