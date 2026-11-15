import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Synthetic engineering evidence only. The caller owns a disposable database. */
export async function seedDisposableFinishedOutput({pool,post,organizationId,actorId,deviceId,locationId}){
 const org=organizationId,route=randomUUID(),order=randomUUID(),batch=randomUUID(),workshop='finished-'+randomUUID(),material=randomUUID(),completion=randomUUID();
 await pool.query('INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)',[org,workshop]);
 await pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic final sorting',$3)",[org,route,actorId]);
 await pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[org,route]);
 await pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Final sorting','sorting',$3,'anode')",[org,route,workshop]);
 await pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[org,route,actorId]);
 await pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic electrode',$3,1,'released',999,'pieces',$4)",[org,order,route,actorId]);
 await pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'anode','in_progress',$4)",[org,batch,order,actorId]);
 await post('/inventory/materials',{id:material,deviceId,code:'ELECTRODE-'+material,name:'Synthetic physical counted electrode',category:'electrode',baseUnit:'pieces'});
 await post('/planning/batches/'+batch+'/steps/1/evidence',{eventId:randomUUID(),kind:'started'});
 await post('/planning/batches/'+batch+'/steps/1/evidence',{eventId:completion,kind:'completed',quantity:'7',quantityUnit:'pieces'});
 const submission={operationId:randomUUID(),deviceId,productionBatchId:batch,stepNumber:1,completionId:completion,
  source:{runId:randomUUID(),cutRunId:randomUUID(),specId:randomUUID(),mode:'grading',inputCount:10,
   categories:[{name:'A',minMass:1,maxMass:2},{name:'B',minMass:2,maxMass:3}],
   stages:[{station:'visual',inputCount:10,passedCount:9,rejectedCount:1,workerId:'synthetic-visual',recordedAt:1000},
    {station:'thickness',inputCount:9,passedCount:8,rejectedCount:1,workerId:'synthetic-thickness',recordedAt:2000},
    {station:'mass',inputCount:8,passedCount:7,rejectedCount:1,workerId:'synthetic-mass',recordedAt:3000,grades:[{categoryName:'A',count:4},{categoryName:'B',count:3}]}]},
  outputs:[{grade:'A',materialId:material,quantity:4},{grade:'B',materialId:material,quantity:3}],
  reason:'Deliberate actual output submission, not a planned target',evidence:'Synthetic completed manual station count sheet'};
 const before=Number((await pool.query('SELECT count(*) AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n);
 const submitted=await post('/inventory/outputs/electrodes',submission);
 assert.equal(Number((await pool.query('SELECT count(*) AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n),before,'Submission must not create stock');
 const acceptance={operationId:randomUUID(),deviceId,submissionId:submission.operationId,grade:'A',expectedRevision:1,stockId:randomUUID(),locationId,quantity:4,
  manufacturedOn:'2026-01-01',expiresOn:'2099-12-31',reason:'Separate deliberate physical acceptance in Storage',evidence:'Synthetic independent receiving count sheet'};
 const accepted=await post('/inventory/outputs/accept',acceptance);
 assert.equal(accepted.stock.quality,'quarantine');assert.equal(accepted.stock.onHand,4);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_output_acceptances WHERE organization_id=$1',[org])).rows[0].n,1);
 return{submission,submitted,acceptance,accepted};
}
