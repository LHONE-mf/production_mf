import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('Storage populated 001–023 catalogue upgrade (isolated schema)', () => {
  it('preserves prior stock/identity/audit and adds only explicit safe metadata defaults', async () => {
    const url = new URL(process.env.POSTGRES_TEST_URL!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/production_mf_ci') throw Error('Disposable test database required');
    const pool = new Pool({ connectionString: url.toString() }), client = await pool.connect();
    const schema = 'inventory_catalog_upgrade_' + randomUUID().replaceAll('-', '');
    let owned = false;
    try {
      await client.query('CREATE SCHEMA "' + schema + '"'); owned = true;
      await client.query('SET search_path TO "' + schema + '"');
      for (const file of (await readdir('migrations')).filter(file => /^\d{3}_.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 23).sort()) await client.query(await readFile('migrations/' + file, 'utf8'));
      const org = randomUUID(), actor = randomUUID(), device = randomUUID(), material = randomUUID(), place = randomUUID(), stock = randomUUID(), operation = randomUUID();
      await client.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic populated upgrade')", [org]);
      await client.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1,$2,'CI Chief','ci-test-only','chief')", [actor, org]);
      await client.query('INSERT INTO devices(id,organization_id,user_id) VALUES($1,$2,$3)', [device, org, actor]);
      await client.query("INSERT INTO inventory_materials(id,organization_id,material_code,display_name,category,base_unit) VALUES($1,$2,'OLD-CODE','Preserve name','raw_material','mg')", [material, org]);
      await client.query("INSERT INTO inventory_locations(id,organization_id,parent_id,label,kind) VALUES($1,$2,NULL,'Preserve historical warehouse','warehouse')", [place, org]);
      await client.query("INSERT INTO inventory_stocks(id,organization_id,material_id,manufacturer_lot,location_id,quality,on_hand) VALUES($1,$2,$3,'OLD-LOT',$4,'quarantine',2125000)", [stock, org, material, place]);
      const snapshot = { stockId: stock, materialId: material, manufacturerLot: 'OLD-LOT', locationId: place, quality: 'quarantine', unit: 'mg', onHand: 2125000, reserved: 0, available: 2125000, revision: 1 };
      await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock,to_location_id) VALUES($1,$2,$3,$4,$5,'receive',2125000,0,1,'Synthetic accepted old receipt',$6,$7,$8)", [operation, org, stock, actor, device, JSON.stringify({ operationId: operation, stockId: stock }), JSON.stringify(snapshot), place]);
      const oldStock = (await client.query('SELECT row_to_json(s) AS row FROM inventory_stocks s')).rows[0].row;
      const oldEvent = (await client.query('SELECT row_to_json(e) AS row FROM inventory_operations e')).rows[0].row;
      const migration = await readFile('migrations/024_inventory_catalog_versions.sql', 'utf8'); await client.query(migration); await client.query(migration);
      expect((await client.query('SELECT row_to_json(s) AS row FROM inventory_stocks s')).rows[0].row).toEqual(oldStock);
      expect((await client.query('SELECT row_to_json(e) AS row FROM inventory_operations e')).rows[0].row).toEqual(oldEvent);
      expect((await client.query('SELECT * FROM inventory_materials')).rows[0]).toMatchObject({ id: material, material_code: 'OLD-CODE', display_name: 'Preserve name', base_unit: 'mg', active: true, revision: 1, supplier_reference: null });
      expect((await client.query('SELECT * FROM inventory_locations')).rows[0]).toMatchObject({ id: place, label: 'Preserve historical warehouse', active: true, revision: 1 });
      expect((await client.query('SELECT count(*)::int AS n FROM inventory_catalog_events')).rows[0].n).toBe(0);
      const qualityMigration=await readFile('migrations/025_inventory_quality.sql','utf8');await client.query(qualityMigration);await client.query(qualityMigration);
      expect((await client.query('SELECT row_to_json(s) AS row FROM inventory_stocks s')).rows[0].row).toMatchObject({...oldStock,expires_at:null,manufactured_on:null,disposition:null});
      expect((await client.query('SELECT row_to_json(e) AS row FROM inventory_operations e')).rows[0].row).toEqual(oldEvent);
      expect((await client.query('SELECT count(*)::int AS n FROM inventory_quality_dispositions')).rows[0].n).toBe(0);
      await expect(client.query('DELETE FROM inventory_operations WHERE operation_id=$1', [operation])).rejects.toThrow('immutable');
    } finally {
      await client.query('ROLLBACK'); await client.query('RESET search_path');
      if (owned) await client.query('DROP SCHEMA "' + schema + '" CASCADE');
      client.release(); await pool.end();
    }
  }, 20000);
});
