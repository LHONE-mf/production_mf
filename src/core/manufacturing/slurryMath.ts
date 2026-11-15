import type {MixComponent,MixRecipeLine} from '../types';

export const SLURRY_BASIS='dry-solids-share-and-liquid-per-dry' as const;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
export function parseSlurryNumber(raw:string,required=false):number|undefined {
 const value=raw.trim().replace(',','.');
 if(!value){if(required)throw new Error('Введите фактические массы явно; пустое значение неизвестно, а не ноль');return undefined;}
 if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!finite(Number(value)))throw new Error('Введите конечное неотрицательное число в указанных единицах');
 return Number(value);
}
export function validateSlurryComponent(component:MixComponent):void {
 if(!component||typeof component.id!=='string'||!component.id.trim()||typeof component.name!=='string'||!component.name.trim()||!['active','binder','conductive','solvent','additive'].includes(component.kind)||!finite(component.updatedAt)||component.updatedAt<0)throw new Error('Материал должен иметь ID, название, тип и версию');
 if(component.solidsMassFraction!==undefined&&(!finite(component.solidsMassFraction)||component.solidsMassFraction<0||component.solidsMassFraction>1))throw new Error('Массовая доля СВ компонента должна быть от 0 до 1; неизвестное оставьте пустым');
 for(const key of ['densityTrue','densitySettled','viscosity','d50','capacity','ssa'] as const){const value=component[key];if(value!==undefined&&(!finite(value)||value<0||['densityTrue','densitySettled','viscosity','d50'].includes(key)&&value===0))throw new Error('Введённые свойства материала должны быть конечными в указанных единицах; плотности, вязкость и D50 положительны');}
}
export function calculateSlurryPlan(lines:MixRecipeLine[],components:MixComponent[],targetDryKg:number,basis:typeof SLURRY_BASIS){
 if(basis!==SLURRY_BASIS||!finite(targetDryKg)||targetDryKg<=0||!finite(targetDryKg*1000)||!Array.isArray(lines)||!lines.length)throw new Error('Укажите базу процентов и положительную плановую массу СВ, кг');
 const map=new Map(components.map(c=>[c.id,c]));const ids=new Set<string>();let dryPct=0;
 const rows=lines.map(line=>{
  const component=map.get(line?.componentId);
  if(!component||ids.has(line.componentId)||!finite(line.pct)||line.pct<0)throw new Error('Материалы должны быть известны и уникальны; проценты конечны и неотрицательны');
  validateSlurryComponent(component);ids.add(component.id);
  const fraction=component.solidsMassFraction;
  if(fraction===undefined)throw new Error(`Неизвестно содержание СВ материала «${component.name}»; тип материала не заменяет состав`);
  const isSolvent=fraction===0;if(!isSolvent)dryPct+=line.pct;
  const grams=targetDryKg*1000*line.pct/100/(isSolvent?1:fraction);
  if(!finite(grams))throw new Error('Плановая масса выходит за допустимый числовой диапазон');
  return {componentId:component.id,name:component.name,kind:component.kind,pct:line.pct,isSolvent,solidsMassFraction:fraction,grams};
 });
 if(Math.abs(dryPct-100)>1e-8)throw new Error('Доли компонентов по сухому вкладу должны составлять 100 %; жидкие добавки заданы отдельно в % от массы СВ. Автонормирование не применяется');
 const dryTotalG=targetDryKg*1000,allTotalG=rows.reduce((sum,row)=>sum+row.grams,0);
 if(!finite(allTotalG)||allTotalG<=0)throw new Error('Суммарная плановая масса недопустима');
 return {rows,dryTotalG,wetTotalG:allTotalG-dryTotalG,allTotalG,solidsPct:dryTotalG/allTotalG*100};
}
export function slurryMassBalance(weights:Array<{componentId:string;actualG?:number}>,components:MixComponent[]){
 const map=new Map(components.map(c=>[c.id,c]));let knownMassG=0,missingCount=0,solids=0,compositionKnown=true;
 const ids=new Set<string>();
 for(const row of weights){
  if(!row||ids.has(row.componentId)||!map.has(row.componentId))throw new Error('Для массового расчёта нужны уникальные известные материалы');ids.add(row.componentId);
  if(row.actualG===undefined){missingCount++;continue;}
  if(!finite(row.actualG)||row.actualG<0)throw new Error('Фактическая масса должна быть конечной и неотрицательной, г');
  knownMassG+=row.actualG;const fraction=map.get(row.componentId)!.solidsMassFraction;
  if(fraction===undefined||!finite(fraction)||fraction<0||fraction>1)compositionKnown=false;else solids+=row.actualG*fraction;
 }
 if(!finite(knownMassG)||!finite(solids))throw new Error('Сумма масс выходит за допустимый диапазон');
 const complete=weights.length>0&&missingCount===0;
 const totalActualG=complete?knownMassG:undefined,solidsActualG=complete&&compositionKnown?solids:undefined;
 return {knownMassG,missingCount,totalActualG,solidsActualG,liquidActualG:solidsActualG===undefined?undefined:knownMassG-solidsActualG,
  solidsPctMass:solidsActualG!==undefined&&knownMassG>0?solidsActualG/knownMassG*100:undefined};
}
