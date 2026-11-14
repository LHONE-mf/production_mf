/** Disposable loopback fixture. Never imported by the production server/app. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../apps/server/dist/app.js';
import { hashPassword } from '../apps/server/dist/auth.js';
import { disposableDatabase } from './lib/disposable-migrations.mjs';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Pool } = require('pg');
const url = disposableDatabase(process.env.POSTGRES_TEST_URL);
assert.equal(url.pathname, '/production_mf_emulator_ci');
const statePath = resolve(process.argv[2] ?? '');
assert(process.env.RUNNER_TEMP && dirname(statePath) === resolve(process.env.RUNNER_TEMP), 'Fixture credentials must stay in RUNNER_TEMP');
const pool = new Pool({ connectionString: url.toString() });
const app = buildApp(pool);
const org = randomUUID(), password = randomBytes(32).toString('base64url');
const fixture = { serverUrl: 'http://127.0.0.1:3002', organizationId: org, password,
  chief: randomUUID(), operator: randomUUID(), materialId: randomUUID(), locationId: randomUUID(), destinationId: randomUUID() };
try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'production_mf_emulator_ci');
  await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [org, 'SYNTHETIC disposable Android Storage CI']);
  const hash = await hashPassword(password);
  for (const [key, role] of [['chief', 'chief'], ['operator', 'worker']]) {
    await pool.query('INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,$5,$3,$4)', [fixture[key], org, hash, role, fixture[key]]);
  }
  // Only catalogue fixtures; stock/authorization/proof are exercised via real APIs.
  await pool.query("INSERT INTO inventory_materials(id,organization_id,material_code,display_name,category,base_unit) VALUES($1,$2,'CI-PVDF','CI synthetic PVDF','raw_material','mg')", [fixture.materialId, org]);
  await pool.query("INSERT INTO inventory_locations(id,organization_id,parent_id,label,kind) VALUES($1,$3,NULL,'CI receiving warehouse','warehouse'),($2,$3,NULL,'CI destination warehouse','warehouse')", [fixture.locationId, fixture.destinationId, org]);
  await app.listen({ host: '127.0.0.1', port: 3002 });
  await writeFile(statePath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
  console.log('Disposable Storage backend ready on loopback; credentials excluded from artifacts.');
} catch (error) { await app.close(); await pool.end(); throw error; }
async function stop() { await app.close(); await pool.end(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
