import type { HybridSession } from './hybridClient';

/**
 * Signing is delegated to the platform's non-exportable device key.
 * This module never creates, exports, or persists a private key or login token.
 */
export type DeviceChallengeSigner = (challenge: string) => Promise<string>;

export async function obtainDeviceProof(
  session: HybridSession,
  deviceId: string,
  signChallenge: DeviceChallengeSigner,
): Promise<HybridSession> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))
    throw new Error('Invalid device ID');
  const base = new URL(session.serverUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))
    throw new Error('HTTPS required for device authentication');
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== ''))
    throw new Error('Device authentication requires a server origin without credentials or path');
  const send = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Device authentication failed: HTTP ' + response.status);
    return response.json();
  };
  const issued = await send('/devices/challenge', { deviceId });
  if (!/^[A-Za-z0-9_-]{43}$/.test(issued.challenge) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(issued.challengeId))
    throw new Error('Invalid challenge response');
  const signature = await signChallenge(issued.challenge);
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new Error('Invalid device signature');
  const verificationStartedAt = Date.now();
  const verified = await send('/devices/challenge/verify', {
    deviceId, challengeId: issued.challengeId, challenge: issued.challenge, signature,
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(verified.proofToken) || verified.deviceId !== deviceId || verified.expiresIn !== 300)
    throw new Error('Invalid device proof response');
  return { ...session, deviceProofToken: verified.proofToken, deviceProofDeviceId: deviceId, deviceProofExpiresAt: verificationStartedAt + verified.expiresIn * 1000 };
}
