import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { verifyDeviceChallenge } from './device-proof.js';

const challenge = randomBytes(32).toString('base64url');
const domainMessage = (value: string) => Buffer.from('production-mf:device-proof:v1:' + value);
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signature = sign(null, domainMessage(challenge), pair.privateKey).toString('base64url');

describe('Ed25519 device proof primitive', () => {
  it('accepts a valid signature for the correct challenge', () => {
    expect(verifyDeviceChallenge(publicKey, challenge, signature)).toBe(true);
  });
  it('rejects a different challenge or signature', () => {
    expect(verifyDeviceChallenge(publicKey, randomBytes(32).toString('base64url'), signature)).toBe(false);
    expect(verifyDeviceChallenge(publicKey, challenge, sign(null, Buffer.from(challenge), pair.privateKey).toString('base64url'))).toBe(false);
  });
  it('rejects signatures from another device', () => {
    const other = generateKeyPairSync('ed25519');
    expect(verifyDeviceChallenge(publicKey, challenge, sign(null, domainMessage(challenge), other.privateKey).toString('base64url'))).toBe(false);
  });
  it('rejects malformed challenges, signatures, and public keys', () => {
    expect(verifyDeviceChallenge(publicKey, 'short', signature)).toBe(false);
    expect(verifyDeviceChallenge(publicKey, challenge, 'not-a-signature')).toBe(false);
    expect(verifyDeviceChallenge('not a PEM key', challenge, signature)).toBe(false);
  });
  it('rejects other public-key algorithms', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verifyDeviceChallenge(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), challenge, signature)).toBe(false);
  });
});
