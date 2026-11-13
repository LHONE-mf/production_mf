import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {authenticate} from './auth.js';
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
    const rows=await pool.query(`SELECT id,material_code,display_name,category,base_unit
      FROM inventory_materials
      WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,
      [result.actor.organization_id,data.after??null,data.limit+1]);
    const items=rows.rows.slice(0,data.limit);
    const hasMore=rows.rows.length>data.limit;
    return {materials:items.map(r=>({
      id:r.id,code:r.material_code,name:r.display_name,
      category:r.category,baseUnit:r.base_unit,
    })),hasMore,nextAfter:hasMore?items[items.length-1].id:null};
  });

  app.get('/inventory/locations',async(request,reply)=>{
    const result=await verifiedReader(request,reply,true);
    if(!result)return;
    const data=result.data as z.infer<typeof query>;
    // Include inactive locations for traceability of historical stock references.
    const rows=await pool.query(`SELECT id,parent_id,label,kind,active
      FROM inventory_locations
      WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,
      [result.actor.organization_id,data.after??null,data.limit+1]);
    const items=rows.rows.slice(0,data.limit);
    const hasMore=rows.rows.length>data.limit;
    return {locations:items.map(r=>({
      id:r.id,parentId:r.parent_id,label:r.label,kind:r.kind,active:r.active,
    })),hasMore,nextAfter:hasMore?items[items.length-1].id:null};
  });

  app.get('/inventory/access/me',async(request,reply)=>{
    const result=await verifiedReader(request,reply,false);
    if(!result)return;
    if(result.actor.role==='chief'){
      return {level:'chief',canRecordReceipts:true,canManageCatalog:true,
        canCorrectStock:true};
    }
    const found=await pool.query(`SELECT level FROM inventory_access
      WHERE organization_id=$1 AND user_id=$2 AND active=true`,
      [result.actor.organization_id,result.actor.id]);
    // Recheck the grant. Do not infer warehouse permission from generic Master.
    const level=found.rows[0]?.level;
    if(level!=='operator'&&level!=='manager')
      return reply.code(403).send({error:'forbidden'});
    return {level,canRecordReceipts:true,canManageCatalog:level==='manager',
      canCorrectStock:level==='manager'};
  });
}
