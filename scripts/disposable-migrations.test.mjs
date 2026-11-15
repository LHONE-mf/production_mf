import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disposableDatabase, migrationFiles } from './lib/disposable-migrations.mjs';

test('disposable migration setup refuses non-local, production and ambiguous URLs', () => {
  for (const url of ['postgres://u:p@db.example/production_mf_ci', 'postgres://production_mf_ci:p@localhost/production', 'postgres://root:p@localhost/production_mf_ci', 'postgres://production_mf_ci:p@localhost/production_mf_ci?host=remote']) {
    assert.throws(() => disposableDatabase(url));
  }
  for (const database of ['production_mf_ci', 'production_mf_emulator_ci']) {
    assert.equal(disposableDatabase(`postgres://production_mf_ci:p@127.0.0.1/${database}`).pathname, '/' + database);
  }
});

test('migration discovery includes all branch migrations in dependency order', async () => {
  const files = await migrationFiles();
  assert.equal(files[0], '001_foundation.sql');
  assert(files.includes('020_storage_inventory.sql'));
  assert(files.includes('021_inventory_restore_fence.sql'));
  assert(files.includes('022_inventory_recovery_approvals.sql'));
  assert.deepEqual(files, [...files].sort());
  assert.equal(new Set(files.map(file => file.slice(0, 3))).size, files.length);
});
