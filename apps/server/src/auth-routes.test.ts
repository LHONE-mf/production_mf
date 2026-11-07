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
  it('validates login payloads', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
