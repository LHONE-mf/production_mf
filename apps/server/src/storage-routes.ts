import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, type Principal } from './auth.js';
import { deviceProofError } from './sync-routes.js';
import { hasWholeCount } from './quantities.js';

/**
 * Authoritative Storage v1. All quantities remain decimal strings at the API
 * boundary; PostgreSQL NUMERIC does the arithmetic. No legacy journal or
 * QR transfer is treated as confirmed stock.
 *
 * Mutation order is serialized per organization. This deliberately modest
 * first implementation also makes the operation sequence a safe pull cursor:
 * a later operation can never commit ahead of an earlier sequence.
 */
const id = z.guid();
const base = { operationId:id, deviceId:id };
const label = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(2000);
const optionalLabel = label.optional();
const positive = z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const nonnegative = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const materialSchema = z.object({ ...base, id, name:label,
  category:z.enum(['raw','component','electrode','cell']),
  unit:z.enum(['kg','g','l','m','pieces','cells']) }).strict();
const locationSchema = z.object({ ...base, id, warehouse:label,
  cabinet:label, shelf:label, container:label }).strict();
const managerSchema = z.object({ ...base, userId:id,
  enabled:z.boolean(), reason }).strict();
const receiptSchema = z.object({ ...base, receiptId:id, stockUnitId:id,
  materialId:id, lotId:id, manufacturerLotCode:label, manufacturer:optionalLabel,
  locationId:id, quantity:positive, supplier:optionalLabel,
  documentReference:optionalLabel, evidence:reason }).strict();
const versioned = { ...base, expectedRevision:z.number().int().positive() };
const releaseSchema = z.object({ ...versioned, reason }).strict();
const issueSchema = z.object({ ...versioned, quantity:positive, reason,
  destination:label, productionBatchId:id.optional() }).strict();
const moveSchema = z.object({ ...versioned, quantity:positive,
  destinationLocationId:id, destinationStockUnitId:id, reason }).strict();
const countSchema = z.object({ ...versioned, physicalQuantity:nonnegative, reason }).strict();
const stockParam = z.object({id}).strict();
const pageSchema = z.object({ deviceId:id, after:id.optional() }).strict();
const streamSchema = z.object({ deviceId:id,
  cursor:z.coerce.number().int().nonnegative().default(0),
  limit:z.coerce.number().int().min(1).max(100).default(100) }).strict();

type Command = { operationId:string; deviceId:string };
type Result = { code:number; body:Record<string,unknown> };
const success = (body:Record<string,unknown>,code=201):Result=>({code,body});
const failure = (code:number,error:string,extra:Record<string,unknown>={}):Result=>
  ({code,body:{error,...extra}});
