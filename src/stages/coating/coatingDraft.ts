import type {CoatRun,CoatingMixSnapshot} from '../../core/types';
import {parseSlurryNumber} from '../../core/manufacturing/slurryMath';
import {hasSlurryHandover,validateSlurryHandover} from '../../core/manufacturing/slurryBatch';
import {prepareRecordedCoatingRun,validateRecordedCoatingRun,type CoatingEntry} from './coatingJournal';
export interface CoatingForm {
 version:1;mixSnapshot:CoatingMixSnapshot|null;attempt:CoatRun|null;
 foilType:string;targetDry:string;widthCm:string;webSpeed:string;supplyCm3Rev:string;gapSetpoint:string;measuredDry:string;
 mode:''|'continuous'|'intermittent';gapWidth:string;gapPitch:string;segs:string[];sideB:string;ovens:string[];defects:string;notes:string;
}
export const emptyCoatingForm=():CoatingForm=>({version:1,mixSnapshot:null,attempt:null,foilType:'',targetDry:'',widthCm:'',webSpeed:'',supplyCm3Rev:'',gapSetpoint:'',measuredDry:'',mode:'',gapWidth:'',gapPitch:'',segs:[''],sideB:'',ovens:Array(6).fill(''),defects:'',notes:''});
export function coatingFormEntry(form:CoatingForm):CoatingEntry {
 if(!form.mode)throw Error('Выберите режим нанесения явно');
 const num=parseSlurryNumber;
 return {foilType:form.foilType,mixSnapshot:form.mixSnapshot??undefined,targetDryMgm2:num(form.targetDry),coatingWidthCm:num(form.widthCm),webSpeedMpm:num(form.webSpeed),pumpDeliveryCm3Rev:num(form.supplyCm3Rev),headGapUm:num(form.gapSetpoint),measuredDryThicknessUm:num(form.measuredDry),mode:form.mode,gapWidthMm:form.mode==='intermittent'?num(form.gapWidth):undefined,gapPitchMm:form.mode==='intermittent'?num(form.gapPitch):undefined,segLengthsM:form.segs.map(raw=>num(raw)??NaN),sideBLengthM:num(form.sideB),ovenTempsC:form.ovens.every(raw=>!raw.trim())?[]:form.ovens.map(raw=>num(raw)??NaN),defects:form.defects,notes:form.notes};
}
export function parseCoatingForm(value:unknown,actorId:string):CoatingForm {
 const form=value as CoatingForm;
 const strings=['foilType','targetDry','widthCm','webSpeed','supplyCm3Rev','gapSetpoint','measuredDry','gapWidth','gapPitch','sideB','defects','notes'] as const;
 if(!form||form.version!==1||strings.some(key=>typeof form[key]!=='string')||!['','continuous','intermittent'].includes(form.mode)||!Array.isArray(form.segs)||!form.segs.length||form.segs.some(raw=>typeof raw!=='string')||!Array.isArray(form.ovens)||form.ovens.length!==6||form.ovens.some(raw=>typeof raw!=='string'))throw Error('Структура черновика нанесения не поддерживается; исходные данные сохранены');
 if(form.mixSnapshot!==null){const mix=form.mixSnapshot;if(!mix||!mix.mixBatchId?.trim()||!mix.recipeName?.trim()||!Number.isFinite(mix.createdAt))throw Error('Исходный замес в черновике повреждён');if(hasSlurryHandover(mix))validateSlurryHandover(mix);}
 if(form.attempt!==null){
  validateRecordedCoatingRun(form.attempt);if(form.attempt.workerId!==actorId)throw Error('Автор восстановленной попытки не совпадает с профилем');
  const expected=prepareRecordedCoatingRun(coatingFormEntry(form),actorId,form.attempt.id,form.attempt.recordedRole!,form.attempt.createdAt);
  if(JSON.stringify(expected)!==JSON.stringify(form.attempt))throw Error('Введённые данные отличаются от закреплённой попытки; черновик требует проверки');
 }
 return form;
}
