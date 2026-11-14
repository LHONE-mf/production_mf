import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';

// Material balances are aggregated in PostgreSQL NUMERIC and returned as decimal
// strings: summing many individually safe containers must not lose exact units.
const query=z.object({
 deviceId:z.guid(),after:z.guid().optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50),
 expiryDays:z.coerce.number().int().min(0).max(365).default(30),
}).strict();
export function registerInventoryMaterialSummaryRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/reports/materials',async(request,reply)=>{
  const parsed=query.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_material_report_query'});
  const q=parsed.data;
  try{
   return await issueTransaction(pool,request.headers.authorization,
    request.headers['x-device-proof'],q.deviceId,false,undefined,
    async(client,actor,level,epoch)=>{
     if(!level)issueFail(403,'warehouse_access_required');
     const result=await client.query(`
      SELECT m.id,m.material_code,m.display_name,m.base_unit,m.category,m.active,
       COALESCE(SUM(s.on_hand),0)::text AS on_hand,
       COALESCE(SUM(s.reserved),0)::text AS reserved,
       COALESCE(SUM(s.on_hand-s.reserved),0)::text AS physically_unreserved,
       COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND
         inventory_package_released(s.organization_id,s.id)
         THEN s.on_hand-s.reserved ELSE 0 END),0)::text AS eligible_available,
       COALESCE(SUM(CASE WHEN s.quality='quarantine'
         THEN s.on_hand ELSE 0 END),0)::text AS quarantined,
       COALESCE(SUM(CASE WHEN s.quality='blocked'
         THEN s.on_hand ELSE 0 END),0)::text AS blocked,
       COALESCE(SUM(CASE WHEN s.expires_at<=now()
         THEN s.on_hand ELSE 0 END),0)::text AS expired,
       COUNT(s.id)::text AS package_count,
       COUNT(DISTINCT s.manufacturer_lot)::text AS manufacturer_lots,
       COUNT(s.id) FILTER (WHERE s.expires_at>now()
         AND s.expires_at<=now()+$3::integer*INTERVAL '1 day')::text AS expiring_packages
      FROM inventory_materials m
      LEFT JOIN inventory_stocks s ON s.organization_id=m.organization_id
        AND s.material_id=m.id
      WHERE m.organization_id=$1 AND ($2::uuid IS NULL OR m.id>$2)
      GROUP BY m.id,m.material_code,m.display_name,m.base_unit,m.category,m.active
      ORDER BY m.id LIMIT $4`,
      [actor.organization_id,q.after??null,q.expiryDays,q.limit+1]);
     const rows=result.rows.slice(0,q.limit);
     return{epoch,asOf:(await client.query('SELECT transaction_timestamp() AS at')).rows[0].at.toISOString(),
      expiryDays:q.expiryDays,items:rows.map(row=>({
       materialId:row.id,code:row.material_code,name:row.display_name,
       unit:row.base_unit,category:row.category,active:row.active,
       onHand:row.on_hand,reserved:row.reserved,
       physicallyUnreserved:row.physically_unreserved,eligibleAvailable:row.eligible_available,
       quarantined:row.quarantined,blocked:row.blocked,expired:row.expired,
       packageCount:row.package_count,manufacturerLots:row.manufacturer_lots,
       expiringPackages:row.expiring_packages,
      })),hasMore:result.rows.length>q.limit,
      nextAfter:result.rows.length>q.limit?rows[rows.length-1].id:null};
    });
  }catch(error){const found=issueHttpError(error);return reply.code(found.status).send(found.body);}
 });
}
