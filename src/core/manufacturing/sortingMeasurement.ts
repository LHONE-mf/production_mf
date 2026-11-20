import type {SortCategory,SortingMode} from '../types';

/** One positive mass in grams per inspected electrode, in station entry order. */
function parseReadings(raw:string, expectedCount:number, unit:'массы'|'толщины'):number[] {
  if(!Number.isSafeInteger(expectedCount)||expectedCount<0||expectedCount>10000)
    throw Error('Проверьте количество электродов для индивидуальных измерений (не более 10000)');
  const lines=raw.trim()===''?[]:raw.trim().split(/\r?\n/);
  if(lines.length!==expectedCount)
    throw Error('Количество измерений '+unit+' должно точно совпадать со входом станции');
  return lines.map((line,index)=>{
    const value=line.trim();
    if(!/^\d+(?:[.,]\d+)?$/.test(value))
      throw Error('Некорректное измерение '+unit+' электрода №'+(index+1));
    const measurement=Number(value.replace(',','.'));
    if(!Number.isFinite(measurement)||measurement<=0)
      throw Error('Значение '+unit+' электрода №'+(index+1)+' должно быть положительным');
    return measurement;
  });
}

export function parseMassReadings(raw:string, expectedCount:number):number[] {
  return parseReadings(raw,expectedCount,'массы');
}

export function parseThicknessReadings(raw:string, expectedCount:number):number[] {
  return parseReadings(raw,expectedCount,'толщины');
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


/** Thickness is pass/fail, regardless of the final mass grading mode. */
export function summarizeThicknessReadings(
  readings:readonly number[],categories:readonly SortCategory[],
):{passedCount:number;rejectedCount:number} {
  if(!Array.isArray(readings)||readings.length>10000||!Array.isArray(categories)||!categories.length)
    throw Error('Некорректный набор измерений толщины');
  if(readings.length>0&&!categories.some(c=>c.minUm!==undefined||c.maxUm!==undefined))
    throw Error('В КД отсутствуют допуски толщины: автоматическая оценка невозможна');
  let passedCount=0;
  for(const [index,value] of readings.entries()){
    if(typeof value!=='number'||!Number.isFinite(value)||value<=0)
      throw Error('Некорректная толщина электрода №'+(index+1));
    if(categories.some(c=>(c.minUm!==undefined||c.maxUm!==undefined)&&
      (c.minUm===undefined||value>=c.minUm)&&
      (c.maxUm===undefined||value<=c.maxUm)))passedCount++;
  }
  return {passedCount,rejectedCount:readings.length-passedCount};
}
