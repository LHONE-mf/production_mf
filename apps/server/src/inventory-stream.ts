import type{PoolClient}from'pg';
import {tokenHash} from './auth.js';
export async function inventoryStream(client:PoolClient,organizationId:string){
 await client.query('INSERT INTO inventory_streams(organization_id) VALUES($1) ON CONFLICT DO NOTHING',[organizationId]);
 return(await client.query('SELECT epoch,posting_enabled FROM inventory_streams WHERE organization_id=$1',[organizationId])).rows[0] as {epoch:string;posting_enabled:boolean};
}
/** Caller must hold the same organization inventory-sequence advisory lock as all stock writers. */
export async function inventoryWriteFence(client:PoolClient,organizationId:string,epoch:unknown):Promise<string|null>{
 const stream=await inventoryStream(client,organizationId);
 if(typeof epoch!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(epoch))return'inventory_epoch_required';
 if(stream.epoch!==epoch.toLowerCase())return'inventory_epoch_changed';
 if(!stream.posting_enabled)return'inventory_posting_suspended';
 return null;
}

/** Authorization must still hold after waiting for the inventory/restore lock. */
export async function currentInventoryWriter(client:PoolClient,organizationId:string,actorId:string,deviceId:string,authorization:string,proof:unknown,required:'operator'|'manager'){
 if(typeof proof!=='string')return null;
 const user=await client.query(`SELECT u.id,u.organization_id,u.role FROM device_proof_grants g
  JOIN devices d ON d.id=g.device_id AND d.organization_id=g.organization_id AND d.user_id=g.user_id
  JOIN sessions s ON s.token_hash=g.session_token_hash AND s.organization_id=g.organization_id AND s.user_id=g.user_id
  JOIN users u ON u.id=g.user_id AND u.organization_id=g.organization_id
  WHERE g.token_hash=$1 AND g.organization_id=$2 AND g.user_id=$3 AND g.device_id=$4
   AND g.session_token_hash=$5 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
   AND d.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.active
  FOR SHARE OF g,d,s,u`,[tokenHash(proof),organizationId,actorId,deviceId,tokenHash(authorization.slice(7))]);
 const actor=user.rows[0];if(!actor)return null;
 if(actor.role==='chief')return actor;
 const grant=await client.query('SELECT level FROM inventory_access WHERE organization_id=$1 AND user_id=$2 AND active FOR SHARE',[organizationId,actorId]);
 return grant.rows[0]?.level==='manager'||required==='operator'&&grant.rows[0]?.level==='operator'?actor:null;
}
