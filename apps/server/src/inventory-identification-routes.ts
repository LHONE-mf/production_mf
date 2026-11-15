import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {inventoryStockFromRow} from './inventory-snapshot.js';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';
const uuid=z.guid(),query=z.object({deviceId:uuid,organizationId:uuid,kind:z.enum(['container','location','batch']),id:uuid}).strict();
export function registerInventoryIdentificationRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/identification',async(request,reply)=>{
  const parsed=query.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_inventory_identity'});const data=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,false,undefined,async(client,actor,level,epoch)=>{
   if(data.organizationId!==actor.organization_id)issueFail(404,'inventory_identity_not_found');
   if(data.kind!=='batch'&&!level)issueFail(403,'warehouse_access_required');
   let item:object;
   if(data.kind==='container'){
    const row=(await client.query('SELECT s.*,m.base_unit,m.material_code,m.display_name,m.category,l.label AS location_label,inventory_package_released(s.organization_id,s.id) AS eligible FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id JOIN inventory_locations l ON l.organization_id=s.organization_id AND l.id=s.location_id WHERE s.organization_id=$1 AND s.id=$2',[actor.organization_id,data.id])).rows[0];if(!row)issueFail(404,'inventory_identity_not_found');const stock=inventoryStockFromRow(row);
    const origin=(await client.query("SELECT operation_id,kind,request_payload,production_batch_id FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2 AND expected_revision=0 ORDER BY sequence LIMIT 1",[actor.organization_id,data.id])).rows[0];
    item={stock:{...stock,available:stock.onHand-stock.reserved},materialCode:row.material_code,materialName:row.display_name,category:row.category,locationLabel:row.location_label,eligible:row.eligible,origin:origin?{operationId:origin.operation_id,kind:origin.kind,parentStockId:origin.request_payload.parentStockId??origin.request_payload.sourceStockId??null,issueId:origin.request_payload.issueId??null,productionBatchId:origin.production_batch_id}:null};
   }else if(data.kind==='location'){
    const row=(await client.query('SELECT id,parent_id AS "parentId",label,kind,active,revision FROM inventory_locations WHERE organization_id=$1 AND id=$2',[actor.organization_id,data.id])).rows[0];if(!row)issueFail(404,'inventory_identity_not_found');item=row;
   }else{
    const row=(await client.query(`SELECT b.id,b.batch_code AS "batchCode",b.material_line AS "materialLine",b.status,o.order_code AS "orderCode",o.product_code AS "productCode" FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id WHERE b.organization_id=$1 AND b.id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM process_route_steps s JOIN user_workshop_memberships m ON m.organization_id=s.organization_id AND m.workshop_id=s.workshop_id AND m.user_id=$4 WHERE s.organization_id=b.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END))`,[actor.organization_id,data.id,!!level,actor.id])).rows[0];if(!row)issueFail(404,'inventory_identity_not_found');item=row;
   }
   return{epoch,organizationId:actor.organization_id,kind:data.kind,item};
  });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
}
