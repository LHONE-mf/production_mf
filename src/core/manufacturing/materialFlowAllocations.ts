import {StageId} from '../types';
import type {InventoryMaterial} from '../sync/inventoryCatalogClient';
import type {FlowMaterial,CELL_FORMAT_PLANS} from './materialFlowBlueprint';
import {FLOW_MATERIAL_KINDS} from './materialFlowBlueprint';

export type FlowBaseUnit = InventoryMaterial['baseUnit'];
export type FlowCellFormat = typeof CELL_FORMAT_PLANS[number]['format'];
export interface FlowScope {readonly organizationId:string;readonly workshopId:string;readonly room:StageId}
export interface FlowSourceReference {
  readonly kind:'received-issue'|'production-output'|'room-wip';
  readonly id:string;readonly revision:number;readonly operationId:string;
}
/** Explicit catalogue/spec mapping, never inferred from a name or electrode shape. */
export interface FlowMaterialIdentity {
  readonly catalogueId:string;
  readonly specification:{readonly id:string;readonly revision:number};
  readonly variantId:string|null;readonly lotId:string;readonly kind:FlowMaterial;
  readonly polarity:'cathode'|'anode'|'not-applicable'|'unknown';
  readonly cellFormat:FlowCellFormat|null;
}
export interface FlowSource {
  readonly scope:FlowScope;readonly reference:FlowSourceReference;readonly material:FlowMaterialIdentity;
  readonly custody:{readonly locationId:string};
  readonly availability:'available'|'held'|'unknown';
  readonly quality:'unknown'|'released'|'hold'|'blocked'|'rejected';
  readonly remaining:{readonly quantity:number;readonly unit:FlowBaseUnit};
  /** Explicit canonical serial identities only; absent means bulk, never a guessed subset. */
  readonly serials?:readonly string[];
}
export interface FlowAllocation {
  readonly id:string;readonly source:FlowSourceReference;readonly destinationOperationId:string;
  readonly quantity:number;readonly unit:FlowBaseUnit;readonly serials?:readonly string[];
}

/** Unpersisted observation drafts; neither the actor fields nor this type authorize posting. */
export type MaterialFlowDraft = {
  readonly version:1;readonly operationId:string;readonly scope:FlowScope;
  readonly batchId:string;readonly taskId:string|null;readonly orderId:string|null;
  readonly actorId:string;readonly deviceId:string;readonly recordedAt:string;readonly evidence:string;
  readonly status:'draft';readonly warehouseEffect:'none';
} & (
  {readonly kind:'room_consumption_recorded'|'room_wip_allocated';readonly allocations:readonly FlowAllocation[]} |
  {readonly kind:'production_output_declared';readonly outputs:readonly {
    id:string;material:FlowMaterialIdentity;quantity:number;unit:FlowBaseUnit;parents:readonly FlowAllocation[];
  }[]} |
  {readonly kind:'direct_handoff_prepared';readonly destination:FlowScope;readonly allocations:readonly FlowAllocation[]} |
  {readonly kind:'direct_handoff_received';readonly preparedOperationId:string;readonly allocations:readonly FlowAllocation[]} |
  {readonly kind:'room_wip_buffered';readonly sources:readonly FlowSource[]}
);

const text=(value:string)=>typeof value==='string'&&!!value.trim()&&value.length<=200;
const integer=(value:number,min=0)=>Number.isSafeInteger(value)&&value>=min;
const key=(ref:FlowSourceReference)=>JSON.stringify([ref.kind,ref.id]);
const validReference=(ref:FlowSourceReference)=>!!ref&&['received-issue','production-output','room-wip'].includes(ref.kind)&&text(ref.id)&&integer(ref.revision,1)&&text(ref.operationId);
const validScope=(scope:FlowScope)=>!!scope&&text(scope.organizationId)&&text(scope.workshopId)&&Object.values(StageId).includes(scope.room);
const serialsValid=(serials:readonly string[])=>Array.isArray(serials)&&serials.every(text)&&new Set(serials).size===serials.length;

