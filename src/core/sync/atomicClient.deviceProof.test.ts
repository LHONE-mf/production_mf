import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullAtomicTasks } from './atomicClient';
import { requireFreshDeviceProof } from './deviceProofClient';

const deviceId = '33333333-3333-4333-8333-333333333333';
const session = {
  serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43),
  deviceProofToken: 'B'.repeat(43), deviceProofDeviceId: deviceId,
  deviceProofExpiresAt: Date.now() + 300000,
};

afterEach(() => vi.unstubAllGlobals());

describe('atomic client device-scoped pull', () => {
  it('fails closed before fetching if device proof is missing or expired', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(pullAtomicTasks({ ...session, deviceProofToken: undefined }))
      .rejects.toThrow('Fresh device proof');
    await expect(pullAtomicTasks({ ...session, deviceProofExpiresAt: Date.now() - 1000 }))
      .rejects.toThrow('Fresh device proof');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    'https://admin:secret@sync.example.com',
    'https://sync.example.com/api',
    'https://sync.example.com/?token=embedded',
    'https://sync.example.com/#fragment',
  ])('never sends bearer credentials to malformed server origin %s', async serverUrl => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(pullAtomicTasks({ ...session, serverUrl }))
      .rejects.toThrow('Sync server URL must be an origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects cleartext remote server addresses before a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(pullAtomicTasks({ ...session, serverUrl: 'http://sync.example.com' }))
      .rejects.toThrow('HTTPS required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('validates proof device binding and expiry without persisting the grant', () => {
    expect(requireFreshDeviceProof(session)).toEqual({ deviceId, token: 'B'.repeat(43) });
    expect(() => requireFreshDeviceProof({ ...session, deviceProofDeviceId: 'invalid' })).toThrow();
  });
});
