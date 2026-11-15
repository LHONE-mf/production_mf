/** SYNTHETIC engineering fixture only. No production setup or automatic stock. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticCellSource} from '../../apps/server/dist/inventory-cell-test-source.js';
export async function createDisposableCellBatch({pool,organizationId,actorId}){
 const org=organizationId,route=randomUUID(),order=randomUUID(),batch=randomUUID(),workshop='cell-'+randomUUID();
 await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop]);
 await pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'SYNTHETIC final Formation',$3)",[org,route,actorId]);await pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[org,route]);
 await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Final Formation','formation',$3,'common')",[org,route,workshop]);await pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[org,route,actorId]);
 await pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'SYNTHETIC finished cell',$3,1,'released',999,'pieces',$4)",[org,order,route,actorId]);await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cell','in_progress',$4)",[org,batch,order,actorId]);
 return{batch,workshop};
}
export async function seedDisposableCellSubmission({pool,post,organizationId,actorId,deviceId}){
 const {batch}=await createDisposableCellBatch({pool,organizationId,actorId}),material=randomUUID(),completion=randomUUID();
 await post('/inventory/materials',{id:material,deviceId,code:'CELL-'+material,name:'SYNTHETIC submitted cell',category:'cell',baseUnit:'pieces'});
 for(const event of [{eventId:randomUUID(),kind:'started'},{eventId:completion,kind:'completed',quantity:'2',quantityUnit:'pieces'}])await post('/planning/batches/'+batch+'/steps/1/evidence',event);
 const source=syntheticCellSource(),submission={operationId:randomUUID(),deviceId,productionBatchId:batch,completionId:completion,stepNumber:1,materialId:material,source,reason:'Explicit completed cell output submission without stock',evidence:'SYNTHETIC completed route and actual serial sheet'};
 const before=(await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[organizationId])).rows[0].n;
 const submitted=await post('/inventory/cell-outputs',submission);assert.equal(submitted.submission.quantity,2);assert.equal(submitted.submission.source.formation.cellsIn,4);assert.deepEqual(submitted.submission.source.ranges,[{start:10,end:10},{start:12,end:12}]);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[organizationId])).rows[0].n,before);
 return{submission,submitted};
}
