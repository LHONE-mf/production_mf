import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {inventoryStockFromRow} from './inventory-snapshot.js';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';

// Read-only, server-confirmed stock health. One-off thresholds do not change
// durable material policies or post inventory mutations.
const query=z.object({
  deviceId:z.guid(),after:z.guid().optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
  expiryDays:z.coerce.number().int().min(0).max(365).default(30),
  lowAvailable:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  materialId:z.guid().optional(),
  view:z.enum(['all','alerts']).default('alerts'),
}).strict();
const day=86_400_000;
export function registerInventoryAlertRoutes(app:FastifyInstance,pool:Pool){
  app.get('/inventory/reports/alerts',async(request,reply)=>{
    const parsed=query.safeParse(request.query);
    if(!parsed.success||parsed.data.lowAvailable>0&&!parsed.data.materialId)
      return reply.code(400).send({error:'invalid_inventory_report_query'});
    const data=parsed.data;
    try {
      return await issueTransaction(pool,request.headers.authorization,
        request.headers['x-device-proof'],data.deviceId,false,undefined,
        async(client,actor,level,epoch)=>{
          if(!level)issueFail(403,'warehouse_access_required');
          const now=Date.now();
          const result=await client.query(`SELECT s.id,s.material_id,s.manufacturer_lot,s.location_id,
            s.quality,s.on_hand,s.reserved,s.revision,s.expires_at,s.manufactured_on,
            s.disposition,m.base_unit,m.material_code,m.display_name,l.label AS location_label,
            inventory_package_released(s.organization_id,s.id) AS eligible
            FROM inventory_stocks s
            JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id
            JOIN inventory_locations l ON l.organization_id=s.organization_id AND l.id=s.location_id
            WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.id>$2)
              AND ($3::uuid IS NULL OR s.material_id=$3)
            ORDER BY s.id LIMIT $4`,
            [actor.organization_id,data.after??null,data.materialId??null,data.limit+1]);
          const page=result.rows.slice(0,data.limit);
          const items=page.map(row=>{
            const stock=inventoryStockFromRow(row);
            const available=stock.onHand-stock.reserved;
            const eligible=row.eligible===true;
            const expiry=stock.expiresAt?Date.parse(stock.expiresAt):null;
            const alerts:string[]=[];
            if(stock.quality==='quarantine')alerts.push('quarantine');
            else if(stock.quality==='blocked')alerts.push('blocked');
            if(expiry!==null){
              if(expiry<=now)alerts.push('expired');
              else if(expiry<=now+data.expiryDays*day)alerts.push('expiring');
            }
            if(stock.quality==='released'&&!eligible&&!(expiry!==null&&expiry<=now))
              alerts.push('restricted');
            if(stock.quality==='released'&&eligible&&available<=data.lowAvailable)
              alerts.push('low');
            return {stock:{...stock,available},materialCode:String(row.material_code),
              materialName:String(row.display_name),locationLabel:String(row.location_label),
              eligible,alerts};
          }).filter(row=>data.view==='all'||row.alerts.length>0);
          return {epoch,asOf:new Date(now).toISOString(),
            expiryDays:data.expiryDays,lowAvailable:data.lowAvailable,
            materialId:data.materialId??null,items,hasMore:result.rows.length>data.limit,
            nextAfter:result.rows.length>data.limit?page[page.length-1].id:null};
        });
    }catch(error){const found=issueHttpError(error);return reply.code(found.status).send(found.body);}
  });
}
