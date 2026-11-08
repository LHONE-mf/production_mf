import { afterEach, describe, expect, it, vi } from 'vitest';
import { obtainDeviceProof } from './deviceProofClient';

const deviceId = '33333333-3333-4333-8333-333333333333';
const session = { serverUrl: 'https://sync.example.com', accessToken: 'A'.repeat(43) };
const challenge = 'B'.repeat(43);
const proofToken = 'C'.repeat(43);
afterEach(() => vi.unstubAllGlobals());

describe('device proof client', () => {
  it('exchanges a signed challenge without persisting credentials', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: deviceId, challenge }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ proofToken, deviceId, expiresIn: 300 }) });
    vi.stubGlobal('fetch', fetchMock);
    const signer = vi.fn(async () => 'D'.repeat(86));
    const verified = await obtainDeviceProof(session, deviceId, signer);
    expect(verified.deviceProofToken).toBe(proofToken);
    expect(verified.deviceProofDeviceId).toBe(deviceId);
    expect(verified.deviceProofExpiresAt).toBeGreaterThan(Date.now() + 290_000);
    expect(verified.deviceProofExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(session).not.toHaveProperty('deviceProofToken');
    expect(signer).toHaveBeenCalledWith(challenge);
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://sync.example.com/devices/challenge');
    expect(fetchMock.mock.calls[1][0].toString()).toBe('https://sync.example.com/devices/challenge/verify');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ deviceId, challenge, signature: 'D'.repeat(86) });
  });
  it('fails closed for insecure remote endpoints before networking', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(obtainDeviceProof({ ...session, serverUrl: 'http://sync.example.com' }, deviceId, vi.fn()))
      .rejects.toThrow('HTTPS required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed server challenge without calling the signer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ challengeId: deviceId, challenge: 'bad' }) }));
    const signer = vi.fn();
    await expect(obtainDeviceProof(session, deviceId, signer)).rejects.toThrow('Invalid challenge');
    expect(signer).not.toHaveBeenCalled();
  });
  it('does not return a session when verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challengeId: deviceId, challenge }) })
      .mockResolvedValueOnce({ ok: false, status: 403 }));
    await expect(obtainDeviceProof(session, deviceId, async () => 'D'.repeat(86))).rejects.toThrow('HTTP 403');
  });
});
