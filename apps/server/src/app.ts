import Fastify from 'fastify';
import type { Pool } from 'pg';
import rateLimit from '@fastify/rate-limit';
import { registerAuthRoutes } from './auth-routes.js';
import { registerSyncRoutes } from './sync-routes.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { registerBatchRoutes } from './batch-routes.js';
import { registerDeviceChallengeRoutes } from './device-challenge-routes.js';

export function buildApp(pool: Pool) {
  const app = Fastify({ logger: true });
  void app.register(rateLimit, { global: false });
  registerAuthRoutes(app, pool);
  registerDeviceChallengeRoutes(app, pool);
  registerSyncRoutes(app, pool);
  registerPlanningRoutes(app, pool);
  registerBatchRoutes(app, pool);
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
