import Fastify from 'fastify';
import type { Pool } from 'pg';

export function buildApp(pool: Pick<Pool, 'query'>) {
  const app = Fastify({ logger: true });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
