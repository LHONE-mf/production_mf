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
  it('returns 503 when database is unavailable', async () => {
    const app = buildApp({ query: vi.fn().mockRejectedValue(new Error('down')) } as any);
    const response = await app.inject('/health/ready');
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