function sqlCode(error:unknown):unknown {
  return error && typeof error==='object' && 'code' in error
    ? (error as {code:unknown}).code : null;
}
async function authorized(pool:Pool,request:FastifyRequest,reply:FastifyReply,deviceId:string) {
  const actor=await authenticate(pool,request.headers.authorization);
  if(!actor) {reply.code(401).send({error:'unauthorized'});return null;}
  const proof=await deviceProofError(pool,actor,request.headers.authorization!,deviceId,request.headers['x-device-proof']);
  if(proof) {reply.code(403).send({error:proof});return null;}
  return actor;
}
async function isWarehouseManager(client:PoolClient,actor:Principal):Promise<boolean> {
  if(actor.role==='chief')return true;
  const row=await client.query('SELECT 1 FROM storage_warehouse_managers WHERE organization_id=$1 AND user_id=$2 AND enabled=true',
    [actor.organization_id,actor.id]);
  return !!row.rowCount;
}
function validForUnit(quantity:string,unit:string) {
  return hasWholeCount(quantity,unit);
}
async function recordMovement(client:PoolClient,actor:Principal,operationId:string,
  stockId:string,kind:'receive'|'release'|'issue'|'move_in'|'move_out'|'reconcile',
  delta:string,balanceAfter:string) {
  await client.query('INSERT INTO storage_ledger_entries (organization_id,id,operation_id,stock_unit_id,kind,quantity_delta,balance_after,actor_id) VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8)',
    [actor.organization_id,randomUUID(),operationId,stockId,kind,delta,balanceAfter,actor.id]);
}
async function currentStock(client:PoolClient,actor:Principal,stockId:string) {
  const result=await client.query(
    'SELECT s.id,s.receipt_id,s.material_id,s.lot_id,s.location_id,s.disposition,s.on_hand::text AS on_hand,s.reserved::text AS reserved,s.revision,m.unit FROM storage_stock_units s JOIN storage_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s',
    [actor.organization_id,stockId]);
  return result.rows[0] as undefined | {id:string;receipt_id:string;material_id:string;lot_id:string;location_id:string;disposition:string;on_hand:string;reserved:string;revision:number;unit:string};
}
async function write(pool:Pool,request:FastifyRequest,reply:FastifyReply,
  kind:string,command:Command & Record<string,unknown>,
  action:(client:PoolClient,actor:Principal)=>Promise<Result>) {
  const actor=await authorized(pool,request,reply,command.deviceId);
  if(!actor)return reply;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializes receipt, issue and sync-sequence commits, including retries.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [actor.organization_id+':storage-v1']);
    const duplicate=await client.query(
      'SELECT actor_id,device_id,kind,request=$3::jsonb AS same_request,response FROM storage_operations WHERE organization_id=$1 AND id=$2',
      [actor.organization_id,command.operationId,JSON.stringify(command)]);
    if(duplicate.rowCount) {
      const old=duplicate.rows[0];
      await client.query('ROLLBACK');
      if(old.actor_id!==actor.id || old.device_id!==command.deviceId ||
          old.kind!==kind || old.same_request!==true)
        return reply.code(409).send({error:'operation_id_reused'});
      return reply.code(200).send({...old.response,alreadyRecorded:true});
    }
    const outcome=await action(client,actor);
    if(outcome.code>=400) {
      await client.query('ROLLBACK');
      return reply.code(outcome.code).send(outcome.body);
    }
    await client.query(
      'INSERT INTO storage_operations (organization_id,id,actor_id,device_id,kind,request,response) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
      [actor.organization_id,command.operationId,actor.id,command.deviceId,kind,
        JSON.stringify(command),JSON.stringify(outcome.body)]);
    await client.query('COMMIT');
    return reply.code(outcome.code).send({...outcome.body,alreadyRecorded:false});
  } catch(error) {
    await client.query('ROLLBACK');
    if(sqlCode(error)==='23505')return reply.code(409).send({error:'duplicate_identity'});
    if(sqlCode(error)==='23503')return reply.code(404).send({error:'related_record_missing'});
    if(sqlCode(error)==='23514' || sqlCode(error)==='22003')return reply.code(400).send({error:'invalid_stock_quantity'});
    throw error;
  } finally {client.release();}
}
export function registerStorageRoutes(app:FastifyInstance,pool:Pool) {
  app.post('/storage/materials',async(request,reply)=>{
    const parsed=materialSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_material'});
    return write(pool,request,reply,'material',parsed.data,async(client,actor)=>{
      if(actor.role!=='chief')return failure(403,'forbidden');
      const p=parsed.data;
      await client.query('INSERT INTO storage_materials (organization_id,id,name,category,unit,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [actor.organization_id,p.id,p.name,p.category,p.unit,actor.id]);
      return success({id:p.id,name:p.name,category:p.category,unit:p.unit});
    });
  });
  app.post('/storage/locations',async(request,reply)=>{
    const parsed=locationSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_location'});
    return write(pool,request,reply,'location',parsed.data,async(client,actor)=>{
      if(actor.role!=='chief')return failure(403,'forbidden');
      const p=parsed.data;
      await client.query('INSERT INTO storage_locations (organization_id,id,warehouse,cabinet,shelf,container,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [actor.organization_id,p.id,p.warehouse,p.cabinet,p.shelf,p.container,actor.id]);
      return success({id:p.id,warehouse:p.warehouse,cabinet:p.cabinet,shelf:p.shelf,container:p.container});
    });
  });
  app.post('/storage/warehouse-managers',async(request,reply)=>{
    const parsed=managerSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_manager_change'});
    return write(pool,request,reply,'warehouse_manager',parsed.data,async(client,actor)=>{
      if(actor.role!=='chief')return failure(403,'forbidden');
      const p=parsed.data;
      const user=await client.query('SELECT id FROM users WHERE organization_id=$1 AND id=$2 AND active=true',
        [actor.organization_id,p.userId]);
      if(!user.rowCount)return failure(404,'user_not_found');
      await client.query(
        'INSERT INTO storage_warehouse_managers (organization_id,user_id,enabled,reason,granted_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,user_id) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason,granted_by=excluded.granted_by,updated_at=now()',
        [actor.organization_id,p.userId,p.enabled,p.reason,actor.id]);
      return success({userId:p.userId,enabled:p.enabled},200);
    });
  });
  app.post('/storage/receipts',async(request,reply)=>{
    const parsed=receiptSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_receipt'});
    return write(pool,request,reply,'receipt',parsed.data,async(client,actor)=>{
      const p=parsed.data;
      const material=await client.query('SELECT unit FROM storage_materials WHERE organization_id=$1 AND id=$2',
        [actor.organization_id,p.materialId]);
      if(!material.rowCount)return failure(404,'material_not_found');
      if(!validForUnit(p.quantity,material.rows[0].unit))return failure(400,'quantity_requires_whole_count');
      const place=await client.query('SELECT id FROM storage_locations WHERE organization_id=$1 AND id=$2',
        [actor.organization_id,p.locationId]);
      if(!place.rowCount)return failure(404,'location_not_found');
      await client.query(
        'INSERT INTO storage_lots (organization_id,id,material_id,manufacturer_lot_code,manufacturer,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,id) DO NOTHING',
        [actor.organization_id,p.lotId,p.materialId,p.manufacturerLotCode,p.manufacturer??null,actor.id]);
      const lot=await client.query('SELECT material_id,manufacturer_lot_code,manufacturer FROM storage_lots WHERE organization_id=$1 AND id=$2',
        [actor.organization_id,p.lotId]);
      if(!lot.rowCount || lot.rows[0].material_id!==p.materialId ||
        lot.rows[0].manufacturer_lot_code!==p.manufacturerLotCode ||
        lot.rows[0].manufacturer!==(p.manufacturer??null))return failure(409,'lot_identity_conflict');
      await client.query(
        'INSERT INTO storage_receipts (organization_id,id,material_id,lot_id,location_id,quantity,supplier,document_reference,evidence,created_by) VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10)',
        [actor.organization_id,p.receiptId,p.materialId,p.lotId,p.locationId,p.quantity,
          p.supplier??null,p.documentReference??null,p.evidence,actor.id]);
      await client.query(
        'INSERT INTO storage_stock_units (organization_id,id,receipt_id,material_id,lot_id,location_id,on_hand) VALUES($1,$2,$3,$4,$5,$6,$7::numeric)',
        [actor.organization_id,p.stockUnitId,p.receiptId,p.materialId,p.lotId,p.locationId,p.quantity]);
      await recordMovement(client,actor,p.operationId,p.stockUnitId,'receive',p.quantity,p.quantity);
      return success({receiptId:p.receiptId,stockUnitId:p.stockUnitId,revision:1,
        onHand:p.quantity,disposition:'quarantine',unit:material.rows[0].unit});
    });
  });
  app.post('/storage/stock/:id/release',async(request,reply)=>{
    const params=stockParam.safeParse(request.params),parsed=releaseSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'invalid_release'});
    return write(pool,request,reply,'release',parsed.data,async(client,actor)=>{
      if(actor.role!=='chief')return failure(403,'forbidden');
      const current=await currentStock(client,actor,params.data.id);
      if(!current)return failure(404,'stock_not_found');
      if(current.revision!==parsed.data.expectedRevision)
        return failure(409,'revision_conflict',{actualRevision:current.revision});
      if(current.disposition!=='quarantine')return failure(409,'not_in_quarantine');
      if(current.on_hand==='0.000000')return failure(409,'empty_stock');
      await client.query(
        "UPDATE storage_stock_units SET disposition='released',revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [actor.organization_id,current.id]);
      await recordMovement(client,actor,parsed.data.operationId,current.id,'release','0',current.on_hand);
      return success({stockUnitId:current.id,revision:current.revision+1,
        onHand:current.on_hand,disposition:'released'});
    });
  });
  app.post('/storage/stock/:id/issue',async(request,reply)=>{
    const params=stockParam.safeParse(request.params),parsed=issueSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'invalid_issue'});
    return write(pool,request,reply,'issue',parsed.data,async(client,actor)=>{
      if(!await isWarehouseManager(client,actor))return failure(403,'forbidden');
      const p=parsed.data;
      const current=await currentStock(client,actor,params.data.id);
      if(!current)return failure(404,'stock_not_found');
      if(current.revision!==p.expectedRevision)
        return failure(409,'revision_conflict',{actualRevision:current.revision});
      if(current.disposition!=='released')return failure(409,'stock_not_released');
      if(!validForUnit(p.quantity,current.unit))return failure(400,'quantity_requires_whole_count');
      if(p.productionBatchId) {
        const batch=await client.query('SELECT id FROM production_batches WHERE organization_id=$1 AND id=$2',
          [actor.organization_id,p.productionBatchId]);
        if(!batch.rowCount)return failure(404,'production_batch_not_found');
      }
      const changed=await client.query(
        'UPDATE storage_stock_units SET on_hand=on_hand-$3::numeric,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND on_hand-reserved >= $3::numeric RETURNING on_hand::text,revision',
        [actor.organization_id,current.id,p.quantity]);
      if(!changed.rowCount)return failure(409,'insufficient_available_stock');
      const after=changed.rows[0];
      await recordMovement(client,actor,p.operationId,current.id,'issue','-'+p.quantity,after.on_hand);
      return success({stockUnitId:current.id,revision:after.revision,onHand:after.on_hand,
        quantityIssued:p.quantity,unit:current.unit,destination:p.destination,
        productionBatchId:p.productionBatchId??null});
    });
  });
  app.post('/storage/stock/:id/move',async(request,reply)=>{
    const params=stockParam.safeParse(request.params),parsed=moveSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'invalid_move'});
    return write(pool,request,reply,'move',parsed.data,async(client,actor)=>{
      if(!await isWarehouseManager(client,actor))return failure(403,'forbidden');
      const p=parsed.data;
      if(p.destinationStockUnitId===params.data.id)return failure(400,'same_stock_identity');
      const current=await currentStock(client,actor,params.data.id);
      if(!current)return failure(404,'stock_not_found');
      if(current.revision!==p.expectedRevision)
        return failure(409,'revision_conflict',{actualRevision:current.revision});
      if(!validForUnit(p.quantity,current.unit))return failure(400,'quantity_requires_whole_count');
      if(p.destinationLocationId===current.location_id)return failure(400,'same_location');
      const place=await client.query('SELECT id FROM storage_locations WHERE organization_id=$1 AND id=$2',
        [actor.organization_id,p.destinationLocationId]);
      if(!place.rowCount)return failure(404,'location_not_found');
      const changed=await client.query(
        'UPDATE storage_stock_units SET on_hand=on_hand-$3::numeric,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND on_hand-reserved >= $3::numeric RETURNING on_hand::text,revision',
        [actor.organization_id,current.id,p.quantity]);
      if(!changed.rowCount)return failure(409,'insufficient_available_stock');
      await client.query(
        'INSERT INTO storage_stock_units (organization_id,id,receipt_id,material_id,lot_id,location_id,disposition,on_hand) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric)',
        [actor.organization_id,p.destinationStockUnitId,current.receipt_id,current.material_id,
          current.lot_id,p.destinationLocationId,current.disposition,p.quantity]);
      await recordMovement(client,actor,p.operationId,current.id,'move_out','-'+p.quantity,changed.rows[0].on_hand);
      await recordMovement(client,actor,p.operationId,p.destinationStockUnitId,'move_in',p.quantity,p.quantity);
      return success({sourceStockUnitId:current.id,sourceRevision:changed.rows[0].revision,
        sourceOnHand:changed.rows[0].on_hand,destinationStockUnitId:p.destinationStockUnitId,
        destinationRevision:1,destinationOnHand:p.quantity,unit:current.unit});
    });
  });
  app.post('/storage/stock/:id/reconcile',async(request,reply)=>{
    const params=stockParam.safeParse(request.params),parsed=countSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'invalid_reconciliation'});
    return write(pool,request,reply,'reconcile',parsed.data,async(client,actor)=>{
      if(!await isWarehouseManager(client,actor))return failure(403,'forbidden');
      const p=parsed.data;
      const current=await currentStock(client,actor,params.data.id);
      if(!current)return failure(404,'stock_not_found');
      if(current.revision!==p.expectedRevision)
        return failure(409,'revision_conflict',{actualRevision:current.revision});
      if(!validForUnit(p.physicalQuantity,current.unit))return failure(400,'quantity_requires_whole_count');
      const changed=await client.query(
        'UPDATE storage_stock_units SET on_hand=$3::numeric,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND reserved <= $3::numeric RETURNING on_hand::text,revision,($3::numeric-$4::numeric)::text AS difference',
        [actor.organization_id,current.id,p.physicalQuantity,current.on_hand]);
      if(!changed.rowCount)return failure(409,'count_below_reserved');
      const after=changed.rows[0];
      await recordMovement(client,actor,p.operationId,current.id,'reconcile',after.difference,after.on_hand);
      return success({stockUnitId:current.id,revision:after.revision,onHand:after.on_hand,
        difference:after.difference});
    });
  });
  app.get('/storage/capabilities',async(request,reply)=>{
    const parsed=pageSchema.safeParse(request.query);
    if(!parsed.success || parsed.data.after)return reply.code(400).send({error:'invalid_capabilities_query'});
    const actor=await authorized(pool,request,reply,parsed.data.deviceId);
    if(!actor)return reply;
    const manager=actor.role==='chief' || !!(await pool.query(
      'SELECT 1 FROM storage_warehouse_managers WHERE organization_id=$1 AND user_id=$2 AND enabled=true',
      [actor.organization_id,actor.id])).rowCount;
    return {actorId:actor.id,organizationId:actor.organization_id,canManageCatalog:actor.role==='chief',
      canRelease:actor.role==='chief',canMoveIssue:manager,canReconcile:manager};
  });
  app.get('/storage/materials',async(request,reply)=>{
    const parsed=pageSchema.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_material_query'});
    const actor=await authorized(pool,request,reply,parsed.data.deviceId);
    if(!actor)return reply;
    const response=await pool.query(
      'SELECT id,name,category,unit FROM storage_materials WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 101',
      [actor.organization_id,parsed.data.after??null]);
    const page=response.rows.slice(0,100);
    return {items:page.map(row=>({id:row.id,name:row.name,category:row.category,unit:row.unit})),
      hasMore:response.rows.length>100,nextAfter:response.rows.length>100?page[page.length-1].id:null};
  });
  app.get('/storage/locations',async(request,reply)=>{
    const parsed=pageSchema.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_location_query'});
    const actor=await authorized(pool,request,reply,parsed.data.deviceId);
    if(!actor)return reply;
    const response=await pool.query(
      'SELECT id,warehouse,cabinet,shelf,container FROM storage_locations WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 101',
      [actor.organization_id,parsed.data.after??null]);
    const page=response.rows.slice(0,100);
    return {items:page.map(row=>({id:row.id,warehouse:row.warehouse,cabinet:row.cabinet,shelf:row.shelf,container:row.container})),
      hasMore:response.rows.length>100,nextAfter:response.rows.length>100?page[page.length-1].id:null};
  });
  app.get('/storage/stock',async(request,reply)=>{
    const parsed=pageSchema.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_stock_query'});
    const actor=await authorized(pool,request,reply,parsed.data.deviceId);
    if(!actor)return reply;
    const p=parsed.data;
    const result=await pool.query(
      'SELECT s.id,s.receipt_id,s.revision,s.disposition,s.on_hand::text AS on_hand,s.reserved::text AS reserved,CASE WHEN s.disposition=\'released\' THEN (s.on_hand-s.reserved)::text ELSE 0::numeric::text END AS available,m.id AS material_id,m.name AS material,m.category,m.unit,l.id AS lot_id,l.manufacturer_lot_code,l.manufacturer,r.supplier,r.document_reference,loc.id AS location_id,loc.warehouse,loc.cabinet,loc.shelf,loc.container FROM storage_stock_units s JOIN storage_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id JOIN storage_lots l ON l.organization_id=s.organization_id AND l.id=s.lot_id JOIN storage_receipts r ON r.organization_id=s.organization_id AND r.id=s.receipt_id JOIN storage_locations loc ON loc.organization_id=s.organization_id AND loc.id=s.location_id WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.id > $2::uuid) ORDER BY s.id LIMIT 101',
      [actor.organization_id,p.after??null]);
    const page=result.rows.slice(0,100);
    return {items:page.map(row=>({
      id:row.id,receiptId:row.receipt_id,revision:row.revision,disposition:row.disposition,
      onHand:row.on_hand,reserved:row.reserved,available:row.available,
      materialId:row.material_id,material:row.material,category:row.category,unit:row.unit,
      lotId:row.lot_id,manufacturerLotCode:row.manufacturer_lot_code,manufacturer:row.manufacturer,
      supplier:row.supplier,documentReference:row.document_reference,
      locationId:row.location_id,warehouse:row.warehouse,cabinet:row.cabinet,
      shelf:row.shelf,container:row.container,
    })),hasMore:result.rows.length>100,nextAfter:result.rows.length>100?page[page.length-1].id:null};
  });
  app.get('/storage/changes',async(request,reply)=>{
    const parsed=streamSchema.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_stream_query'});
    const actor=await authorized(pool,request,reply,parsed.data.deviceId);
    if(!actor)return reply;
    const p=parsed.data;
    const result=await pool.query(
      "SELECT sequence,kind,response FROM storage_operations WHERE organization_id=$1 AND sequence>$2 AND kind IN ('material','location','receipt','release','issue','move','reconcile') ORDER BY sequence LIMIT $3",
      [actor.organization_id,p.cursor,p.limit+1]);
    const page=result.rows.slice(0,p.limit);
    return {changes:page.map(row=>({sequence:Number(row.sequence),kind:row.kind,result:row.response})),
      nextCursor:page.length?Number(page[page.length-1].sequence):p.cursor,
      hasMore:result.rows.length>p.limit};
  });
}
