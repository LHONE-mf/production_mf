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
