import {inventoryWriteFence,currentInventoryWriter} from './inventory-stream.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {authenticate} from './auth.js';
import {deviceProofError} from './sync-routes.js';
import {inventoryPermission} from './inventory-routes.js';
import {transitionInventory,type InventoryStock,type InventoryUnit} from './inventoryDomain.js';

// A deliberately narrow API: no issue, return, quality release or partial
// container move. All operations are manager-confirmed where required.
// The immutable inventory operation feed is the only replication authority.
const uuid=z.guid();
const qty=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const common=z.object({
  operationId:uuid,deviceId:uuid,expectedRevision:z.number().int().min(1).max(2147483646),
  quantity:qty,reason:z.string().trim().min(1).max(2000),
});
const transfer=common.extend({
  kind:z.literal('transfer'),toLocationId:uuid,
}).strict();
const adjust=common.extend({
  kind:z.literal('adjust'),adjustment:z.enum(['increase','decrease']),
}).strict();
const reserve=common.extend({
  kind:z.literal('reserve'),reservationId:uuid,productionBatchId:uuid,
}).strict();
const release=common.extend({
  kind:z.literal('release_reservation'),reservationId:uuid,productionBatchId:uuid,
}).strict();
const operation=z.discriminatedUnion('kind',[transfer,adjust,reserve,release]);
const paramsSchema=z.object({stockId:uuid}).strict();

function pgCode(error:unknown) {
  return error && typeof error==='object' && 'code' in error ?
    String((error as {code:unknown}).code):'';
}
function asCount(value:unknown) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0)throw new Error('unsafe_inventory_balance');
  return n;
}
function stockFrom(row:Record<string,unknown>):InventoryStock{
  return {
    stockId:String(row.id),materialId:String(row.material_id),
    manufacturerLot:String(row.manufacturer_lot),
    unit:String(row.base_unit) as InventoryUnit,locationId:String(row.location_id),
    quality:row.quality as InventoryStock['quality'],
    onHand:asCount(row.on_hand),reserved:asCount(row.reserved),
    revision:asCount(row.revision),
  };
}

