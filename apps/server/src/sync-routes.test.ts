import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

describe('sync endpoint guards', () => {
  it('requires authentication for push', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/sync/push', payload: { operations: [] } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('requires authentication for pull', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject('/sync/pull?cursor=0');
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
