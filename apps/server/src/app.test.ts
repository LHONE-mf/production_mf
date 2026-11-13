import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

describe('health endpoints', () => {
  it('responds to liveness checks', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject('/health/live');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
  it('accepts Android WebView and local-dev CORS preflights without widening access', async () => {
    const app = buildApp({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    for (const origin of ['https://localhost', 'http://localhost:5173']) {
      const preflight = await app.inject({
        method: 'OPTIONS', url: '/planning/orders',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(String(preflight.headers['access-control-allow-headers'])).toContain('authorization');
    }
    const denied = await app.inject({
      method: 'OPTIONS', url: '/planning/orders',
      headers: { origin: 'https://untrusted.example.net', 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    // CORS is a browser access control, never a replacement for server auth.
    const unauthorized = await app.inject({ method: 'GET', url: '/planning/orders',
      headers: { origin: 'https://localhost' } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['access-control-allow-origin']).toBe('https://localhost');
    await app.close();
  });

  it('returns 503 when database is unavailable', async () => {
    const app = buildApp({ query: vi.fn().mockRejectedValue(new Error('down')) } as any);
    const response = await app.inject('/health/ready');
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
