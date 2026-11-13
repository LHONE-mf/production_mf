import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, type Principal } from './auth.js';
import { deviceProofError } from './sync-routes.js';
import { transitionInventory, type InventoryStock, type InventoryUnit } from './inventoryDomain.js';

// Warehouse stock cannot be posted through the generic task sync endpoint.
// Every write requires server authorization, a current actor-bound device proof,
// a unique operation ID, and one PostgreSQL transaction for stock + immutable ledger.
const uuid = z.guid();
const device = z.object({ deviceId: uuid }).strict();
const page = device.extend({ after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const materialSchema = device.extend({
  id: uuid, code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  category: z.enum(['raw_material', 'component', 'electrode', 'cell']),
  baseUnit: z.enum(['mg', 'ul', 'mm', 'pieces']),
}).strict();
const locationSchema = device.extend({
  id: uuid, parentId: uuid.nullable(), label: z.string().trim().min(1).max(200),
  kind: z.enum(['warehouse', 'cabinet', 'rack', 'shelf', 'container_area']),
}).strict();
const receiptSchema = device.extend({
  operationId: uuid, stockId: uuid, materialId: uuid, locationId: uuid,
  manufacturerLot: z.string().trim().min(1).max(200),
  supplier: z.string().trim().min(1).max(200).optional(),
  receiptReference: z.string().trim().min(1).max(200).optional(),
  expectedRevision: z.literal(0), quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(2000),
}).strict();
const accessSchema = device.extend({
  changeId: uuid, userId: uuid, level: z.enum(['operator','manager']),
  action: z.enum(['grant','revoke']),
}).strict();

function dbErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as {code:unknown}).code) : '';
}
function safeCount(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('unsafe_inventory_balance');
  return value;
}
function toStock(row: Record<string, unknown>): InventoryStock {
  return {
    stockId: String(row.id), materialId: String(row.material_id),
    manufacturerLot: String(row.manufacturer_lot),
    unit: String(row.base_unit) as InventoryUnit,
    locationId: String(row.location_id),
    quality: row.quality as InventoryStock['quality'],
    onHand: safeCount(row.on_hand), reserved: safeCount(row.reserved),
    revision: safeCount(row.revision),
  };
}

async function inventoryPermission(pool: Pool, actor: Principal, required: 'operator'|'manager') {
  if (actor.role === 'chief') return true;
  const result = await pool.query(
    'SELECT level FROM inventory_access WHERE organization_id=$1 AND user_id=$2 AND active=true',
    [actor.organization_id,actor.id]);
  const level = result.rows[0]?.level as string | undefined;
  return level === 'manager' || (required === 'operator' && level === 'operator');
}
async function proofError(pool: Pool, actor: Principal, authorization: string|undefined,
                          deviceId: string, token: unknown) {
  return deviceProofError(pool, actor, authorization!, deviceId, token);
}

