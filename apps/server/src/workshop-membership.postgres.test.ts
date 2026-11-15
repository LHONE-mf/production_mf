import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('workshop membership tenant isolation (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const orgA = randomUUID(), orgB = randomUUID();
  const userA = randomUUID(), userB = randomUUID();
  const workshop = 'shared-workshop-code';
  let disposable = false;

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('Refusing non-disposable database for workshop integration tests');
    }
    const database = await pool.query('SELECT current_database() AS name');
    expect(database.rows[0].name).toBe('production_mf_ci');
    disposable = true;
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [orgA,'Workshop test A',orgB,'Workshop test B']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES($1,$2,$3,'test-only','master'),($4,$5,$6,'test-only','master')`,
      [userA,orgA,'workshop-test-'+userA,userB,orgB,'workshop-test-'+userB]);
    await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$3)',
      [orgA,workshop,'Assembly']);
  });
  afterAll(async () => {
    try {
      if (disposable) {
        await pool.query('DELETE FROM user_workshop_memberships WHERE organization_id IN ($1,$2)',[orgA,orgB]);
        await pool.query('DELETE FROM workshops WHERE organization_id IN ($1,$2)',[orgA,orgB]);
        await pool.query('DELETE FROM users WHERE organization_id IN ($1,$2)',[orgA,orgB]);
        await pool.query('DELETE FROM organizations WHERE id IN ($1,$2)',[orgA,orgB]);
      }
    } finally { await pool.end(); }
  });

  it('permits membership only when user and workshop share the organization', async () => {
    const insert = (org: string, user: string) => pool.query(
      'INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',
      [org,user,workshop],
    );
    await insert(orgA,userA);
    await expect(insert(orgA,userB)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(orgB,userB)).rejects.toMatchObject({ code: '23503' });
    const memberships = await pool.query(
      'SELECT user_id FROM user_workshop_memberships WHERE organization_id=$1 AND workshop_id=$2',
      [orgA,workshop],
    );
    expect(memberships.rows.map(row => row.user_id)).toEqual([userA]);
  });
  it('supports the same workshop code in multiple organizations without leaking memberships', async () => {
    await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$3)',
      [orgB,workshop,'Coating']);
    await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',
      [orgB,userB,workshop]);
    const a = await pool.query('SELECT user_id FROM user_workshop_memberships WHERE organization_id=$1',[orgA]);
    const b = await pool.query('SELECT user_id FROM user_workshop_memberships WHERE organization_id=$1',[orgB]);
    expect(a.rows.map(row => row.user_id)).toEqual([userA]);
    expect(b.rows.map(row => row.user_id)).toEqual([userB]);
  });
});
