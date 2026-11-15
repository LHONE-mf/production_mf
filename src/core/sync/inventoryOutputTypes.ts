import type {SortRun,SortCategory,SortingStationResult} from '../types';
import {validateSortPartition} from '../manufacturing/sortingAllocation';
import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger} from './inventoryOutcomeTypes';

export interface ElectrodeOutputSource {
 runId:string;cutRunId:string;specId:string;mode:'pass-fail'|'grading';inputCount:number;
 categories:Pick<SortCategory,'name'|'minMass'|'maxMass'|'minUm'|'maxUm'>[];
 stages:SortingStationResult[];
}
export interface ElectrodeOutputLine {grade:string;materialId:string;quantity:number}
export interface ElectrodeSubmissionRequest {
 operationId:string;deviceId:string;productionBatchId:string;stepNumber:number;completionId:string;
 source:ElectrodeOutputSource;outputs:ElectrodeOutputLine[];reason:string;evidence:string;
}
export interface ElectrodeSubmission extends ElectrodeSubmissionRequest {
 revision:1;actorId:string;recordedAt:string;
}
export type ElectrodeSubmissionInput=Omit<ElectrodeSubmissionRequest,'source'>;
const label=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=120;

export function sourceFromSortRun(run:SortRun):ElectrodeOutputSource {
 validateSortPartition(run);
 const w=run.sortingWorkflow;
 if(!w||w.finalizedSortRunId!==run.id||w.stages.length!==3)throw Error('Нужен сохранённый итог всех трёх станций сортировки');
 return outputSourceCopy({runId:run.id,cutRunId:w.cutRunId,specId:w.specSnapshot.id,mode:w.mode,inputCount:w.cutRunSnapshot.goodCount,categories:w.specSnapshot.categories,stages:w.stages});
}
export function outputSourceCopy(source:ElectrodeOutputSource):ElectrodeOutputSource {
 validateOutputSource(source);
 return{runId:source.runId,cutRunId:source.cutRunId,specId:source.specId,mode:source.mode,inputCount:source.inputCount,
  categories:source.categories.map(c=>({name:c.name,...Object.fromEntries(['minMass','maxMass','minUm','maxUm'].filter(k=>c[k as keyof typeof c]!==undefined).map(k=>[k,c[k as keyof typeof c]]))})),
  stages:source.stages.map(s=>({station:s.station,inputCount:s.inputCount,passedCount:s.passedCount,rejectedCount:s.rejectedCount,workerId:s.workerId,recordedAt:s.recordedAt,
   ...(s.rejectionReasons?{rejectionReasons:s.rejectionReasons.map(r=>({reason:r.reason,count:r.count}))}:{}),...(s.grades?{grades:s.grades.map(g=>({categoryName:g.categoryName,count:g.count}))}:{})}))};
}

/** Validate the bounded server snapshot independently of local journal content. */
export function validateOutputSource(raw:unknown):asserts raw is ElectrodeOutputSource {
 const s=raw as ElectrodeOutputSource;
 if(!s||![s.runId,s.cutRunId,s.specId].every(label)||!['grading','pass-fail'].includes(s.mode)||!outcomeInteger(s.inputCount,1)||
  !Array.isArray(s.categories)||!s.categories.length||s.categories.length>100||!Array.isArray(s.stages)||s.stages.length!==3)throw Error('Invalid finished source');
 const names=new Set<string>();
 for(const c of s.categories){if(!c||!label(c.name)||names.has(c.name))throw Error('Invalid finished specification');names.add(c.name);
  for(const v of [c.minMass,c.maxMass,c.minUm,c.maxUm])if(v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<0))throw Error('Invalid specification bound');
  if(c.minMass!==undefined&&c.maxMass!==undefined&&c.minMass>c.maxMass||c.minUm!==undefined&&c.maxUm!==undefined&&c.minUm>c.maxUm||s.mode==='grading'&&c.minMass===undefined&&c.maxMass===undefined)throw Error('Invalid specification bounds');}
 let input=s.inputCount;
 for(const [i,r] of s.stages.entries()){
  if(!r||r.station!==['visual','thickness','mass'][i]||!label(r.workerId)||!outcomeInteger(r.recordedAt,1,8640000000000000)||
   ![r.inputCount,r.passedCount,r.rejectedCount].every(v=>outcomeInteger(v))||r.inputCount!==input||!Number.isSafeInteger(r.passedCount+r.rejectedCount)||r.passedCount+r.rejectedCount!==input)throw Error('Invalid station conservation');
  if(r.rejectionReasons&&(!Array.isArray(r.rejectionReasons)||r.rejectionReasons.length>100||new Set(r.rejectionReasons.map(v=>v.reason)).size!==r.rejectionReasons.length||r.rejectionReasons.some(v=>!label(v.reason)||!outcomeInteger(v.count))||r.rejectionReasons.reduce((n,v)=>n+v.count,0)!==r.rejectedCount))throw Error('Invalid rejection evidence');
  if(i===2&&s.mode==='grading'){
   if(!Array.isArray(r.grades)||r.grades.length!==names.size||new Set(r.grades.map(g=>g.categoryName)).size!==names.size||r.grades.some(g=>!names.has(g.categoryName)||!outcomeInteger(g.count))||r.grades.reduce((n,g)=>n+g.count,0)!==r.passedCount)throw Error('Invalid final mass grades');
  }else if(r.grades!==undefined)throw Error('Only final Mass may grade');
  input=r.passedCount;
 }
 if(!input)throw Error('Empty finished output');
}
export function finishedBuckets(source:ElectrodeOutputSource){validateOutputSource(source);const mass=source.stages[2];return(source.mode==='grading'?mass.grades!:[{categoryName:'PASS',count:mass.passedCount}]).filter(g=>g.count>0);}
export function submissionFromSortRun(run:SortRun,input:ElectrodeSubmissionInput):ElectrodeSubmissionRequest {
 if(!input||![input.operationId,input.deviceId,input.productionBatchId,input.completionId].every(issueIdValid)||!outcomeInteger(input.stepNumber,1)||!issueTextValid(input.reason)||!issueTextValid(input.evidence))throw Error('Invalid original output identity/evidence');
 const source=sourceFromSortRun(run),expected=finishedBuckets(source);
 if(!Array.isArray(input.outputs)||input.outputs.length!==expected.length||new Set(input.outputs.map(o=>o.grade)).size!==expected.length||input.outputs.some(o=>!issueIdValid(o.materialId)||!expected.some(g=>g.categoryName===o.grade&&g.count===o.quantity)))throw Error('Каждый фактический сорт должен сохранить полное количество и материал');
 return{operationId:input.operationId,deviceId:input.deviceId,productionBatchId:input.productionBatchId,stepNumber:input.stepNumber,completionId:input.completionId,source,outputs:input.outputs.map(o=>({grade:o.grade,materialId:o.materialId,quantity:o.quantity})),reason:input.reason.trim(),evidence:input.evidence.trim()};
}
export function sameOutput(a:unknown,b:unknown):boolean {
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
 return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
