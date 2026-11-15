import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, newToken, tokenHash } from './auth.js';

describe('server credentials', () => {
  it('verifies correct passwords and rejects wrong ones', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('incorrect', stored)).toBe(false);
  });
  it('uses distinct salts', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });
  it('rejects malformed password hashes', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
  });
  it('issues unique bearer tokens and deterministic one-way hashes', () => {
    const a = newToken(), b = newToken();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(43);
    expect(tokenHash(a)).toBe(tokenHash(a));
    expect(tokenHash(a)).not.toBe(tokenHash(b));
  });
});
