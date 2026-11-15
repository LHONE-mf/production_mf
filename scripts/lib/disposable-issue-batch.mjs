/** Synthetic production planning only; never creates stock or bypasses QA/issue approval. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function createDisposableIssueBatch(pool, organizationId, chiefId, recipientId) {
  const db = (await pool.query('SELECT current_database() AS name,current_user AS owner')).rows[0];
  assert(['production_mf_ci', 'production_mf_emulator_ci'].includes(db.name) && db.owner === 'production_mf_ci', 'Disposable database required');
  const batchId = randomUUID(), route = randomUUID(), order = randomUUID(), workshopId = 'CI-Slurry-' + randomUUID();
  await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)', [organizationId, workshopId]);
  await pool.query('INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)', [organizationId, recipientId, workshopId]);
  await pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic material handoff route',$3)", [organizationId, route, chiefId]);
  await pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)', [organizationId, route]);
  await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Synthetic material weighing','slurry',$3,'cathode')", [organizationId, route, workshopId]);
  await pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2", [organizationId, route, chiefId]);
  await pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'CI-NMC',$3,1,'released',1,'kg',$4)", [organizationId, order, route, chiefId]);
  await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2,$3,'CI-HANDOFF','cathode','created',$4)", [organizationId, batchId, order, chiefId]);
  return { batchId, workshopId, stepNumber: 1 };
}
