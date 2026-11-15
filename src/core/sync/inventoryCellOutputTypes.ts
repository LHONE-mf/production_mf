import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger,outcomeInstant} from './inventoryOutcomeTypes';
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

// Source attestations retain ISO offsets accepted by the server contract. ACK
// timestamps are server-generated and validated separately as canonical UTC.
const sourceDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const sourceInstant=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)&&sourceDate(value.slice(0,10))&&Number.isFinite(Date.parse(value));
const pick=<T extends object,K extends keyof T>(value:T,keys:K[]):Pick<T,K>=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) as Pick<T,K>;
/** Validate and allowlist untrusted source history. No serial expansion or QA inference. */
export function cellOutputSourceCopy(raw:unknown):CellOutputSource {
 const s=raw as CellOutputSource,f=s?.formation,l=s?.lineage,d=s?.declaration,r=s?.inputSerialRange;
 const label=(v:unknown,max=200):v is string=>typeof v==='string'&&!!v&&v===v.trim()&&v.length<=max;
 const roles=['worker','technologist','master','chief'];
 if(!s||s.version!==1||!f||!l||!d||!r||!f.mode||!f.measurementUnits||![s.identityId,s.formationRunId,l.assemblyRunId,l.assemblyOutputId,l.assemblyOperationId,l.fillingRunId,l.fillingReceiptId,l.formationInputId,f.workerId,d.recordedBy].every(v=>label(v))||!['cylindrical','prismatic'].includes(s.cellType)||!['dry-room','floor7-room5'].includes(l.fillingBox)||!roles.includes(f.recordedRole)||!roles.includes(d.recordedRole)||!label(d.evidence,1000)||!label(f.measurementBasis,1000)||f.equipmentRef!==undefined&&!label(f.equipmentRef,1000))throw Error('Invalid cell source attribution');
 if(![r.start,r.end,f.cellsScrap,f.cellsUnknown].every(v=>outcomeInteger(v))||![f.cellsIn,f.cellsOut,f.mode.cycles].every(v=>outcomeInteger(v,1))||r.end<r.start||!Number.isSafeInteger(r.end-r.start+1)||r.end-r.start+1!==f.cellsIn||!Number.isSafeInteger(f.cellsOut+f.cellsScrap+f.cellsUnknown)||f.cellsOut+f.cellsScrap+f.cellsUnknown!==f.cellsIn||r.prefix!==undefined&&(typeof r.prefix!=='string'||r.prefix!==r.prefix.trim()||r.prefix.length>80))throw Error('Invalid cell source conservation');
 if(!sourceInstant(f.recordedAt)||!sourceInstant(d.recordedAt)||Date.parse(d.recordedAt)<Date.parse(f.recordedAt)||!sourceDate(f.startDate)||!sourceDate(f.endDate)||f.endDate<f.startDate||d.recordedRole==='worker'&&(d.recordedBy!==f.workerId||f.recordedRole!=='worker'))throw Error('Invalid cell source observations');
 if(l.fillingBox==='dry-room'?l.walzingRunId!==undefined||l.formationInputId!==l.fillingRunId:!label(l.walzingRunId)||l.formationInputId!==l.walzingRunId)throw Error('Invalid cell source lineage');
 if(s.formationRunId===l.formationInputId||['current','voltage','capacity','efficiency','cycles'].some((key,i)=>f.measurementUnits[key as keyof typeof f.measurementUnits]!==['A','V','Ah','%','count'][i]))throw Error('Invalid cell source units');
 for(const [value,min,max] of [[f.mode.currentA,-Infinity,Infinity],[f.mode.voltageV,0,Infinity],[f.capacityCycle5Ah,0,Infinity],[f.coulombEfficiencyPct,0,100]] as const)if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max))throw Error('Invalid cell source measurement');
 if(f.capacityCycle5Ah!==undefined&&f.mode.cycles<5||!Array.isArray(s.ranges)||!s.ranges.length||s.ranges.length>1000)throw Error('Invalid explicit cell ranges');
 let total=0,previous=-1;for(const range of s.ranges){if(!range||![range.start,range.end].every(v=>outcomeInteger(v))||range.start<r.start||range.end>r.end||range.end<range.start||range.start<=previous)throw Error('Invalid explicit cell range');total+=range.end-range.start+1;previous=range.end;}
 if(!Number.isSafeInteger(total)||total!==f.cellsOut)throw Error('Invalid explicit cell count');
 return{version:1,identityId:s.identityId,formationRunId:s.formationRunId,cellType:s.cellType,lineage:pick(l,['assemblyRunId','assemblyOutputId','assemblyOperationId','fillingRunId','fillingReceiptId','fillingBox','walzingRunId','formationInputId']),inputSerialRange:pick(r,['start','end','prefix']),ranges:s.ranges.map(range=>({start:range.start,end:range.end})),formation:{...pick(f,['cellsIn','cellsOut','cellsScrap','cellsUnknown','workerId','recordedRole','recordedAt','startDate','endDate','capacityCycle5Ah','coulombEfficiencyPct','equipmentRef','measurementBasis']),mode:pick(f.mode,['cycles','currentA','voltageV']),measurementUnits:{current:'A',voltage:'V',capacity:'Ah',efficiency:'%',cycles:'count'}},declaration:pick(d,['recordedBy','recordedRole','recordedAt','evidence'])};
}
export function cellSubmissionCopy(raw:unknown):CellSubmission {
 const r=raw as CellSubmission;
 if(!r||![r.operationId,r.deviceId,r.productionBatchId,r.completionId,r.materialId,r.actorId].every(issueIdValid)||!outcomeInteger(r.stepNumber,1)||r.revision!==1||r.unit!=='pieces'||!issueTextValid(r.reason)||!issueTextValid(r.evidence)||!outcomeInstant(r.recordedAt))throw Error('Invalid cell submission');
 const source=cellOutputSourceCopy(r.source);if(r.quantity!==source.formation.cellsOut)throw Error('Invalid cell submission quantity');
 return{...pick(r,['operationId','deviceId','productionBatchId','completionId','materialId','stepNumber','reason','evidence','quantity','unit','revision','actorId','recordedAt']),source};
}
