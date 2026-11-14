/** Cross-check native assertions against the actual disposable PostgreSQL ledger. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { disposableDatabase } from './lib/disposable-migrations.mjs';
const state = resolve(process.argv[2] ?? '');
assert(process.env.RUNNER_TEMP && dirname(state) === resolve(process.env.RUNNER_TEMP));
const fixture = JSON.parse(await readFile(state, 'utf8'));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: disposableDatabase(process.env.POSTGRES_TEST_URL).toString() });
try {
  const nativeLog = await readFile('artifacts/android-smoke/storage-result.log', 'utf8');
  const matches = [...nativeLog.matchAll(/RESULT (\{.*\})/g)];
  assert.equal(matches.length, 1, 'Exactly one passing native Storage result required');
  const result = JSON.parse(matches[0][1]);
  for (const flag of ['passed', 'nativeProof', 'quarantine', 'lostAckRetried', 'operatorDenied', 'logoutConcealed']) assert.equal(result[flag], true, flag);
  const admin = (await pool.query("SELECT id,display_name,supplier_reference,base_unit,revision FROM inventory_materials WHERE organization_id=$1 AND material_code='NATIVE-ADMIN'", [fixture.organizationId])).rows;
  assert.equal(admin.length, 1, 'Native Chief catalogue screen did not create the material');
  assert.deepEqual({ name: admin[0].display_name, supplierReference: admin[0].supplier_reference, unit: admin[0].base_unit, revision: admin[0].revision }, { name: 'Native corrected component', supplierReference: 'NATIVE-ITEM-42', unit: 'pieces', revision: 2 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_catalog_events WHERE organization_id=$1 AND resource_id=$2', [fixture.organizationId, admin[0].id])).rows[0].n, 2, 'Native creation and versioned edit must each have immutable audit');
  const stocks = (await pool.query('SELECT id,manufacturer_lot,on_hand::text,quality FROM inventory_stocks WHERE organization_id=$1', [fixture.organizationId])).rows;
  assert.equal(stocks.length, 2);
  assert(stocks.every(stock => stock.on_hand === '2125000' && stock.quality === 'quarantine' && stock.manufacturer_lot === 'CI-SAME-LOT'));
  const events = (await pool.query('SELECT operation_id,kind FROM inventory_operations WHERE organization_id=$1', [fixture.organizationId])).rows;
  assert.equal(events.length, 2, 'Lost ACK retry must not duplicate receipt or accept malicious correction');
  assert(events.every(event => event.kind === 'receive'));
  assert.equal(events.filter(event => event.operation_id === result.operationId).length, 1);
  await writeFile('artifacts/android-smoke/storage-result.json', JSON.stringify({ ...result, sha: process.env.GITHUB_SHA ?? 'local', realPostgresLedgerVerified: true, scenarios: ['Chief native catalogue creation and versioned supplier-reference edit', 'native AndroidKeyStore enrollment/challenge proof', 'real operator Storage UI', 'exact receipt frozen offline', 'force-stop/relaunch preserves original intent', 'explicit send with lost ACK then exact retry', 'same-lot distinct quarantined containers', 'server operator correction denial', 'logout conceals cache without removing retained ACKs'] }, null, 2));
  // JUnit-style report is generated only after both real instrumentation invocations
  // and the independent PostgreSQL assertions above have succeeded.
  await writeFile('artifacts/android-smoke/storage-backend.xml', '<testsuite name="AndroidStorageBackend" tests="1" failures="0" errors="0"><testcase classname="StorageBackendWebViewTest" name="storageBackendRoundTripWithProcessDeathAndPostgresVerification"/></testsuite>\n');
  console.log('PASS: native WebView Storage and disposable PostgreSQL ledger agree.');
} finally { await pool.end(); }
