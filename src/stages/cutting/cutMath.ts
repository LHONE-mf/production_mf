import type { CutRun, CuttingIncoming, CuttingGeometry, CuttingYield, ElectrodeShape } from '../../core/types';

const positive=(value:number|undefined):value is number=>value!==undefined&&Number.isFinite(value)&&value>0;

/** Conservative rectangular layout, one kerf allowance per piece pitch.
 * Physical usable web length is entered in m, dimensions/kerf in mm.
 * Coating A/B coverage never participates. No edge/tab salvage or QA claim. */
export function estimateCuttingYield(shape:ElectrodeShape,input:CuttingGeometry):CuttingYield|null {
  if(!positive(input.physicalLengthM)||!positive(input.electrodeLengthMm)||
    !Number.isFinite(input.kerfMm)||input.kerfMm<0)return null;
  if(input.electrodeWidthMm!==undefined&&!positive(input.electrodeWidthMm)||
    input.usableWebWidthMm!==undefined&&!positive(input.usableWebWidthMm))return null;
  if(shape==='prismatic'&&(!positive(input.electrodeWidthMm)||!positive(input.usableWebWidthMm)))return null;
  const pitch=input.electrodeLengthMm+input.kerfMm;
  if(!Number.isFinite(pitch)||shape==='prismatic'&&!Number.isFinite(input.electrodeWidthMm!+input.kerfMm))return null;
  const rows=Math.floor(input.physicalLengthM*1000/pitch);
  const columns=shape==='strip'?1:Math.floor(input.usableWebWidthMm!/(input.electrodeWidthMm!+input.kerfMm));
  const expected=rows*columns;
  const perMeter=columns*1000/pitch;
  if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(columns)||!Number.isSafeInteger(expected)||
    !Number.isFinite(perMeter))return null;
  return {...input,rows,columns,expected,perMeter};
}

/** Imported legacy records may omit estimates; malformed new metadata is never rendered as a result. */
export function readCuttingYield(shape:ElectrodeShape,value:unknown):CuttingYield|null {
  if(!value||typeof value!=='object')return null;
  const saved=value as CuttingYield;
  const calculated=estimateCuttingYield(shape,saved);
  if(!calculated||saved.expected!==calculated.expected||saved.rows!==calculated.rows||
    saved.columns!==calculated.columns||saved.perMeter!==calculated.perMeter)return null;
  return {...calculated,electrodeLengthSource:saved.electrodeLengthSource==='entered'?'entered':
    saved.electrodeLengthSource==='incoming_spec'?'incoming_spec':undefined};
}

export interface CuttingEntry {
  goodCount?:number;
  defectCount?:number;
  breaks?:number;
  electrodeLengthMm?:number;
  geometry?:Omit<CuttingGeometry,'electrodeLengthMm'>;
  defects?:string;
  notes?:string;
}
function count(value:number|undefined,label:string):asserts value is number {
  if(value===undefined||!Number.isSafeInteger(value)||value<0)
    throw new Error(label+': введите целое неотрицательное количество');
}

export function prepareCuttingRun(incoming:CuttingIncoming,input:CuttingEntry,workerId:string,id:string,now=Date.now()):CutRun {
  if(!workerId)throw new Error('Войдите в профиль');
  count(input.goodCount,'Годные электроды');count(input.defectCount,'Электроды с дефектами');
  if(!Number.isSafeInteger(input.goodCount+input.defectCount)||input.goodCount+input.defectCount===0)
    throw new Error('Укажите ненулевой итог нарезки в пределах точного целого количества');
  if(input.breaks!==undefined)count(input.breaks,'Обрывы ленты');
  if(input.electrodeLengthMm!==undefined&&!positive(input.electrodeLengthMm))throw new Error('Фактическая длина электрода должна быть больше нуля');
  const length=input.electrodeLengthMm??incoming.electrodeLengthMm;
  const calculation=input.geometry?estimateCuttingYield(incoming.electrodeType,
    {...input.geometry,electrodeLengthMm:length??NaN}):undefined;
  if(calculation===null)throw new Error('Для оценки укажите измеренную длину полотна, размер электрода и ширину реза; для пластин — обе ширины. Или очистите поля расчёта.');
  return {id,incomingId:incoming.id,electrodeType:incoming.electrodeType,coatingType:incoming.coatingType,
    electrodeLengthMm:input.electrodeLengthMm,goodCount:input.goodCount,defectCount:input.defectCount,
    breaks:input.breaks,defects:input.defects?.trim()||undefined,notes:input.notes?.trim()||undefined,
    yieldCalculation:calculation?{...calculation,electrodeLengthSource:input.electrodeLengthMm===undefined?'incoming_spec':'entered'}:undefined,workerId,createdAt:now,updatedAt:now};
}
