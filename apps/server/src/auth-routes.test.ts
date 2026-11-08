import { describe, expect, it, vi } from 'vitest';
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
  it('validates login payloads', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