/**
 * Pure advisory projection over explicit, already resolved source snapshots.
 * No DB/network/stock effects, unit conversion, yield comparison, QA release,
 * reservation or cross-device exclusivity. Re-run under the eventual authority
 * transaction against current revisions before any actual allocation is committed.
 * This is an internal typed contract, not an untrusted packet/API parser.
 */
export function checkMaterialAllocations(scope:FlowScope,sources:readonly FlowSource[],allocations:readonly FlowAllocation[]):FlowSource[]{
  if(!validScope(scope))throw Error('Invalid material-flow scope');
  const balances=new Map<string,{source:FlowSource;quantity:number;serials:Set<string>|undefined}>();
  const allSerials=new Set<string>();
  for(const source of sources){
    const {reference,material,remaining}=source;
    if(!validScope(source.scope)||source.scope.organizationId!==scope.organizationId||source.scope.workshopId!==scope.workshopId||source.scope.room!==scope.room||
      !validReference(reference)||balances.has(key(reference))||!text(source.custody?.locationId)||
      !material||!Object.prototype.hasOwnProperty.call(FLOW_MATERIAL_KINDS,material.kind)||!text(material.catalogueId)||!text(material.lotId)||!text(material.specification?.id)||!integer(material.specification.revision,1)||
      !(material.variantId===null||text(material.variantId))||!['cathode','anode','not-applicable','unknown'].includes(material.polarity)||
      !(material.cellFormat===null||['cylindrical','prismatic','pouch'].includes(material.cellFormat))||
      !['available','held','unknown'].includes(source.availability)||!['unknown','released','hold','blocked','rejected'].includes(source.quality)||
      !remaining||!integer(remaining.quantity)||!['mg','ul','mm','pieces'].includes(remaining.unit))throw Error('Invalid material-flow source identity, scope or quantity');
    if(source.serials!==undefined){
      if(remaining.unit!=='pieces'||!serialsValid(source.serials)||source.serials.length!==remaining.quantity)throw Error('Exact source serials must match counted pieces');
      for(const serial of source.serials){
        if(allSerials.has(serial))throw Error('Serial has competing source custody');
        allSerials.add(serial);
      }
    }
    balances.set(key(reference),{source,quantity:remaining.quantity,serials:source.serials===undefined?undefined:new Set(source.serials)});
  }
  const ids=new Set<string>();
  for(const allocation of allocations){
    if(!text(allocation.id)||ids.has(allocation.id)||!text(allocation.destinationOperationId)||!validReference(allocation.source)||!integer(allocation.quantity,1))throw Error('Invalid or duplicate material allocation');
    ids.add(allocation.id);
    const balance=balances.get(key(allocation.source));
    if(!balance||balance.source.reference.revision!==allocation.source.revision||balance.source.reference.operationId!==allocation.source.operationId)throw Error('Missing or stale material source');
    if(balance.source.availability!=='available'||['hold','blocked','rejected'].includes(balance.source.quality))throw Error('Material source is unavailable or held');
    if(allocation.unit!==balance.source.remaining.unit||allocation.quantity>balance.quantity)throw Error('Material unit mismatch or over-allocation');
    if(balance.serials!==undefined){
      if(allocation.serials===undefined||!serialsValid(allocation.serials)||allocation.serials.length!==allocation.quantity||allocation.serials.some(serial=>!balance.serials!.has(serial)))throw Error('Explicit unspent serial subset required');
      for(const serial of allocation.serials)balance.serials.delete(serial);
    }else if(allocation.serials!==undefined)throw Error('Cannot invent serials for a bulk source');
    // Subtraction stays within the safe source bound, without an overflowing sum.
    balance.quantity-=allocation.quantity;
  }
  return [...balances.values()].map(({source,quantity,serials})=>({
    ...source,remaining:{...source.remaining,quantity},...(serials===undefined?{}:{serials:[...serials]}),
  }));
}
