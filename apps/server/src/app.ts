import Fastify from 'fastify';
import type { Pool } from 'pg';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { registerAuthRoutes } from './auth-routes.js';
import { registerSyncRoutes } from './sync-routes.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { registerBatchRoutes } from './batch-routes.js';
import { registerBatchGenealogyRoutes } from './batch-genealogy-routes.js';
import { registerStageHandoffRoutes } from './stage-handoff-routes.js';
import { registerStepEvidenceRoutes } from './step-evidence-routes.js';
import { registerLocalJournalLinkRoutes } from './local-journal-link-routes.js';
import { registerInspectionObservationRoutes } from './inspection-observation-routes.js';
import { registerInspectionReviewRoutes } from './inspection-review-routes.js';
import { registerInspectionCriteriaRoutes } from './inspection-criteria-routes.js';
import { registerDeviceChallengeRoutes } from './device-challenge-routes.js';
import { registerInventoryRoutes } from './inventory-routes.js';
import { registerInventoryCatalogRoutes } from './inventory-catalog-routes.js';
import { registerInventoryStockOperations } from './inventory-stock-operations.js';

function allowedBrowserOrigins(): Set<string> {
  // Android Capacitor's local WebView uses https://localhost. Other frontend
  // hosts must be explicitly configured; never reflect arbitrary Origin values.
  const allowed = new Set(['https://localhost']);
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }
  for (const entry of (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = entry.trim();
    if (!origin) continue;
    const url = new URL(origin);
    if ((url.protocol !== 'https:' &&
         !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
        url.origin !== origin || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CORS_ALLOWED_ORIGINS must contain only exact HTTPS origins (or localhost)');
    }
    allowed.add(origin);
  }
  return allowed;
}

export function buildApp(pool: Pool) {
  const app = Fastify({ logger: true });
  const origins = allowedBrowserOrigins();
  void app.register(cors, {
    origin: (origin, callback) => callback(null, Boolean(origin && origins.has(origin))),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-device-proof','x-inventory-epoch'],
    maxAge: 600,
    credentials: false,
  });
  void app.register(rateLimit, { global: false });
  registerAuthRoutes(app, pool);
  registerDeviceChallengeRoutes(app, pool);
  registerSyncRoutes(app, pool);
  registerPlanningRoutes(app, pool);
  registerBatchRoutes(app, pool);
  registerBatchGenealogyRoutes(app, pool);
  registerStageHandoffRoutes(app, pool);
  registerStepEvidenceRoutes(app, pool);
  registerLocalJournalLinkRoutes(app, pool);
  registerInspectionObservationRoutes(app, pool);
  registerInspectionReviewRoutes(app, pool);
  registerInspectionCriteriaRoutes(app, pool);
  registerInventoryRoutes(app, pool);
  registerInventoryCatalogRoutes(app, pool);
  registerInventoryStockOperations(app, pool);
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
