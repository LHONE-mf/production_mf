import {issueIdValid} from './inventoryIssueTypes';
export type InventoryLabelKind='container'|'location'|'batch';
/** An identifier only: never contains origin credentials, grants or an action. */
export function inventoryLabel(organizationId:string,kind:InventoryLabelKind,id:string){if(!issueIdValid(organizationId)||!issueIdValid(id)||!['container','location','batch'].includes(kind))throw Error('Invalid inventory label identity');return`production-mf:v1:${organizationId}:${kind}:${id}`;}
export function parseInventoryLabel(value:string,organizationId:string){
 if(typeof value!=='string'||value.length>150||!issueIdValid(organizationId))throw Error('Некорректная складская метка');
 const parts=value.trim().split(':');if(parts.length!==5||parts[0]!=='production-mf'||parts[1]!=='v1'||parts[2]!==organizationId||!['container','location','batch'].includes(parts[3])||!issueIdValid(parts[4]))throw Error('Метка другой организации или неизвестного формата');return{kind:parts[3]as InventoryLabelKind,id:parts[4]};
}
