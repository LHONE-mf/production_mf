import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger} from './inventoryOutcomeTypes';
import {validateFormationSerialIdentity,type FormationSerialIdentity,type ProcessedSerialRange} from '../manufacturing/formationSerialIdentity';
import type {UserRole,SerialRange,FormationRun} from '../types';
export interface CellOutputSource {
 version:1;identityId:string;formationRunId:string;
 lineage:{assemblyRunId:string;assemblyOutputId:string;assemblyOperationId:string;fillingRunId:string;fillingReceiptId:string;fillingBox:'dry-room'|'floor7-room5';walzingRunId?:string;formationInputId:string};
 cellType:'cylindrical'|'prismatic';inputSerialRange:SerialRange;ranges:ProcessedSerialRange[];
 formation:{cellsIn:number;cellsOut:number;cellsScrap:number;cellsUnknown:number;workerId:string;recordedRole:UserRole;recordedAt:string;startDate:string;endDate:string;mode:FormationRun['mode'];capacityCycle5Ah?:number;coulombEfficiencyPct?:number;equipmentRef?:string;measurementBasis:string;measurementUnits:NonNullable<FormationRun['measurementUnits']>};
 declaration:{recordedBy:string;recordedRole:UserRole;recordedAt:string;evidence:string};
}
/** Allowlisted network attestation. The full immutable local record stays local;
 * this does not create a proposal, send a request, infer QA or assign serials. */
export function cellSourceFromIdentity(identity:FormationSerialIdentity):CellOutputSource {
 validateFormationSerialIdentity(identity);
 const run=identity.source,input=run.inputSnapshot!,fill=input.sourceFill??input.sourceWalz!.inputSnapshot!.sourceFill!,assembly=fill.sourceReceipt!.sourceAssembly!,output=assembly.cellOutput!;
 if(!run.endDate)throw Error('Для предложения нужен явно законченный результат формирования; источник не заменён');
 return{version:1,identityId:identity.id,formationRunId:run.id,lineage:{assemblyRunId:assembly.id,assemblyOutputId:output.id,assemblyOperationId:output.operationId,fillingRunId:fill.id,fillingReceiptId:fill.sourceReceipt!.receipt!.id,fillingBox:fill.box,formationInputId:input.id,...(input.sourceWalz?{walzingRunId:input.sourceWalz.id}:{})},cellType:output.cellType as 'cylindrical'|'prismatic',inputSerialRange:{start:run.serialRange!.start,end:run.serialRange!.end,...(run.serialRange!.prefix!==undefined?{prefix:run.serialRange!.prefix}:{})},ranges:identity.ranges.map(r=>({...r})),
  formation:{cellsIn:run.cellsIn,cellsOut:run.cellsOut,cellsScrap:run.cellsScrap,cellsUnknown:run.cellsUnknown!,workerId:run.workerId,recordedRole:run.recordedRole!,recordedAt:run.createdAt,startDate:run.startDate,endDate:run.endDate,mode:{cycles:run.mode.cycles,...(run.mode.currentA!==undefined?{currentA:run.mode.currentA}:{}),...(run.mode.voltageV!==undefined?{voltageV:run.mode.voltageV}:{})},...(run.capacityCycle5Ah!==undefined?{capacityCycle5Ah:run.capacityCycle5Ah}:{}),...(run.coulombEfficiencyPct!==undefined?{coulombEfficiencyPct:run.coulombEfficiencyPct}:{}),...(run.equipmentRef?{equipmentRef:run.equipmentRef}:{}),measurementBasis:run.measurementBasis!,measurementUnits:{current:'A',voltage:'V',capacity:'Ah',efficiency:'%',cycles:'count'}},
  declaration:{recordedBy:identity.recordedBy,recordedRole:identity.recordedRole,recordedAt:identity.recordedAt,evidence:identity.evidence}};
}

export interface CellSubmissionRequest {
 operationId:string;deviceId:string;productionBatchId:string;stepNumber:number;completionId:string;materialId:string;
 source:CellOutputSource;reason:string;evidence:string;
}
export type CellSubmissionInput=Omit<CellSubmissionRequest,'source'>;
export interface CellSubmission extends CellSubmissionRequest {quantity:number;unit:'pieces';revision:1;actorId:string;recordedAt:string}
export function cellSubmissionFromIdentity(identity:FormationSerialIdentity,input:CellSubmissionInput):CellSubmissionRequest {
 if(!input||![input.operationId,input.deviceId,input.productionBatchId,input.completionId,input.materialId].every(issueIdValid)||!outcomeInteger(input.stepNumber,1)||!issueTextValid(input.reason)||!issueTextValid(input.evidence))throw Error('Invalid cell submission identity or evidence');
 return{operationId:input.operationId,deviceId:input.deviceId,productionBatchId:input.productionBatchId,stepNumber:input.stepNumber,completionId:input.completionId,materialId:input.materialId,source:cellSourceFromIdentity(identity),reason:input.reason.trim(),evidence:input.evidence.trim()};
}
