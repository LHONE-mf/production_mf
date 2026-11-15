import { randomUUID } from 'node:crypto';
import { createPool } from './db.js';
import { loadConfig } from './config.js';
import { hashPassword } from './auth.js';

const [organizationName, login, password] = process.argv.slice(2);
if (!organizationName || !login || !password || password.length < 16) {
  console.error('Usage: npm run bootstrap -- <organization-name> <chief-login> <password-min-16-chars>');
  process.exit(1);
}
const pool = createPool(loadConfig().DATABASE_URL);
try {
  const count = await pool.query('SELECT count(*)::int AS count FROM organizations');
  if (count.rows[0].count !== 0) throw new Error('Bootstrap only permitted on an empty installation');
  const orgId = randomUUID(), userId = randomUUID();
  const hashed = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [orgId, organizationName]);
    await client.query(`INSERT INTO users(id,organization_id,login,password_hash,role) VALUES ($1,$2,$3,$4,'chief')`, [userId,orgId,login,hashed]);
    await client.query('COMMIT');
    console.log('Created organization ID:',orgId);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} finally { await pool.end(); }
