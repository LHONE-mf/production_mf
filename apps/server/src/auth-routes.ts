import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate, newToken, tokenHash, verifyPassword } from './auth.js';
import { isEd25519PublicKey } from './device-proof.js';
const loginSchema = z.object({ organizationId: z.string().uuid(), login: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const enrollSchema = z.object({ userId: z.string().uuid().optional(), publicKey: z.string().min(32).max(4096) });

export function registerAuthRoutes(app: FastifyInstance, pool: Pick<Pool,'query'>) {
  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { organizationId, login, password } = parsed.data;
    const result = await pool.query('SELECT id, password_hash, role FROM users WHERE organization_id = $1 AND login = $2 AND active = true', [organizationId, login]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) return reply.code(401).send({ error: 'invalid_credentials' });
    const token = newToken();
    await pool.query(`INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '12 hours')`, [randomUUID(), organizationId, user.id, tokenHash(token)]);
    return { accessToken: token, tokenType: 'Bearer', expiresIn: 43200, user: { id: user.id, role: user.role, organizationId } };
  });
  app.get('/auth/me', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    return { id: principal.id, organizationId: principal.organization_id, role: principal.role };
  });
  app.post('/auth/logout', async (request, reply) => {
    const authorization = request.headers.authorization;
    const principal = await authenticate(pool, authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [tokenHash(authorization!.slice(7))]);
    return { ok: true };
  });
  app.post('/devices', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (principal.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!isEd25519PublicKey(parsed.data.publicKey)) return reply.code(400).send({ error: 'invalid_device_public_key' });
    const userId = parsed.data.userId ?? principal.id;
    const owner = await pool.query('SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND active = true', [userId, principal.organization_id]);
    if (!owner.rows.length) return reply.code(404).send({ error: 'user_not_found' });
    const id = randomUUID();
    await pool.query('INSERT INTO devices (id, organization_id, user_id, public_key) VALUES ($1,$2,$3,$4)', [id, principal.organization_id, userId, parsed.data.publicKey]);
    return reply.code(201).send({ id, userId });
  });
  // Read-only discovery for the authenticated user. Never return other users' devices or public keys.
  app.get('/devices/mine', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    const result = await pool.query(
      'SELECT id FROM devices WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY id',
      [principal.organization_id, principal.id],
    );
    return { devices: result.rows.map((row: { id: string }) => ({ id: row.id })) };
  });
  app.post('/devices/:id/revoke', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (principal.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const id = z.string().uuid().safeParse((request.params as {id:string}).id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id', [id.data, principal.organization_id]);
    if (!result.rows.length) return reply.code(404).send({ error: 'device_not_found' });
    return { ok: true };
  });
}
