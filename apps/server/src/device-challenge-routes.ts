import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate, newToken, tokenHash } from './auth.js';
import { verifyDeviceChallenge } from './device-proof.js';

const uuid = z.string().uuid();
const issueBody = z.object({ deviceId: uuid }).strict();
const verifyBody = z.object({
  deviceId: uuid, challengeId: uuid,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function registerDeviceChallengeRoutes(app: FastifyInstance, pool: Pick<Pool, 'query'>) {
  app.post('/devices/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const body = issueBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const sessionHash = tokenHash(request.headers.authorization!.slice(7));
    const device = await pool.query(
      'SELECT id FROM devices WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL AND public_key IS NOT NULL',
      [body.data.deviceId, actor.organization_id, actor.id],
    );
    if (!device.rowCount) return reply.code(404).send({ error: 'device_not_found' });
    const challenge = randomBytes(32).toString('base64url');
    const challengeId = randomUUID();
    await pool.query(`INSERT INTO device_challenges
      (id, organization_id, user_id, device_id, session_token_hash, challenge_hash, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,now() + interval '2 minutes')`,
      [challengeId, actor.organization_id, actor.id, body.data.deviceId, sessionHash, sha256(challenge)]);
    return { challengeId, challenge, expiresIn: 120 };
  });

  app.post('/devices/challenge/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const body = verifyBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { deviceId, challengeId, challenge, signature } = body.data;
    const sessionHash = tokenHash(request.headers.authorization!.slice(7));
    const device = await pool.query(
      'SELECT public_key FROM devices WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL',
      [deviceId, actor.organization_id, actor.id],
    );
    if (!device.rowCount || !verifyDeviceChallenge(device.rows[0].public_key, challenge, signature))
      return reply.code(403).send({ error: 'invalid_device_proof' });

    // A single conditional UPDATE is atomic under PostgreSQL concurrency.
    // A revoked device or session cannot consume a challenge or obtain a grant.
    const proofToken = newToken();
    const consumed = await pool.query(`WITH consumed AS (
      UPDATE device_challenges c SET consumed_at=now()
      WHERE c.id=$1 AND c.organization_id=$2 AND c.user_id=$3 AND c.device_id=$4
        AND c.session_token_hash=$5 AND c.challenge_hash=$6
        AND c.consumed_at IS NULL AND c.expires_at > now()
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash=$5 AND s.revoked_at IS NULL AND s.expires_at>now())
        AND EXISTS (SELECT 1 FROM devices d WHERE d.id=c.device_id AND d.revoked_at IS NULL)
      RETURNING c.organization_id, c.user_id, c.device_id, c.session_token_hash
    )
    INSERT INTO device_proof_grants
      (token_hash, organization_id, user_id, device_id, session_token_hash, expires_at)
    SELECT $7, organization_id, user_id, device_id, session_token_hash, now() + interval '5 minutes'
    FROM consumed RETURNING token_hash`,
      [challengeId, actor.organization_id, actor.id, deviceId, sessionHash, sha256(challenge), tokenHash(proofToken)]);
    if (!consumed.rowCount) return reply.code(403).send({ error: 'invalid_or_expired_challenge' });
    return { proofToken, tokenType: 'DeviceProof', expiresIn: 300, deviceId };
  });
}
