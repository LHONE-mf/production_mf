import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function newToken() { return randomBytes(32).toString('base64url'); }
export interface Principal { id: string; organization_id: string; role: 'chief'|'master'|'technologist'|'worker'; }
export async function authenticate(pool: Pick<Pool,'query'>, authorization: string | undefined): Promise<Principal | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await pool.query(`SELECT u.id, u.organization_id, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.organization_id = s.organization_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL AND u.active = true`, [tokenHash(token)]);
  return (result.rows[0] as Principal | undefined) ?? null;
}
