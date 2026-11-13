import React,{useEffect,useMemo,useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import {db} from '../../core/db';
import type {CoatingMixSnapshot,CoatRun,User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {useLocalFormDraft,LocalDraftStatus} from '../_common/useLocalFormDraft';
import {emptyCoatingForm,parseCoatingForm,coatingFormEntry,type CoatingForm} from './coatingDraft';
import {prepareRecordedCoatingRun,savePreparedCoatingRun} from './coatingJournal';
import {wetThicknessUm,requiredScrewFlowLpm,screwRpmFromFlow,intermittentCoverage} from './coatMath';
const input='w-full min-w-0 min-h-11 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white';
const button='min-h-11 rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40';
interface Props {mixes:CoatingMixSnapshot[];onSaved:()=>void;}
export function CoatingSetup(props:Props){const actor=useAuthStore(s=>s.currentUser);return actor?<SetupContent key={actor.id} actor={actor} {...props}/>:<p>Войдите в локальный профиль.</p>;}
function SetupContent({actor,mixes,onSaved}:Props&{actor:User}){
 const recovery=useLocalFormDraft(actor.id,'coating',emptyCoatingForm,value=>parseCoatingForm(value,actor.id));
 const form=recovery.value,mix=form.mixSnapshot,attempt=form.attempt;
 const [saved,setSaved]=useState<CoatRun|null>(null),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[error,setError]=useState('');const lock=useRef(false);
 useEffect(()=>{
  if(!recovery.ready||!attempt){setSaved(null);return;}let active=true;setChecking(true);
  void db.coatRuns.get(attempt.id).then(row=>{if(!active||!row)return;if(JSON.stringify(row)!==JSON.stringify(attempt))throw Error('Сохранённая запись отличается от закреплённой попытки; история сохранена');setSaved(row);}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setChecking(false);});return()=>{active=false;};
 },[recovery.ready,attempt]);
 const calc=useMemo(()=>{
  try{const entry=coatingFormEntry(form);const wet=mix?.pasteDensity!==undefined&&mix.solidsPctMass!==undefined?wetThicknessUm(entry.targetDryMgm2!,mix.pasteDensity,mix.solidsPctMass):null;
   const flow=wet===null?null:requiredScrewFlowLpm(entry.coatingWidthCm!,wet,entry.webSpeedMpm!);
   const cov=form.mode==='intermittent'&&(entry.gapWidthMm===undefined||entry.gapPitchMm===undefined)?null:intermittentCoverage(entry.segLengthsM,form.mode==='intermittent'?entry.gapWidthMm:undefined,form.mode==='intermittent'?entry.gapPitchMm:undefined);
   return {wet,flow,rpm:screwRpmFromFlow(flow,entry.pumpDeliveryCm3Rev),gap:entry.headGapUm!==undefined&&entry.headGapUm>0?entry.headGapUm:null,cov,sideB:entry.sideBLengthM};
  }catch{return null;}
 },[form,mix]);
 async function save(){
  if(lock.current||saved||checking||!recovery.ready||recovery.error)return;lock.current=true;setBusy(true);setError('');
  try{const run=attempt??prepareRecordedCoatingRun(coatingFormEntry(form),actor.id,uuidv4(),actor.role);await recovery.checkpoint(current=>({...current,attempt:run}));const result=await savePreparedCoatingRun(run,actor.id);setSaved(result);onSaved();}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{lock.current=false;setBusy(false);}
 }
 async function reset(){if(lock.current)return;lock.current=true;setBusy(true);try{await recovery.reset();setSaved(null);setError('');}catch(e){setError(String(e));}finally{lock.current=false;setBusy(false);}}
 const change=<K extends keyof CoatingForm>(key:K,value:CoatingForm[K])=>recovery.edit(current=>({...current,[key]:value}));
 const field=(key:'foilType'|'targetDry'|'widthCm'|'webSpeed'|'supplyCm3Rev'|'gapSetpoint'|'measuredDry'|'gapWidth'|'gapPitch'|'sideB'|'defects',label:string,decimal=true)=><label className="block min-w-0 text-xs text-slate-300">{label}<input aria-label={label} className={input} value={form[key]} inputMode={decimal?'decimal':undefined} onChange={e=>change(key,e.target.value)}/></label>;
 if(!recovery.ready)return <LocalDraftStatus draft={recovery}/>;
 const frozen=busy||checking||!!attempt||!!saved;
 const currentMix=mix?mixes.find(item=>item.mixBatchId===mix.mixBatchId):undefined;
 const stale=!!mix&&JSON.stringify(currentMix)!==JSON.stringify(mix);
 return <div className="space-y-3 min-w-0">
  <LocalDraftStatus draft={recovery} disabled={busy||checking}/>
  {saved&&<p role="status" className="text-green-300">Сохранена запись нанесения: {saved.foilType}. Повторная запись не создаётся; экспорт доступен в журнале.</p>}
  {attempt&&!saved&&!recovery.saving&&!recovery.error&&<p className="text-sm text-amber-200">Попытка записи закреплена на устройстве. Повтор сохранит тот же ID и время.</p>}
  {stale&&!saved&&<p role="alert" className="text-sm text-amber-200">Источник замеса изменён или отсутствует. В форме сохранена выбранная версия. Обновите её явно и проверьте параметры.</p>}
  {error&&<p role="alert" className="text-sm text-red-300">{error}</p>}
  <div className="grid min-w-0 gap-4 lg:grid-cols-2">
   <div className="space-y-3 rounded border border-slate-700 bg-slate-800 p-3 min-w-0">
    <h3 className="font-semibold text-white">Запись нанесения · исходные данные и наблюдения</h3>
    <fieldset disabled={frozen} className="space-y-3 min-w-0">
     <label className="block text-xs text-slate-300">Замес для нанесения<select aria-label="Замес для нанесения" className={input} value={mix?.mixBatchId??''} onChange={e=>change('mixSnapshot',structuredClone(mixes.find(item=>item.mixBatchId===e.target.value)??null))}><option value="">Без замеса: источник не указан</option>{[...(mix?[mix]:[]),...mixes.filter(item=>item.mixBatchId!==mix?.mixBatchId)].map(item=><option key={item.mixBatchId} value={item.mixBatchId}>{item.recipeName}</option>)}</select></label>
     {mix&&<p className="text-xs text-slate-400 break-words">Закреплённый источник: {mix.recipeName} · {mix.mixBatchId} · версия {mix.createdAt}</p>}
     <section aria-label="План и назначенные параметры" className="space-y-2 rounded border border-slate-600 p-3">
      <h4 className="text-sm font-semibold text-white">1. План и назначенные параметры</h4>
      <p className="text-xs text-slate-300">Введённые значения не являются подтверждением настройки станка или фактическим измерением.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{field('foilType','Фольга',false)}{field('targetDry','Сухая поверхностная плотность, мг/см²')}{field('widthCm','Ширина полосы, см')}{field('webSpeed','Скорость фольги, м/мин')}{field('supplyCm3Rev','Калиброванная подача, см³/об')}{field('gapSetpoint','Заданный зазор, мкм')}</div>
     </section>
     <section aria-label="Измеренные наблюдения" className="space-y-2 rounded border border-slate-600 p-3">
      <h4 className="text-sm font-semibold text-white">2. Фактические наблюдения</h4>
      <p className="text-xs text-slate-300">Записывайте только фактически полученные значения. Пустое поле означает «не измерено», ноль — введённое значение.</p>
      {field('measuredDry','Измеренная толщина сухого электрода, мкм')}
     </section>
     <p className="text-xs text-slate-400">Сухой замер включает фольгу и покрытия обеих сторон. Расчётная мокрая толщина не заменяет измерение. QA не подтверждено.</p>
     <h4 className="text-sm font-semibold text-white border-b border-slate-700 pb-2">3. Геометрия, участки и печи</h4>
     <div className="space-y-2"><p className="text-xs text-slate-300">Режим нанесения — выберите явно</p><div className="flex flex-wrap gap-2"><button aria-pressed={form.mode==='continuous'} className={button} onClick={()=>change('mode','continuous')}>Сплошное</button><button aria-pressed={form.mode==='intermittent'} className={button} onClick={()=>change('mode','intermittent')}>С промежутками</button></div></div>
     {form.mode==='intermittent'&&<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{field('gapWidth','Размер промежутка, мм')}{field('gapPitch','Шаг промежутков, мм')}</div>}
     <div className="space-y-2"><p className="text-xs text-slate-300">Участки стороны A, м</p>{form.segs.map((raw,i)=><div key={i} className="flex min-w-0 gap-2"><label className="min-w-0 flex-1 text-xs text-slate-300">Участок {i+1}<input aria-label={`Длина участка ${i+1}, м`} className={input} inputMode="decimal" value={raw} onChange={e=>change('segs',form.segs.map((item,j)=>j===i?e.target.value:item))}/></label>{form.segs.length>1&&<button aria-label={`Убрать участок ${i+1}`} className={button} onClick={()=>change('segs',form.segs.filter((_,j)=>j!==i))}>×</button>}</div>)}<button className={button} onClick={()=>change('segs',[...form.segs,''])}>Добавить участок</button></div>
     {field('sideB','Длина стороны B, м')}
     <div className="space-y-2"><p className="text-xs text-slate-300">Температуры печей, °C</p><div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{form.ovens.map((raw,i)=><label key={i} className="min-w-0 text-xs text-slate-300">Печь {i+1}<input aria-label={`Температура печи ${i+1}, °C`} className={input} inputMode="decimal" value={raw} onChange={e=>change('ovens',form.ovens.map((item,j)=>j===i?e.target.value:item))}/></label>)}</div><p className="text-xs text-slate-400">Пустые зоны неизвестны. Оставьте все 6 пустыми или введите все 6 температур явно, включая измеренный ноль.</p></div>
     {field('defects','Дефекты / замечания',false)}<label className="block text-xs text-slate-300">Примечания<textarea aria-label="Примечания нанесения" className={input} value={form.notes} onChange={e=>change('notes',e.target.value)}/></label>
    </fieldset>
    <h4 className="text-sm font-semibold text-white border-b border-slate-700 pb-2">4. Проверка и сохранение локальной записи</h4>
    <p className="text-xs text-slate-300">Проверьте источник замеса, единицы измерений и пустые поля. Сохранение фиксирует введённые данные, но не означает передачу, физический выпуск или QA-допуск.</p>
    <div className="flex flex-wrap gap-2"><button disabled={busy||checking||!!saved||!!recovery.error} className={button} onClick={()=>void save()}>{busy?'Сохранение…':saved?'Сохранено ✓':'💾 Записать в журнал нанесения'}</button>
     {attempt&&!saved&&<button disabled={busy||checking} className={button} onClick={()=>{change('attempt',null);setError('');}}>Редактировать незаписанную форму</button>}
     {mix&&!saved&&<button disabled={busy||checking} className={button} onClick={()=>{if(!currentMix){setError('Источник недоступен; выберите другой или явно укажите отсутствие замеса');return;}recovery.edit(current=>({...current,mixSnapshot:structuredClone(currentMix),attempt:null}));setError('Источник обновлён явно. Проверьте сохранённые в форме параметры.');}}>Обновить источник; проверить параметры</button>}
     <button disabled={busy||checking} className={button} onClick={()=>void reset()}>Очистить форму для новой записи</button>
    </div>
   </div>
   <div className="space-y-3 min-w-0"><details className="space-y-2 rounded border border-slate-700 bg-slate-800 p-3"><summary className="min-h-11 flex cursor-pointer items-center text-sm font-semibold text-white">Теоретические оценки · открыть при необходимости</summary><div className="space-y-2 pt-2"><p className="text-xs text-amber-200">Только расчёт. Не показания оборудования и не подтверждённые параметры процесса.</p><ResultRow label="Оценка мокрой толщины" value={calc?.wet} unit="мкм"/><ResultRow label="Заданный зазор головки (не расчёт)" value={calc?.gap} unit="мкм"/><ResultRow label="Расчётный объёмный расход" value={calc?.flow} unit="л/мин"/><ResultRow label="Обороты (при известной калибровке)" value={calc?.rpm} unit="об/мин"/><p className="text-xs text-slate-400">Мокрая толщина и расход — оценки по составу и плотности пасты. Зазор вводится отдельно; обороты доступны только с введённой калибровкой. Параметры не отправляются на оборудование.</p></div></details>
    <section className="space-y-2 rounded border border-slate-700 bg-slate-800 p-3"><h3 className="font-semibold text-white">Геометрия · расчёт по введённым длинам</h3>{form.mode==='intermittent'&&<p className="text-xs text-slate-400">Оценка предполагает промежуток в начале каждого участка, затем повтор через указанный шаг.</p>}<ResultRow label="Суммарная длина участков (сторона A)" value={calc?.cov?.totalM} unit="м"/><ResultRow label="Полезная длина покрытия" value={calc?.cov?.coatedM} unit="м"/><ResultRow label="Длина промежутков" value={calc?.cov?.skipM} unit="м"/><ResultRow label="Сторона B" value={calc?.sideB} unit="м"/><ResultRow label="Сумма покрытия двух сторон (не длина рулона)" value={calc?.cov?Math.round((calc.cov.coatedM+(calc.sideB??0))*100)/100:null} unit="м"/></section>
   </div>
  </div>
 </div>;
}
function ResultRow({label,value,unit}:{label:string;value:number|null|undefined;unit:string}){return <div className="flex items-baseline justify-between gap-3 border-b border-slate-700/50 pb-1"><p className="text-xs text-slate-400">{label}</p><p className="shrink-0 text-sm text-white">{typeof value==='number'&&Number.isFinite(value)?value:'—'} {unit}</p></div>;}
