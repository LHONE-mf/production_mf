import type {CoatingMixSnapshot} from '../../core/types';
import {hasSlurryHandover} from '../../core/manufacturing/slurryBatch';

const format=(n:number,decimals=3)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:decimals}).format(n);
export const formatCoatingPercent=(n:number)=>Number.isFinite(n)?format(n,3):'—';

/** Presentation only: never reclassify stored historical grams as kilograms. */
export function coatingMixMassDisplay(m:CoatingMixSnapshot):{label:string;value:string;warning?:string} {
 if(hasSlurryHandover(m)){
  const dryG=m.sourceBatch?.massBalance?.solidsActualG;
  if(typeof dryG!=='number'||!Number.isFinite(dryG)||dryG<0)
   return {label:'Расчёт СВ по навескам',value:'—',warning:'Исходная масса СВ в граммах отсутствует; требуется сверка передачи.'};
  const kg=dryG/1000;
  const mismatch=typeof m.batchKg!=='number'||!Number.isFinite(m.batchKg)||Math.abs(m.batchKg-kg)>1e-6;
  return {label:'Расчёт СВ по навескам',value:format(kg)+' кг',
   ...(mismatch?{warning:'Несовпадение массы СВ в пакете с исходными навесками. Используйте данные только после сверки; исходная запись не изменена.'}:{})};
 }
 return {label:'План СВ (исторический)',value:typeof m.batchKg==='number'&&Number.isFinite(m.batchKg)?format(m.batchKg)+' кг':'—'};
}
