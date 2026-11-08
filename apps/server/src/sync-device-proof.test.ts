import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { tokenHash } from './auth.js';

const user = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const session = 'A'.repeat(43);
const proof = 'B'.repeat(43);
const payload = {
  schemaVersion: 1, title: 'Test', description: '', status: 'created', priority: 'medium',
  assignedTo: null, createdBy: user, createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z', dueDate: null, techCardId: null,
  stage: null, workshopId: null, comments: [], attachments: [],
};
const op = (deviceId: string) => ({
  operationId: '55555555-5555-4555-8555-555555555555', deviceId,
  entityType: 'task', entityId: '66666666-6666-4666-8666-666666666666',
  operationType: 'upsert', expectedRevision: 0, payload,
});
function pool(granted = false) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.includes('FROM sessions s') && sql.includes('JOIN users'))
      return { rows: [{ id: user, organization_id: org, role: 'master' }], rowCount: 1 };
    if (sql.includes('FROM device_proof_grants'))
      return { rows: granted ? [{ token_hash: tokenHash(proof) }] : [], rowCount: granted ? 1 : 0 };
    throw new Error('Unexpected SQL: ' + sql);
  });
  return { query };
}
const post = (app: ReturnType<typeof buildApp>, operations: unknown[], proofHeader?: string) =>
  app.inject({ method: 'POST', url: '/sync/push',
    headers: { authorization: 'Bearer ' + session, ...(proofHeader ? { 'x-device-proof': proofHeader } : {}) },
    payload: { operations } });

describe('sync push device proof boundary', () => {
  it('rejects missing proof before writing to database', async () => {
    const db = pool();
    const app = buildApp(db as any);
    const response = await post(app, [op(device)]);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('device_proof_required');
    expect(db.query).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('rejects proof that is expired, revoked, or bound to another actor/session/device', async () => {
    const db = pool(false);
    const app = buildApp(db as any);
    const response = await post(app, [op(device)], proof);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('device_proof_invalid');
    const grantQuery = db.query.mock.calls[1];
    expect(grantQuery![1]).toEqual([tokenHash(proof), org, user, device, tokenHash(session)]);
    expect(grantQuery![0]).toContain('g.expires_at>now()');
    expect(grantQuery[0]).toContain('d.revoked_at IS NULL');
    expect(grantQuery[0]).toContain('s.revoked_at IS NULL');
    await app.close();
  });
  it('accepts a matching device proof and checks the bound session before task writes', async () => {
    const db = pool(true);
    const connect = vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        throw new Error('stop before mutation');
      }),
      release: vi.fn(),
    }));
    const app = buildApp({ ...db, connect } as any);
    const response = await post(app, [op(device)], proof);
    expect(response.statusCode).toBe(503);
    expect(db.query.mock.calls[1][1]).toEqual([tokenHash(proof), org, user, device, tokenHash(session)]);
    expect(connect).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('rejects mixed-device batches before checking grants', async () => {
    const db = pool(true);
    const app = buildApp(db as any);
    const response = await post(app, [op(device), { ...op(other), operationId: other }], proof);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('mixed_device_batch');
    expect(db.query).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
