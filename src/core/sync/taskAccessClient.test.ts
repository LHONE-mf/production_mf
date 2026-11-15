import { afterEach, expect, it, vi } from 'vitest';
import { fetchAuthorizedTaskIds } from './taskAccessClient';
import type { HybridSession } from './hybridClient';

const deviceId = '22222222-2222-4222-8222-222222222222';
const taskId = '11111111-1111-4111-8111-111111111111';
const session: HybridSession = {
  serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
  deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
  deviceProofExpiresAt: Date.now() + 300_000,
};

afterEach(() => vi.unstubAllGlobals());

it('fetches the current task scope only with a fresh bound device proof', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ ids: [taskId] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  expect(await fetchAuthorizedTaskIds(session)).toEqual([taskId]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('https://sync.example.com/sync/task-access?deviceId=' + deviceId);
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
    Authorization: 'Bearer ' + session.accessToken, 'x-device-proof': 'B'.repeat(43),
  });
});

it.each([
  { ids: [taskId, taskId] }, { ids: [null] }, { ids: ['demo-task'] },
  { ids: 'invalid' }, { nextCursor: 1 }, null,
])('rejects an invalid access snapshot without authorizing stale tasks: %s', async result => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => result }));
  await expect(fetchAuthorizedTaskIds(session)).rejects.toThrow('Invalid server task access snapshot');
});

it('refuses stale device proof and server-denied access without a fallback', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
  vi.stubGlobal('fetch', fetchMock);
  await expect(fetchAuthorizedTaskIds({ ...session, deviceProofExpiresAt: Date.now() - 1 }))
    .rejects.toThrow('Fresh device proof');
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(fetchAuthorizedTaskIds(session)).rejects.toThrow('HTTP 403');
});

it('refuses untrusted server URL paths even for valid proof', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(fetchAuthorizedTaskIds({ ...session, serverUrl: 'https://sync.example.com/redirect' }))
    .rejects.toThrow('server origin');
  expect(fetchMock).not.toHaveBeenCalled();
});
