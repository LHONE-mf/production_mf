import type {AssemblyOp} from '../types';

type Counts=Pick<AssemblyOp,'qtyIn'|'qtyOut'|'qtyScrap'>;
export const ASSEMBLY_COUNT_ERROR='Укажите целые количества: вход больше нуля, выход и брак неотрицательные. Пустое значение не считается нулём.';
/** Validates entered counts only; station units/conversions are not inferred. */
export function validAssemblyCounts(counts:Counts):boolean {
 return [counts.qtyIn,counts.qtyOut,counts.qtyScrap].every(n=>Number.isSafeInteger(n)&&n>=0)&&counts.qtyIn>0;
}
export function parseAssemblyCounts(input:string,output:string,scrap:string):Counts|null {
 if([input,output,scrap].some(s=>!s.trim()))return null;
 const counts={qtyIn:Number(input),qtyOut:Number(output),qtyScrap:Number(scrap)};
 return validAssemblyCounts(counts)?counts:null;
}
