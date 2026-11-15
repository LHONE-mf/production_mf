import {z} from 'zod';
const id=z.guid(),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=count.refine(n=>n>0);
const label=z.string().min(1).max(200).refine(v=>v===v.trim()),evidence=z.string().min(1).max(1000).refine(v=>v===v.trim());
const role=z.enum(['worker','technologist','master','chief']),instant=z.iso.datetime({offset:true}),date=z.iso.date();
const range=z.object({start:count,end:count}).strict();
/** Authenticated manual attestation, not equipment verification or final QC.
 * The full original local identity remains on the producing device. */
export const cellOutputSource=z.object({version:z.literal(1),identityId:label,formationRunId:label,
 lineage:z.object({assemblyRunId:label,assemblyOutputId:label,assemblyOperationId:label,fillingRunId:label,fillingReceiptId:label,
  fillingBox:z.enum(['dry-room','floor7-room5']),walzingRunId:label.optional(),formationInputId:label}).strict(),
 cellType:z.enum(['cylindrical','prismatic']),inputSerialRange:range.extend({prefix:z.string().max(80).refine(v=>v===v.trim()).optional()}).strict(),
 ranges:z.array(range).min(1).max(1000),
 formation:z.object({cellsIn:positive,cellsOut:positive,cellsScrap:count,cellsUnknown:count,workerId:label,recordedRole:role,recordedAt:instant,
  startDate:date,endDate:date,mode:z.object({cycles:positive,currentA:z.number().finite().optional(),voltageV:z.number().finite().min(0).optional()}).strict(),
  capacityCycle5Ah:z.number().finite().min(0).optional(),coulombEfficiencyPct:z.number().finite().min(0).max(100).optional(),equipmentRef:evidence.optional(),measurementBasis:evidence,
  measurementUnits:z.object({current:z.literal('A'),voltage:z.literal('V'),capacity:z.literal('Ah'),efficiency:z.literal('%'),cycles:z.literal('count')}).strict()}).strict(),
 declaration:z.object({recordedBy:label,recordedRole:role,recordedAt:instant,evidence}).strict(),
}).strict().superRefine((s,ctx)=>{
 const reject=()=>ctx.addIssue({code:'custom',message:'explicit_completed_cell_source_required'}),f=s.formation,l=s.lineage,r=s.inputSerialRange;
 if(r.end<r.start||!Number.isSafeInteger(r.end-r.start+1)||r.end-r.start+1!==f.cellsIn||!Number.isSafeInteger(f.cellsOut+f.cellsScrap+f.cellsUnknown)||f.cellsOut+f.cellsScrap+f.cellsUnknown!==f.cellsIn||f.endDate<f.startDate||f.capacityCycle5Ah!==undefined&&f.mode.cycles<5||s.formationRunId===l.formationInputId)reject();
 if(l.fillingBox==='dry-room'?l.walzingRunId!==undefined||l.formationInputId!==l.fillingRunId:!l.walzingRunId||l.formationInputId!==l.walzingRunId)reject();
 if(s.declaration.recordedRole==='worker'&&(s.declaration.recordedBy!==f.workerId||f.recordedRole!=='worker')||Date.parse(s.declaration.recordedAt)<Date.parse(f.recordedAt))reject();
 let total=0,previous=-1;
 for(const range of s.ranges){if(range.start<r.start||range.end>r.end||range.end<range.start||range.start<=previous)reject();total+=range.end-range.start+1;previous=range.end;}
 if(!Number.isSafeInteger(total)||total!==f.cellsOut)reject();
});
export const cellSubmission=z.object({operationId:id,deviceId:id,productionBatchId:id,stepNumber:z.number().int().positive().safe(),completionId:id,materialId:id,
 source:cellOutputSource,reason:z.string().trim().min(1).max(2000),evidence:z.string().trim().min(1).max(2000)}).strict();
export type CellOutputSource=z.infer<typeof cellOutputSource>;
