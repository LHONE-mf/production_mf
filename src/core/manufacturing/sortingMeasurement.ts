import type {SortCategory,SortingMode} from '../types';

/** One positive mass in grams per inspected electrode, in station entry order. */
export function parseMassReadings(raw:string, expectedCount:number):number[] {
  if(!Number.isSafeInteger(expectedCount)||expectedCount<0||expectedCount>10000)
    throw Error('Проверьте количество электродов для индивидуальных измерений (не более 10000)');
  const lines=raw.trim()===''?[]:raw.trim().split(/\r?\n/);
  if(lines.length!==expectedCount)
    throw Error('Количество измерений массы должно точно совпадать со входом станции');
  return lines.map((line,index)=>{
    const value=line.trim();
    if(!/^\d+(?:[.,]\d+)?$/.test(value))
      throw Error('Некорректная масса электрода №'+(index+1));
    const mass=Number(value.replace(',','.'));
    if(!Number.isFinite(mass)||mass<=0)
      throw Error('Масса электрода №'+(index+1)+' должна быть положительной');
    return mass;
  });
}

/** Classification follows the frozen mass ranges; overlapping grades are not guessed. */
export function summarizeMassReadings(
  readings:readonly number[],categories:readonly SortCategory[],mode:SortingMode,
):{passedCount:number;rejectedCount:number;grades:{categoryName:string;count:number}[]} {
  if(!Array.isArray(readings)||readings.length>10000||!Array.isArray(categories)||
     !categories.length||!['grading','pass-fail'].includes(mode))
    throw Error('Некорректный набор индивидуальных измерений');
  const grades=categories.map(c=>({categoryName:c.name,count:0}));
  let passedCount=0;
  for(const [index,mass] of readings.entries()){
    if(typeof mass!=='number'||!Number.isFinite(mass)||mass<=0)
      throw Error('Некорректная измеренная масса электрода №'+(index+1));
    const matching=categories.map((c,i)=>({c,i})).filter(({c})=>
      (c.minMass!==undefined||c.maxMass!==undefined)&&
      (c.minMass===undefined||mass>=c.minMass)&&
      (c.maxMass===undefined||mass<=c.maxMass));
    if(matching.length>1&&mode==='grading')
      throw Error('Измеренная масса №'+(index+1)+' попадает в несколько сортов КД; исправьте неоднозначные диапазоны');
    if(matching.length>0){
      passedCount++;
      if(mode==='grading')grades[matching[0].i].count++;
    }
  }
  if(readings.length>0&&!categories.some(c=>c.minMass!==undefined||c.maxMass!==undefined))
    throw Error('В КД отсутствуют массовые диапазоны: автоматическая оценка невозможна');
  return {passedCount,rejectedCount:readings.length-passedCount,grades};
}
