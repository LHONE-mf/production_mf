import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {authenticate,tokenHash} from './auth.js';
import {deviceProofError} from './sync-routes.js';
import {inventoryPermission} from './inventory-routes.js';

// Read-only, device-proven catalog discovery. Inventory data belongs to one
// organization and is never derived from offline journals or demo fixtures.
const uuid=z.guid();
const query=z.object({
  deviceId:uuid,
  after:uuid.optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const selfQuery=z.object({deviceId:uuid}).strict();

export function registerInventoryCatalogRoutes(app:FastifyInstance,pool:Pool){
  async function verifiedReader(request:{
    headers:{authorization?:string; 'x-device-proof'?:unknown};
    query:unknown;
  }, reply:{
    code:(status:number)=>{send:(body:object)=>unknown};
  }, paginated:boolean){
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor){
      reply.code(401).send({error:'unauthorized'});
      return null;
    }
    const parsed=(paginated?query:selfQuery).safeParse(request.query);
    if(!parsed.success){
      reply.code(400).send({error:'invalid_inventory_catalog_query'});
      return null;
    }
    if(!(await inventoryPermission(pool,actor,'operator'))){
      reply.code(403).send({error:'forbidden'});
      return null;
    }
    const proof=await deviceProofError(pool,actor,request.headers.authorization!,
      parsed.data.deviceId,request.headers['x-device-proof']);
    if(proof){
      reply.code(403).send({error:proof});
      return null;
    }
    return {actor,data:parsed.data};
  }

  app.get('/inventory/materials',async(request,reply)=>{
    const result=await verifiedReader(request,reply,true);
    if(!result)return;
    const data=result.data as z.infer<typeof query>;
    const rows=await pool.query(`SELECT id,material_code,display_name,category,base_unit,revision,active,supplier_reference
      FROM inventory_materials
      WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,
      [result.actor.organization_id,data.after??null,data.limit+1]);
    const items=rows.rows.slice(0,data.limit);
    const hasMore=rows.rows.length>data.limit;
    return {materials:items.map(r=>({
      id:r.id,code:r.material_code,name:r.display_name,
      category:r.category,baseUnit:r.base_unit,revision:r.revision,active:r.active,supplierReference:r.supplier_reference,
    })),hasMore,nextAfter:hasMore?items[items.length-1].id:null};
  });

  app.get('/inventory/locations',async(request,reply)=>{
    const result=await verifiedReader(request,reply,true);
    if(!result)return;
    const data=result.data as z.infer<typeof query>;
    // Include inactive locations for traceability of historical stock references.
    const rows=await pool.query(`SELECT id,parent_id,label,kind,active,revision
      FROM inventory_locations
      WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,
      [result.actor.organization_id,data.after??null,data.limit+1]);
    const items=rows.rows.slice(0,data.limit);
    const hasMore=rows.rows.length>data.limit;
    return {locations:items.map(r=>({
      id:r.id,parentId:r.parent_id,label:r.label,kind:r.kind,active:r.active,revision:r.revision,
    })),hasMore,nextAfter:hasMore?items[items.length-1].id:null};
  });

  app.get('/inventory/access/me',async(request,reply)=>{
    const result=await verifiedReader(request,reply,false);
    if(!result)return;
    // Recheck current user, device, session and warehouse access in one snapshot.
    const found=await pool.query(`SELECT u.role,a.level,clock_timestamp() AS issued_at,
      LEAST(s.expires_at,g.created_at+interval '8 hours') AS expires_at
      FROM device_proof_grants g
      JOIN sessions s ON s.token_hash=g.session_token_hash AND s.organization_id=g.organization_id AND s.user_id=g.user_id
      JOIN users u ON u.id=g.user_id AND u.organization_id=g.organization_id
      JOIN devices d ON d.id=g.device_id AND d.organization_id=g.organization_id AND d.user_id=g.user_id
      LEFT JOIN inventory_access a ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.active
      WHERE g.token_hash=$1 AND g.organization_id=$2 AND g.user_id=$3 AND g.device_id=$4
        AND g.session_token_hash=$5 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND d.revoked_at IS NULL AND u.active`,
      [tokenHash(request.headers['x-device-proof'] as string),result.actor.organization_id,result.actor.id,result.data.deviceId,tokenHash(request.headers.authorization!.slice(7))]);
    const row=found.rows[0],level=row?.role==='chief'?'chief':row?.level;
    if(!row||!['chief','manager','operator'].includes(level))return reply.code(403).send({error:'forbidden'});
    return {level,canRecordReceipts:true,canManageCatalog:level!=='operator',
      canCorrectStock:level!=='operator',correctionRoleEligible:level!=='operator',
      offlineView:{organizationId:result.actor.organization_id,actorId:result.actor.id,deviceId:result.data.deviceId,
        issuedAt:row.issued_at.toISOString(),expiresAt:row.expires_at.toISOString()}};
  });
}
