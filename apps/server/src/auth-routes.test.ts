import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildApp } from './app.js';

describe('authorization guards', () => {
  it('does not expose the current user without a session', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject('/auth/me');
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('rejects unauthenticated device enrollment', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/devices', payload: { publicKey: 'x'.repeat(64) } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('requires authentication to list enrolled devices', async () => {
    const query = vi.fn();
    const app = buildApp({ query } as any);
    const response = await app.inject('/devices/mine');
    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it('lists only active devices belonging to the authenticated user', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const token = 'A'.repeat(43);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: actorId, organization_id: orgId, role: 'master' }] })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-4333-8333-333333333333' }] });
    const app = buildApp({ query } as any);
    const response = await app.inject({ method: 'GET', url: '/devices/mine', headers: { authorization: 'Bearer ' + token } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ devices: [{ id: '33333333-3333-4333-8333-333333333333' }] });
    expect(query.mock.calls[1][1]).toEqual([orgId, actorId]);
    await app.close();
  });
  it('rejects non-Ed25519 device enrollment before inserting records', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: actorId, organization_id: orgId, role: 'chief' }] });
    const app = buildApp({ query } as any);
    const response = await app.inject({
      method: 'POST', url: '/devices',
      headers: { authorization: 'Bearer ' + 'A'.repeat(43) },
      payload: { publicKey: rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_device_public_key' });
    expect(query).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('enrolls a canonical Ed25519 key only for an active user in the same organization', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: actorId, organization_id: orgId, role: 'chief' }] })
      .mockResolvedValueOnce({ rows: [{ id: actorId }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const app = buildApp({ query } as any);
    const response = await app.inject({
      method: 'POST', url: '/devices',
      headers: { authorization: 'Bearer ' + 'A'.repeat(43) },
      payload: { publicKey },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().userId).toBe(actorId);
    expect(query.mock.calls[1][0]).toContain('organization_id = $2 AND active = true');
    expect(query.mock.calls[1][1]).toEqual([actorId, orgId]);
    expect(query.mock.calls[2][0]).toContain('INSERT INTO devices');
    expect(query.mock.calls[2][1][1]).toBe(orgId);
    expect(query.mock.calls[2][1][2]).toBe(actorId);
    expect(query.mock.calls[2][1][3]).toBe(publicKey);
    await app.close();
  });
  it('does not enroll an Ed25519 key for a user outside the organization', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const otherUserId = '33333333-3333-4333-8333-333333333333';
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: actorId, organization_id: orgId, role: 'chief' }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = buildApp({ query } as any);
    const response = await app.inject({
      method: 'POST', url: '/devices',
      headers: { authorization: 'Bearer ' + 'A'.repeat(43) },
      payload: { userId: otherUserId, publicKey },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('user_not_found');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([otherUserId, orgId]);
    await app.close();
  });
  it('validates login payloads', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
