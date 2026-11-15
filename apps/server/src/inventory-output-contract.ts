import {z} from 'zod';

const id=z.guid(),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const label=z.string().trim().min(1).max(120),text=z.string().trim().min(1).max(2000);
const bound=z.number().finite().min(0).optional();
const category=z.object({name:label,minMass:bound,maxMass:bound,minUm:bound,maxUm:bound}).strict();
const grade=z.object({categoryName:label,count}).strict();
const station=z.object({station:z.enum(['visual','thickness','mass']),inputCount:count,passedCount:count,rejectedCount:count,
 workerId:label,recordedAt:z.number().int().positive().max(8640000000000000),
 rejectionReasons:z.array(z.object({reason:label,count}).strict()).max(100).optional(),
 grades:z.array(grade).min(1).max(100).optional()}).strict();

// A deliberate authenticated attestation of completed manual station counts.
// This is neither an imported journal nor an equipment-verified measurement.
export const electrodeOutputSource=z.object({runId:label,cutRunId:label,specId:label,
 mode:z.enum(['pass-fail','grading']),inputCount:count.refine(n=>n>0),
 categories:z.array(category).min(1).max(100),stages:z.array(station).length(3),
}).strict().superRefine((source,ctx)=>{
 const reject=()=>ctx.addIssue({code:'custom',message:'invalid_completed_sorting_output'});
 const names=new Set(source.categories.map(c=>c.name));
 if(names.size!==source.categories.length)reject();
 for(const c of source.categories){
  if(c.minMass!==undefined&&c.maxMass!==undefined&&c.minMass>c.maxMass||
   c.minUm!==undefined&&c.maxUm!==undefined&&c.minUm>c.maxUm||
   source.mode==='grading'&&c.minMass===undefined&&c.maxMass===undefined)reject();
 }
 let incoming=source.inputCount;
 for(const [i,s] of source.stages.entries()){
  if(s.station!==['visual','thickness','mass'][i]||s.inputCount!==incoming||
   !Number.isSafeInteger(s.passedCount+s.rejectedCount)||s.passedCount+s.rejectedCount!==incoming)reject();
  if(s.rejectionReasons&&(new Set(s.rejectionReasons.map(r=>r.reason)).size!==s.rejectionReasons.length||
   s.rejectionReasons.reduce((n,r)=>n+r.count,0)!==s.rejectedCount))reject();
  if(i===2&&source.mode==='grading'){
   if(!s.grades||s.grades.length!==names.size||new Set(s.grades.map(g=>g.categoryName)).size!==names.size||
    s.grades.some(g=>!names.has(g.categoryName))||s.grades.reduce((n,g)=>n+g.count,0)!==s.passedCount)reject();
  }else if(s.grades!==undefined)reject();
  incoming=s.passedCount;
 }
 if(incoming===0)reject();
});

export const electrodeSubmission=z.object({operationId:id,deviceId:id,productionBatchId:id,
 stepNumber:z.number().int().positive().safe(),completionId:id,source:electrodeOutputSource,
 outputs:z.array(z.object({grade:label,materialId:id,quantity:count.refine(n=>n>0)}).strict()).min(1).max(100),
 reason:text,evidence:text,
}).strict().superRefine((data,ctx)=>{
 const mass=data.source.stages[2];
 if(!mass)return; // The source schema already rejects an incomplete station array.
 const expected=(data.source.mode==='grading'?mass.grades??[]:[{categoryName:'PASS',count:mass.passedCount}]).filter(g=>g.count>0);
 if(expected.length!==data.outputs.length||new Set(data.outputs.map(o=>o.grade)).size!==expected.length||
  data.outputs.some(o=>!expected.some(g=>g.categoryName===o.grade&&g.count===o.quantity)))
  ctx.addIssue({code:'custom',message:'output_grades_must_match_final_mass_counts'});
});
export const outputAcceptance=z.object({operationId:id,deviceId:id,submissionId:id,grade:label,
 expectedRevision:z.literal(1),stockId:id,locationId:id,quantity:count.refine(n=>n>0),reason:text,evidence:text,
 manufacturedOn:z.iso.date().refine(d=>d>='0001-01-01'&&d<'9999-12-31').optional(),
 expiresOn:z.iso.date().refine(d=>d>='0001-01-01'&&d<'9999-12-31').optional(),
}).strict().refine(d=>!d.manufacturedOn||!d.expiresOn||d.manufacturedOn<=d.expiresOn);
