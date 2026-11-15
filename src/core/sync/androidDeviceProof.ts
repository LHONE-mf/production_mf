import { registerPlugin } from '@capacitor/core';
import { obtainDeviceProof } from './deviceProofClient';
import type { HybridSession } from './hybridClient';

interface DeviceProofNative {
  getPublicKey(): Promise<{ publicKey: string }>;
  signChallenge(options: { challenge: string }): Promise<{ signature: string }>;
}

const nativeProof = registerPlugin<DeviceProofNative>('DeviceProof');

/** The key never leaves AndroidKeyStore. Enrollment is a separate chief-authorized action. */
export async function androidDevicePublicKey(): Promise<string> {
  const result = await nativeProof.getPublicKey();
  if (!result.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
    throw new Error('Invalid Android device public key');
  return result.publicKey;
}

export async function authenticateAndroidDevice(session: HybridSession, deviceId: string): Promise<HybridSession> {
  return obtainDeviceProof(session, deviceId, async challenge => {
    const result = await nativeProof.signChallenge({ challenge });
    return result.signature;
  });
}
