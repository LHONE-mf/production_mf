import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp(pool);

async function shutdown() {
  await app.close();
  await pool.end();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
