/** Test setup only. Historical migrations are not a general-purpose migration runner. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
const directory = new URL('../../apps/server/migrations/', import.meta.url);

export function disposableDatabase(value) {
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.username === 'production_mf_ci' &&
    ['/production_mf_ci', '/production_mf_emulator_ci'].includes(url.pathname) &&
    !url.search && !url.hash, 'Refusing non-isolated CI PostgreSQL URL');
  return url;
}
export async function migrationFiles() {
  const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert(files.length >= 22, 'Incomplete branch migration directory');
  assert.equal(new Set(files.map(file => file.slice(0, 3))).size, files.length, 'Duplicate migration version');
  return files;
}
export async function migrateEmptyDisposableDatabase(pool) {
  const database = (await pool.query('SELECT current_database() AS name, current_user AS owner')).rows[0];
  assert(['production_mf_ci', 'production_mf_emulator_ci'].includes(database.name) && database.owner === 'production_mf_ci');
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.equal(tables.rowCount, 0, 'Refusing to reapply historical migrations to populated database');
  const files = await migrationFiles();
  for (const file of files) {
    await pool.query(await readFile(new URL(file, directory), 'utf8'));
    console.log('Applied isolated CI migration:', file);
  }
  return files;
}
