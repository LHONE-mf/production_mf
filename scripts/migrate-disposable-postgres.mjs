import { createRequire } from 'node:module';
import { disposableDatabase, migrateEmptyDisposableDatabase } from './lib/disposable-migrations.mjs';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: disposableDatabase(process.env.POSTGRES_TEST_URL).toString() });
try { await migrateEmptyDisposableDatabase(pool); } finally { await pool.end(); }