/** The permission for inventory access is separate from the generic Master role. */
export function registerInventoryRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/inventory/access', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({error:'unauthorized'});
    if (actor.role !== 'chief') return reply.code(403).send({error:'forbidden'});
    const parsed = accessSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'invalid_request'});
    const data = parsed.data;
    const proof = await proofError(pool,actor,request.headers.authorization,data.deviceId,request.headers['x-device-proof']);
    if (proof) return reply.code(403).send({error:proof});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [actor.organization_id+':inventory-access']);
      const prior = await client.query(
        'SELECT organization_id,user_id,actor_id,level,action FROM inventory_access_events WHERE id=$1',
        [data.changeId]);
      if (prior.rowCount) {
        const row=prior.rows[0];
        const same = row.organization_id === actor.organization_id && row.user_id === data.userId &&
          row.actor_id === actor.id && row.level === data.level && row.action === data.action;
        await client.query('ROLLBACK');
        return reply.code(same?200:409).send(same?{status:'duplicate',changeId:data.changeId}:{error:'change_id_reused'});
      }
      const target = await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=true',
        [data.userId,actor.organization_id]);
      if (!target.rowCount) {await client.query('ROLLBACK');return reply.code(404).send({error:'user_not_found'});}
      if (data.action==='grant') {
        await client.query(`INSERT INTO inventory_access(organization_id,user_id,level,granted_by,active)
          VALUES($1,$2,$3,$4,true) ON CONFLICT(organization_id,user_id)
          DO UPDATE SET level=EXCLUDED.level,granted_by=EXCLUDED.granted_by,granted_at=now(),active=true`,
          [actor.organization_id,data.userId,data.level,actor.id]);
      } else {
        const updated = await client.query(`UPDATE inventory_access SET active=false
          WHERE organization_id=$1 AND user_id=$2 AND active=true AND level=$3`,
          [actor.organization_id,data.userId,data.level]);
        if (!updated.rowCount) {await client.query('ROLLBACK');return reply.code(409).send({error:'access_not_active'});}
      }
      await client.query(`INSERT INTO inventory_access_events
        (id,organization_id,user_id,actor_id,level,action) VALUES($1,$2,$3,$4,$5,$6)`,
        [data.changeId,actor.organization_id,data.userId,actor.id,data.level,data.action]);
      await client.query('COMMIT');
      return reply.code(201).send({status:'confirmed',changeId:data.changeId});
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {client.release();}
  });

  app.post('/inventory/materials', async (request, reply) => {
    const actor = await authenticate(pool,request.headers.authorization);
    if (!actor) return reply.code(401).send({error:'unauthorized'});
    const body=materialSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({error:'invalid_request'});
    if (!(await inventoryPermission(pool,actor,'manager'))) return reply.code(403).send({error:'forbidden'});
    const proof=await proofError(pool,actor,request.headers.authorization,body.data.deviceId,request.headers['x-device-proof']);
    if (proof) return reply.code(403).send({error:proof});
    const {id,code,name,category,baseUnit}=body.data;
    try {
      await pool.query(`INSERT INTO inventory_materials
        (id,organization_id,material_code,display_name,category,base_unit)
        VALUES($1,$2,$3,$4,$5,$6)`,[id,actor.organization_id,code,name,category,baseUnit]);
      return reply.code(201).send({id,code,name,category,baseUnit});
    } catch(error) {
      if(dbErrorCode(error)==='23505') return reply.code(409).send({error:'material_identity_conflict'});
      throw error;
    }
  });

  app.post('/inventory/locations', async (request, reply) => {
    const actor = await authenticate(pool,request.headers.authorization);
    if (!actor) return reply.code(401).send({error:'unauthorized'});
    const body=locationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({error:'invalid_request'});
    if (!(await inventoryPermission(pool,actor,'manager'))) return reply.code(403).send({error:'forbidden'});
    const proof=await proofError(pool,actor,request.headers.authorization,body.data.deviceId,request.headers['x-device-proof']);
    if (proof) return reply.code(403).send({error:proof});
    const {id,parentId,label,kind}=body.data;
    if ((kind === 'warehouse') !== (parentId === null))
      return reply.code(400).send({error:'invalid_location_hierarchy'});
    if (parentId) {
      const parent=await pool.query('SELECT kind FROM inventory_locations WHERE id=$1 AND organization_id=$2 AND active=true',
        [parentId,actor.organization_id]);
      const kinds:Record<string,readonly string[]>={cabinet:['warehouse'],rack:['warehouse'],shelf:['cabinet','rack'],container_area:['shelf']};
      if (!parent.rowCount || !kinds[kind]?.includes(parent.rows[0].kind))
        return reply.code(400).send({error:'invalid_location_hierarchy'});
    }
    try {
      await pool.query(`INSERT INTO inventory_locations
        (id,organization_id,parent_id,label,kind) VALUES($1,$2,$3,$4,$5)`,
        [id,actor.organization_id,parentId,label,kind]);
      return reply.code(201).send({id,parentId,label,kind});
    } catch(error) {
      if(dbErrorCode(error)==='23505') return reply.code(409).send({error:'location_identity_conflict'});
      if(dbErrorCode(error)==='23503') return reply.code(409).send({error:'location_parent_changed'});
      throw error;
    }
  });

  app.get('/inventory/stocks', async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    const parsed=page.safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:'invalid_request'});
    if(!(await inventoryPermission(pool,actor,'operator')))return reply.code(403).send({error:'forbidden'});
    const proof=await proofError(pool,actor,request.headers.authorization,parsed.data.deviceId,request.headers['x-device-proof']);
    if(proof)return reply.code(403).send({error:proof});
    const {after,limit}=parsed.data;
    const result=await pool.query(`SELECT s.id,s.material_id,s.manufacturer_lot,s.location_id,
      s.quality,s.on_hand,s.reserved,s.revision,m.base_unit
      FROM inventory_stocks s JOIN inventory_materials m
        ON m.id=s.material_id AND m.organization_id=s.organization_id
      WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.id>$2)
      ORDER BY s.id LIMIT $3`,[actor.organization_id,after??null,limit+1]);
    const slice=result.rows.slice(0,limit);
    return {stocks:slice.map(row=>{const stock=toStock(row);return {...stock,available:stock.onHand-stock.reserved};}),
      hasMore:result.rows.length>limit,nextAfter:result.rows.length>limit?slice[slice.length-1].id:null};
  });

  app.post('/inventory/receipts', async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    const parsed=receiptSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_request'});
    const data=parsed.data;
    if(!(await inventoryPermission(pool,actor,'operator')))return reply.code(403).send({error:'forbidden'});
    const proof=await proofError(pool,actor,request.headers.authorization,data.deviceId,request.headers['x-device-proof']);
    if(proof)return reply.code(403).send({error:proof});
    const client:PoolClient=await pool.connect();
    try{
      await client.query('BEGIN');
      // This organization-scoped commit-order lock also prevents duplicate
      // operation IDs and competing first receipts from racing each other.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [actor.organization_id+':inventory-sequence']);
      const prior=await client.query(`SELECT organization_id,actor_id,device_id,stock_id,
          request_payload=$2::jsonb AS identical,result_stock
        FROM inventory_operations WHERE operation_id=$1`,
        [data.operationId,JSON.stringify(data)]);
      if(prior.rowCount){
        const row=prior.rows[0];
        const same=row.organization_id===actor.organization_id&&row.actor_id===actor.id &&
          row.device_id===data.deviceId&&row.stock_id===data.stockId&&row.identical===true;
        await client.query('ROLLBACK');
        return reply.code(same?200:409).send(same
          ?{status:'duplicate',operationId:data.operationId,stock:row.result_stock}
          :{error:'operation_id_reused'});
      }
      const material=await client.query(`SELECT base_unit FROM inventory_materials
        WHERE organization_id=$1 AND id=$2`,[actor.organization_id,data.materialId]);
      const location=await client.query(`SELECT id FROM inventory_locations
        WHERE organization_id=$1 AND id=$2 AND active=true`,[actor.organization_id,data.locationId]);
      if(!material.rowCount||!location.rowCount){
        await client.query('ROLLBACK');
        return reply.code(404).send({error:'material_or_location_not_found'});
      }
      const existing=await client.query('SELECT id FROM inventory_stocks WHERE organization_id=$1 AND id=$2',
        [actor.organization_id,data.stockId]);
      if(existing.rowCount){
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'stock_id_reused'});
      }
      const calculated=transitionInventory(undefined,{
        operationId:data.operationId,stockId:data.stockId,kind:'receive',expectedRevision:0,
        actorId:actor.id,reason:data.reason,quantity:data.quantity,
        materialId:data.materialId,manufacturerLot:data.manufacturerLot,
        unit:material.rows[0].base_unit,locationId:data.locationId,quality:'quarantine',
      });
      if(!calculated.ok){
        await client.query('ROLLBACK');
        return reply.code(400).send({error:calculated.code});
      }
      const stock=calculated.stock;
      await client.query(`INSERT INTO inventory_stocks
        (id,organization_id,material_id,manufacturer_lot,supplier,receipt_reference,
          location_id,quality,on_hand,reserved,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,'quarantine',$8,0,1)`,
        [data.stockId,actor.organization_id,data.materialId,data.manufacturerLot,
        data.supplier??null,data.receiptReference??null,data.locationId,data.quantity]);
      const snapshot={...stock,available:calculated.available};
      await client.query(`INSERT INTO inventory_operations
        (operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,
         expected_revision,resulting_revision,reason,request_payload,result_stock)
        VALUES($1,$2,$3,$4,$5,'receive',$6,0,1,$7,$8::jsonb,$9::jsonb)`,
        [data.operationId,actor.organization_id,data.stockId,actor.id,data.deviceId,
        data.quantity,data.reason,JSON.stringify(data),JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return reply.code(201).send({status:'confirmed',operationId:data.operationId,stock:snapshot});
    } catch(error){
      await client.query('ROLLBACK');
      if(dbErrorCode(error)==='23505')return reply.code(409).send({error:'inventory_identity_conflict'});
      throw error;
    } finally{client.release();}
  });
}
