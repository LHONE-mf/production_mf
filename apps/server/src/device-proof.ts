import { createPublicKey, verify } from 'node:crypto';

/**
 * Device proof v1: Ed25519 signatures over a server-generated, single-use challenge.
 * Only SPKI PEM Ed25519 public keys are supported; RSA/ECDSA keys are rejected.
 * This primitive does not enroll devices, issue challenges, or authenticate sessions.
 */
export function verifyDeviceChallenge(publicKeyPem: string, challenge: string, signatureBase64url: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureBase64url)) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureBase64url, 'base64url');
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from('production-mf:device-proof:v1:' + challenge, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/** Reject unsupported or malformed enrollment keys before they reach the device table. */
export function isEd25519PublicKey(publicKeyPem: string): boolean {
  if (!/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n?$/.test(publicKeyPem)) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return key.asymmetricKeyType === 'ed25519' &&
      key.export({ format: 'pem', type: 'spki' }).toString().trim() === publicKeyPem.trim();
  } catch {
    return false;
  }
}
