import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

describe('sync endpoint guards', () => {
  it('requires authentication for push', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject({ method: 'POST', url: '/sync/push', payload: { operations: [] } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('requires authentication for task comparison', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject('/sync/task/11111111-1111-4111-8111-111111111111');
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('does not expose a task without a session even for malformed identifiers', async () => {
    const query = vi.fn();
    const app = buildApp({ query } as any);
    const response = await app.inject('/sync/task/not-a-uuid');
    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it('requires authentication for pull', async () => {
    const app = buildApp({ query: vi.fn() } as any);
    const response = await app.inject('/sync/pull?cursor=0');
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