export function registerInventoryStockOperations(app:FastifyInstance,pool:Pool) {
  app.post('/inventory/stocks/:stockId/operations',async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    const p=paramsSchema.safeParse(request.params),parsed=operation.safeParse(request.body);
    if(!p.success||!parsed.success)return reply.code(400).send({error:'invalid_inventory_operation'});
    const data=parsed.data,stockId=p.data.stockId;
    const required=data.kind==='adjust'||data.kind==='reserve'||
      data.kind==='release_reservation'?'manager':'operator';
    if(!(await inventoryPermission(pool,actor,required)))
      return reply.code(403).send({error:'forbidden'});
    const proof=await deviceProofError(pool,actor,request.headers.authorization!,
      data.deviceId,request.headers['x-device-proof']);
    if(proof)return reply.code(403).send({error:proof});

    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      // Same organization lock as receipt insertion: prevents out-of-order
      // feed commits, and serializes changed-intent retries across devices.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [actor.organization_id+':inventory-sequence']);
      if(!await currentInventoryWriter(client,actor.organization_id,actor.id,data.deviceId,request.headers.authorization!,request.headers['x-device-proof'],required)){await client.query('ROLLBACK');return reply.code(403).send({error:'forbidden'});}
      const fence=await inventoryWriteFence(client,actor.organization_id,request.headers['x-inventory-epoch']);
      if(fence){await client.query('ROLLBACK');return reply.code(fence==='inventory_epoch_required'?428:409).send({error:fence});}
      const requestPayload={...data,stockId};
      const existing=await client.query(`SELECT organization_id,actor_id,device_id,stock_id,
          request_payload=$2::jsonb AS identical,result_stock
        FROM inventory_operations WHERE operation_id=$1`,
        [data.operationId,JSON.stringify(requestPayload)]);
      if(existing.rowCount){
        const row=existing.rows[0];
        const same=row.organization_id===actor.organization_id&&
          row.actor_id===actor.id&&row.device_id===data.deviceId&&
          row.stock_id===stockId&&row.identical===true;
        await client.query('ROLLBACK');
        return reply.code(same?200:409).send(same?
          {status:'duplicate',operationId:data.operationId,stock:row.result_stock}:
          {error:'operation_id_reused'});
      }
      const result=await client.query(`SELECT s.id,s.material_id,s.manufacturer_lot,
          s.location_id,s.quality,s.on_hand,s.reserved,s.revision,m.base_unit
        FROM inventory_stocks s
        JOIN inventory_materials m ON m.id=s.material_id
          AND m.organization_id=s.organization_id
        WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`,
        [actor.organization_id,stockId]);
      if(!result.rowCount){
        await client.query('ROLLBACK');
        return reply.code(404).send({error:'stock_not_found'});
      }
      const current=stockFrom(result.rows[0]);
      if(current.revision!==data.expectedRevision){
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'revision_conflict',currentRevision:current.revision});
      }
      if(data.kind==='transfer'){
        const target=await client.query(`SELECT id FROM inventory_locations
          WHERE organization_id=$1 AND id=$2 AND active=true FOR SHARE`,
          [actor.organization_id,data.toLocationId]);
        if(!target.rowCount){
          await client.query('ROLLBACK');
          return reply.code(404).send({error:'destination_not_found'});
        }
      }
      if(data.kind==='reserve'){
        // Only active, released production orders may acquire new reservations.
        // Physical stock still must be separately QA-released; this route
        // cannot manufacture a release decision.
        const batch=await client.query(`SELECT b.id FROM production_batches b
          JOIN production_orders o ON o.organization_id=b.organization_id
            AND o.id=b.order_id
          WHERE b.organization_id=$1 AND b.id=$2
            AND b.status IN ('created','in_progress')
            AND o.status IN ('released','in_progress')
          FOR SHARE OF b,o`,
          [actor.organization_id,data.productionBatchId]);
        if(!batch.rowCount){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'production_batch_unavailable'});
        }
      }
      let ownedReservation:number|undefined;
      if(data.kind==='release_reservation'){
        const reservation=await client.query(`SELECT quantity FROM inventory_reservations
          WHERE organization_id=$1 AND id=$2 AND stock_id=$3
            AND production_batch_id=$4 FOR UPDATE`,
          [actor.organization_id,data.reservationId,stockId,data.productionBatchId]);
        if(!reservation.rowCount){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'reservation_not_found'});
        }
        ownedReservation=asCount(reservation.rows[0].quantity);
      }
      const outcome=transitionInventory(current,{
        operationId:data.operationId,stockId,kind:data.kind,
        actorId:actor.id,expectedRevision:data.expectedRevision,
        quantity:data.quantity,reason:data.reason,
        ...(data.kind==='transfer'?{toLocationId:data.toLocationId}:{}),
        ...(data.kind==='adjust'?{adjustment:data.adjustment}:{}),
        ...(data.kind==='reserve'||data.kind==='release_reservation'?
          {productionBatchId:data.productionBatchId}:{}),
      },{mayAdjust:required==='manager',ownedReservation});
      if(!outcome.ok){
        await client.query('ROLLBACK');
        const status=outcome.code==='invalid'?400:409;
        return reply.code(status).send({error:outcome.code});
      }
      if(data.kind==='reserve'){
        await client.query(`INSERT INTO inventory_reservations
          (id,organization_id,stock_id,production_batch_id,quantity)
          VALUES($1,$2,$3,$4,$5)`,
          [data.reservationId,actor.organization_id,stockId,data.productionBatchId,data.quantity]);
      }else if(data.kind==='release_reservation'){
        if(data.quantity===ownedReservation){
          await client.query(`DELETE FROM inventory_reservations
            WHERE organization_id=$1 AND id=$2 AND stock_id=$3`,
            [actor.organization_id,data.reservationId,stockId]);
        }else{
          await client.query(`UPDATE inventory_reservations
            SET quantity=quantity-$4 WHERE organization_id=$1 AND id=$2 AND stock_id=$3`,
            [actor.organization_id,data.reservationId,stockId,data.quantity]);
        }
      }
      const stock=outcome.stock;
      const updated=await client.query(`UPDATE inventory_stocks
        SET on_hand=$3,reserved=$4,location_id=$5,revision=$6
        WHERE organization_id=$1 AND id=$2 AND revision=$7`,
        [actor.organization_id,stockId,stock.onHand,stock.reserved,
          stock.locationId,stock.revision,data.expectedRevision]);
      if(updated.rowCount!==1)throw new Error('inventory_revision_changed_under_lock');
      const snapshot={...stock,available:outcome.available};
      await client.query(`INSERT INTO inventory_operations
        (operation_id,organization_id,stock_id,actor_id,device_id,kind,
         quantity,expected_revision,resulting_revision,reason,production_batch_id,
         request_payload,result_stock,from_location_id,to_location_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)`,
        [data.operationId,actor.organization_id,stockId,actor.id,data.deviceId,
          data.kind,data.quantity,data.expectedRevision,stock.revision,data.reason,
          'productionBatchId' in data?data.productionBatchId:null,
          JSON.stringify(requestPayload),JSON.stringify(snapshot),
          current.locationId,data.kind==='transfer'?data.toLocationId:null]);
      await client.query('COMMIT');
      return reply.code(201).send({status:'confirmed',operationId:data.operationId,stock:snapshot});
    }catch(error){
      await client.query('ROLLBACK');
      if(pgCode(error)==='23505')
        return reply.code(409).send({error:'inventory_identity_conflict'});
      if(pgCode(error)==='23503')
        return reply.code(409).send({error:'inventory_reference_changed'});
      throw error;
    }finally{client.release();}
  });
}
