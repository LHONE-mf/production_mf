import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = new Map<string, { key: string; value: number }>();
let operations = 0;
let revisions = 0;
vi.mock('../db', () => ({
  db: {
    hybridSyncMetadata: {
      where: () => ({ startsWith: (prefix: string) => ({ toArray: async () => [...state.values()].filter(x => x.key.startsWith(prefix)) }) }),
      get: async (key: string) => state.get(key),
      put: async (record: { key: string; value: number }) => { state.set(record.key, record); },
    },
    hybridTaskOutbox: { count: async () => operations },
    hybridTaskRevisions: { count: async () => revisions },
    transaction: async (_mode: string, _metadata: unknown, _outbox: unknown, _revisions: unknown, fn: () => Promise<void>) => fn(),
  },
}));
import { assertSyncTenant } from './tenantGuard';

const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { state.clear(); operations = 0; revisions = 0; });

describe('single-tenant sync guard', () => {
  it('binds a clean device and permits reconnecting to the same tenant', async () => {
    await assertSyncTenant('https://example.com', org);
    await assertSyncTenant('https://example.com/', org);
    expect([...state.keys()]).toEqual(['syncTenant:https://example.com:' + org]);
  });
  it('pins a fresh installation to one authenticated server actor without storing tokens', async () => {
    const actor = '33333333-3333-4333-8333-333333333333';
    await assertSyncTenant('https://example.com', org, actor);
    await assertSyncTenant('https://example.com/', org, actor);
    expect([...state.keys()]).toEqual([
      'syncTenant:https://example.com:' + org,
      'syncActor:https://example.com:' + org + ':' + actor,
    ]);
    expect([...state.values()].every(record => record.value === 1)).toBe(true);
    await expect(assertSyncTenant('https://example.com', org,
      '44444444-4444-4444-8444-444444444444')).rejects.toThrow('another server user');
    expect([...state.keys()]).toHaveLength(2);
  });

  it('refuses to claim an existing unidentified task queue for a new account', async () => {
    const actor = '33333333-3333-4333-8333-333333333333';
    await assertSyncTenant('https://example.com', org);
    operations = 1;
    await expect(assertSyncTenant('https://example.com', org, actor))
      .rejects.toThrow('no verified user ownership');
    expect([...state.keys()]).toEqual(['syncTenant:https://example.com:' + org]);
  });

  it('blocks switching organizations', async () => {
    await assertSyncTenant('https://example.com', org);
    await expect(assertSyncTenant('https://example.com', otherOrg)).rejects.toThrow('another organization');
  });
  it('blocks switching servers', async () => {
    await assertSyncTenant('https://example.com', org);
    await expect(assertSyncTenant('https://other.example.com', org)).rejects.toThrow('another organization');
  });
  it('refuses unowned legacy sync cursor', async () => {
    state.set('taskCursor', { key: 'taskCursor', value: 42 });
    await expect(assertSyncTenant('https://example.com', org)).rejects.toThrow('no verified organization');
    expect([...state.keys()]).toEqual(['taskCursor']);
  });
  it('refuses legacy queued changes', async () => {
    operations = 1;
    await expect(assertSyncTenant('https://example.com', org)).rejects.toThrow('no verified organization');
  });
  it('refuses legacy revision records', async () => {
    revisions = 1;
    await expect(assertSyncTenant('https://example.com', org)).rejects.toThrow('no verified organization');
  });
  it('rejects insecure and ambiguous server addresses', async () => {
    for (const url of ['http://example.com', 'https://example.com/other', 'https://example.com/?x=1']) {
      await expect(assertSyncTenant(url, org)).rejects.toThrow();
    }
    expect(state.size).toBe(0);
  });
  it('rejects invalid organization identifiers', async () => {
    await expect(assertSyncTenant('https://example.com', 'demo-org')).rejects.toThrow('Invalid organization ID');
  });
});
