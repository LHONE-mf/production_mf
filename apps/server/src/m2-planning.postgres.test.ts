import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;

integration('M2 planning schema and tenant boundaries (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.POSTGRES_TEST_URL });
  const orgA = randomUUID(), orgB = randomUUID();
  const chiefA = randomUUID(), chiefB = randomUUID();
  const routeA = randomUUID(), routeB = randomUUID();
  const orderA = randomUUID();
  let disposable = false;

  beforeAll(async () => {
    const target = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
        target.pathname !== '/production_mf_ci') {
      throw new Error('Refusing non-disposable database for M2 integration tests');
    }
    const db = await pool.query('SELECT current_database() AS name');
    expect(db.rows[0].name).toBe('production_mf_ci');
    disposable = true;
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
      [orgA, 'M2 test tenant A', orgB, 'M2 test tenant B']);
    await pool.query(`INSERT INTO users(id,organization_id,login,password_hash,role)
      VALUES ($1,$2,$3,'test-only','chief'),($4,$5,$6,'test-only','chief')`,
      [chiefA,orgA,'m2-a-'+chiefA,chiefB,orgB,'m2-b-'+chiefB]);
    await pool.query(`INSERT INTO workshops(organization_id,id,name) VALUES
      ($1,'coating','Coating'),($2,'coating','Coating')`, [orgA,orgB]);
    await pool.query(`INSERT INTO process_routes(organization_id,id,code,name,created_by)
      VALUES($1,$2,'NMC-01','NMC route',$3),($4,$5,'NMC-01','Tenant B route',$6)`,
      [orgA,routeA,chiefA,orgB,routeB,chiefB]);
    await pool.query(`INSERT INTO process_route_versions(organization_id,route_id,version)
      VALUES($1,$2,1),($1,$2,2),($3,$4,1)`, [orgA,routeA,orgB,routeB]);
    await pool.query(`INSERT INTO process_route_steps
      (organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line)
      VALUES($1,$2,1,1,'Coat cathode','coating','coating','cathode'),
            ($1,$2,2,1,'Coat revision two','coating','coating','cathode'),
            ($3,$4,1,1,'Coat tenant B','coating','coating','cathode')`,
      [orgA,routeA,orgB,routeB]);
  });

  afterAll(async () => {
    try {
      if (disposable) {
        for (const table of ['production_batches', 'production_orders',
          'process_route_steps', 'process_route_versions', 'process_routes',
          'user_workshop_memberships', 'workshops', 'users']) {
          await pool.query('DELETE FROM ' + table + ' WHERE organization_id IN ($1,$2)', [orgA,orgB]);
        }
        await pool.query('DELETE FROM organizations WHERE id IN ($1,$2)', [orgA,orgB]);
      }
    } finally { await pool.end(); }
  });

  it('keeps route codes tenant-local and versions independent', async () => {
    const routes = await pool.query('SELECT organization_id,code FROM process_routes WHERE code=$1',
      ['NMC-01']);
    expect(routes.rows).toHaveLength(2);
    await expect(pool.query(`INSERT INTO process_routes(organization_id,id,code,name,created_by)
      VALUES($1,$2,'NMC-01','Duplicate code',$3)`, [orgA,randomUUID(),chiefA]))
      .rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO process_route_steps
      (organization_id,route_id,route_version,step_number,name,stage,workshop_id)
      VALUES($1,$2,1,2,'Foreign workshop','coating','absent')`, [orgA,routeA]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO process_route_steps
      (organization_id,route_id,route_version,step_number,name,stage,workshop_id)
      VALUES($1,$2,1,2,'Invalid stage','nonexistent','coating')`, [orgA,routeA]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('freezes approved route versions and their steps while new drafts remain editable', async () => {
    await pool.query(`UPDATE process_route_versions
      SET state='approved', approved_at=now(), approved_by=$1
      WHERE organization_id=$2 AND route_id=$3 AND version=1`,
      [chiefA,orgA,routeA]);
    await expect(pool.query(`UPDATE process_route_steps SET name='Changed'
      WHERE organization_id=$1 AND route_id=$2 AND route_version=1 AND step_number=1`,
      [orgA,routeA])).rejects.toThrow('approved route steps are immutable');
    await expect(pool.query(`DELETE FROM process_route_steps
      WHERE organization_id=$1 AND route_id=$2 AND route_version=1 AND step_number=1`,
      [orgA,routeA])).rejects.toThrow('approved route steps are immutable');
    await expect(pool.query(`INSERT INTO process_route_steps
      (organization_id,route_id,route_version,step_number,name,stage,workshop_id)
      VALUES($1,$2,1,2,'Late change','coating','coating')`,
      [orgA,routeA])).rejects.toThrow('approved route steps are immutable');
    await expect(pool.query(`UPDATE process_route_steps SET route_version=2
      WHERE organization_id=$1 AND route_id=$2 AND route_version=1 AND step_number=1`,
      [orgA,routeA])).rejects.toThrow('approved route steps are immutable');
    await expect(pool.query(`UPDATE process_route_versions SET approved_at=now()
      WHERE organization_id=$1 AND route_id=$2 AND version=1`,
      [orgA,routeA])).rejects.toThrow('approved route version is immutable');

    await pool.query(`UPDATE process_route_steps SET name='Allowed draft improvement'
      WHERE organization_id=$1 AND route_id=$2 AND route_version=2 AND step_number=1`,
      [orgA,routeA]);
    const row = await pool.query(`SELECT name FROM process_route_steps
      WHERE organization_id=$1 AND route_id=$2 AND route_version=2`, [orgA,routeA]);
    expect(row.rows[0].name).toBe('Allowed draft improvement');
  });

  it('links orders and cathode/anode/cell batch identities to the same organization', async () => {
    const createOrder = (org: string, id: string, route: string, creator: string, code: string) =>
      pool.query(`INSERT INTO production_orders
        (organization_id,id,order_code,product_code,route_id,route_version,
          planned_quantity,quantity_unit,created_by)
        VALUES($1,$2,$3,'18650-NMC',$4,1,1200,'cells',$5)`,
      [org,id,code,route,creator]);
    await createOrder(orgA,orderA,routeA,chiefA,'PO-001');
    await expect(createOrder(orgA,randomUUID(),routeA,chiefA,'PO-001'))
      .rejects.toMatchObject({ code: '23505' });
    await expect(createOrder(orgB,randomUUID(),routeA,chiefB,'PO-001'))
      .rejects.toMatchObject({ code: '23503' });
    await createOrder(orgB,randomUUID(),routeB,chiefB,'PO-001');

    for (const material of ['cathode','anode','cell']) {
      await pool.query(`INSERT INTO production_batches
        (organization_id,id,order_id,batch_code,material_line,created_by)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [orgA,randomUUID(),orderA,'BATCH-'+material,material,chiefA]);
    }
    await expect(pool.query(`INSERT INTO production_batches
      (organization_id,id,order_id,batch_code,material_line,created_by)
      VALUES($1,$2,$3,'BATCH-cathode','cathode',$4)`,
      [orgA,randomUUID(),orderA,chiefA])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO production_batches
      (organization_id,id,order_id,batch_code,material_line,created_by)
      VALUES($1,$2,$3,'FOREIGN-BATCH','cell',$4)`,
      [orgB,randomUUID(),orderA,chiefB])).rejects.toMatchObject({ code: '23503' });
    const rows = await pool.query(`SELECT material_line FROM production_batches
      WHERE organization_id=$1 AND order_id=$2 ORDER BY material_line`, [orgA,orderA]);
    expect(rows.rows.map(row => row.material_line)).toEqual(['anode','cathode','cell']);
  });
});
