import{inventoryOutbox,inventoryScopeKey,inventoryOfflineGenerationKey as generationKey,type InventoryScope}from'./inventoryOutbox';
import{material,location,inventoryLocationPath,type InventoryMaterial,type InventoryLocation,type WarehouseAccess}from'./inventoryCatalogClient';
const maximum=28800000,skew=120000;
export {beginInventoryOfflineView,invalidateInventoryOfflineViews} from './inventoryOutbox';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface InventoryOfflineView{
 localActorId:string;localSessionIssuedAt:number;generation:string;scope:InventoryScope;scopeKey:string;
 issuedAt:number;expiresAt:number;syncedAt:number;access:WarehouseAccess;materials:InventoryMaterial[];locations:InventoryLocation[];
}
export function validInventoryOfflineView(view:InventoryOfflineView,localActorId:string,login:number,now:number):boolean{
 try{
  if(!view||view.localActorId!==localActorId||view.localSessionIssuedAt!==login||!uuid.test(view.generation)||localStorage.getItem(generationKey)!==view.generation||view.scopeKey!==inventoryScopeKey(view.scope)||![view.issuedAt,view.expiresAt,view.syncedAt,login,now].every(Number.isSafeInteger)||view.expiresAt<=now||view.issuedAt>now+skew||view.syncedAt>now+skew||view.syncedAt<view.issuedAt-skew||view.expiresAt<=view.issuedAt||view.expiresAt>view.issuedAt+maximum||!localActorId||login>now||!Array.isArray(view.materials)||!Array.isArray(view.locations)||view.materials.length>10000||view.locations.length>10000||!view.materials.every(material)||!view.locations.every(location)||new Set(view.materials.map(m=>m.id)).size!==view.materials.length||new Set(view.locations.map(l=>l.id)).size!==view.locations.length)return false;
  for(const place of view.locations)inventoryLocationPath(view.locations,place.id);
  const access=view.access;
  return !!access&&['chief','manager','operator'].includes(access.level)&&access.canRecordReceipts===true&&access.canCorrectStock===(access.level!=='operator')&&access.canManageCatalog===(access.level!=='operator')&&access.correctionRoleEligible===(access.level!=='operator');
 }catch{return false;}
}
export async function cacheInventoryOfflineView(input:{scope:InventoryScope;access:WarehouseAccess;materials:InventoryMaterial[];locations:InventoryLocation[];localActorId:string;localSessionIssuedAt:number;localSessionExpiresAt:number;syncedAt:number;generation:string|null}){
 const grant=input.access.offlineView;if(!grant||!input.generation)return;
 if(grant.organizationId!==input.scope.organizationId||grant.actorId!==input.scope.actorId||grant.deviceId!==input.scope.deviceId)throw Error('Offline view identity mismatch');
 const issuedAt=Date.parse(grant.issuedAt),expiresAt=Date.parse(grant.expiresAt);
 if(!Number.isSafeInteger(input.localSessionExpiresAt)||expiresAt>issuedAt+maximum||expiresAt<=issuedAt)throw Error('Invalid offline view duration');
 const access={level:input.access.level,canRecordReceipts:input.access.canRecordReceipts,canManageCatalog:input.access.canManageCatalog,canCorrectStock:input.access.canCorrectStock,correctionRoleEligible:input.access.correctionRoleEligible};
 const view:InventoryOfflineView={localActorId:input.localActorId,localSessionIssuedAt:input.localSessionIssuedAt,generation:input.generation,scope:{serverUrl:input.scope.serverUrl,organizationId:input.scope.organizationId,actorId:input.scope.actorId,deviceId:input.scope.deviceId},scopeKey:inventoryScopeKey(input.scope),issuedAt,expiresAt:Math.min(expiresAt,input.localSessionExpiresAt),syncedAt:input.syncedAt,access,
 materials:input.materials.map(m=>({id:m.id,code:m.code,name:m.name,category:m.category,baseUnit:m.baseUnit})),locations:input.locations.map(l=>({id:l.id,parentId:l.parentId,label:l.label,kind:l.kind,active:l.active}))};
 if(!validInventoryOfflineView(view,input.localActorId,input.localSessionIssuedAt,Date.now()))throw Error('Offline warehouse view could not be validated');
 await inventoryOutbox.offlineViews.put(view);
}
export async function loadInventoryOfflineView(localActorId:string,login:number,now=Date.now()):Promise<InventoryOfflineView|null>{
 const view=await inventoryOutbox.offlineViews.get(localActorId);
 if(view&&view.localSessionIssuedAt===login&&(view.expiresAt<=now||view.issuedAt>now+skew)){try{localStorage.removeItem(generationKey);}catch{}}
 return view&&validInventoryOfflineView(view,localActorId,login,now)?view:null;
}
