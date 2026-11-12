import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {v4 as uuidv4} from 'uuid';
import {db} from '../../core/db';
import {listVisibleTasks} from '../../core/sync/visibleTasks';
import type {MixBatch,MixComponent,MixRecipe,SyncPacket} from '../../core/types';
import {StageId} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {calculateSlurryPlan,parseSlurryNumber,slurryMassBalance,SLURRY_BASIS} from '../../core/manufacturing/slurryMath';
import {saveSlurryBatch,validateMeasuredSlurryBatch,SLURRY_UNITS} from '../../core/manufacturing/slurryBatch';
import {calcPasteProperties} from './mixMath';
import {PastePropertiesPanel} from './PastePropertiesPanel';
import {PacketOutModal} from '../_ui/PacketOutModal';

interface Props {presetRecipe?:MixRecipe|null;onPresetConsumed?:()=>void}
interface Line {key:string;componentId:string;component?:MixComponent;pct:string;actual:string}
const empty=()=>({taskId:'',batchCode:'',recipeName:'',targetKg:'',basis:false,lines:[] as Line[],note:'',viscosity:'',fineness:'',density:'',notes:''});
const input='min-h-11 w-full min-w-0 rounded border border-slate-700 bg-slate-900 p-2 text-sm text-white';
const number=(value:number|undefined)=>value===undefined?'неизвестно':value.toLocaleString('ru-RU',{maximumSignificantDigits:12});
export function GrammageCalculator(props:Props){const actor=useAuthStore(s=>s.currentUser?.id);return <CalculatorContent key={actor} {...props}/>;}
function CalculatorContent({presetRecipe,onPresetConsumed}:Props){
 const tasks=useLiveQuery(async()=>(await listVisibleTasks()).filter(task=>task.stage===StageId.SLURRY),[]);
 const actor=useAuthStore(s=>s.currentUser);const catalog=useLiveQuery(()=>db.mixComponents.toArray(),[]);
 const [draft,setDraft]=useState(empty),[source,setSource]=useState<MixRecipe|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [saved,setSaved]=useState<MixBatch|null>(null),[packet,setPacket]=useState<SyncPacket|null>(null);
 const [phi,setPhi]=useState(''),[shear,setShear]=useState('');const lock=useRef(false),attempt=useRef<MixBatch|null>(null);
 useEffect(()=>{
  if(!presetRecipe||catalog===undefined)return;
  setSource(structuredClone(presetRecipe));setDraft({...empty(),recipeName:presetRecipe.name,targetKg:String(presetRecipe.dryMassKg),basis:presetRecipe.basis===SLURRY_BASIS,
   lines:presetRecipe.lines.map(line=>({key:uuidv4(),componentId:line.componentId,component:catalog.find(c=>c.id===line.componentId),pct:String(line.pct),actual:''}))});
  attempt.current=null;setError('');setSaved(null);setPacket(null);onPresetConsumed?.();
 },[presetRecipe,catalog===undefined]);
 const snapshots=useMemo(()=>draft.lines.flatMap(line=>line.component?[line.component]:[]),[draft.lines]);
 const calculation=useMemo(()=>{
  try{
   if(!draft.basis)throw new Error('Подтвердите базу: доли сухого вклада 100 %, жидкие добавки — % от массы СВ');
   const lines=draft.lines.map(line=>({componentId:line.componentId,pct:parseSlurryNumber(line.pct,true)!}));
   return {plan:calculateSlurryPlan(lines,snapshots,parseSlurryNumber(draft.targetKg,true)!,SLURRY_BASIS),lines,error:''};
  }catch(cause){return {plan:null,lines:[],error:cause instanceof Error?cause.message:'План недоступен'};}
 },[draft.lines,draft.targetKg,draft.basis,snapshots]);
 const balance=useMemo(()=>{
  try{return slurryMassBalance(draft.lines.map(line=>({componentId:line.componentId,actualG:parseSlurryNumber(line.actual)})),snapshots);}catch{return null;}
 },[draft.lines,snapshots]);
 const paste=useMemo(()=>{
  try{return calculation.plan?calcPasteProperties(calculation.plan.rows,new Map(snapshots.map(c=>[c.id,c])),{phiMax:parseSlurryNumber(phi),shearRate:parseSlurryNumber(shear)}):null;}catch{return null;}
 },[calculation.plan,snapshots,phi,shear]);
 const change=(key:Exclude<keyof typeof draft,'lines'>)=>(event:React.ChangeEvent<HTMLInputElement>)=>setDraft(d=>({...d,[key]:event.target.value}));
 const lineChange=(index:number,patch:Partial<Line>)=>setDraft(d=>({...d,lines:d.lines.map((line,i)=>i===index?{...line,...patch}:line)}));
 const save=async()=>{
  if(!actor||lock.current||saved)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!attempt.current){
    if(!calculation.plan)throw new Error(calculation.error);
    const weighings=draft.lines.map((line,i)=>({componentId:line.componentId,plannedG:calculation.plan!.rows[i].grams,actualG:parseSlurryNumber(line.actual,true)!}));
    const now=Date.now();const run:MixBatch={id:uuidv4(),taskId:draft.taskId||undefined,measurementVersion:1,batchCode:draft.batchCode.trim(),recipeName:draft.recipeName.trim(),recipeId:source?.id,recipeSnapshot:source??undefined,
     componentSnapshots:snapshots,recipePlan:{basis:SLURRY_BASIS,lines:calculation.lines},batchKg:parseSlurryNumber(draft.targetKg,true)!,weighings,massBalance:slurryMassBalance(weighings,snapshots),measurementUnits:SLURRY_UNITS,
     viscosity:parseSlurryNumber(draft.viscosity),fineness:parseSlurryNumber(draft.fineness),measuredDensity:parseSlurryNumber(draft.density),measurementNote:draft.note.trim(),notes:draft.notes.trim()||undefined,
     workerId:actor.id,recordedRole:actor.role,createdAt:now,updatedAt:now};
    validateMeasuredSlurryBatch(run);attempt.current=run;
   }
   const committed=await saveSlurryBatch(attempt.current,actor.id);setSaved(committed);
   setPacket({v:1,type:'mix-batch',stage:StageId.SLURRY,payload:committed,from:actor.id,role:actor.role,ts:Date.now()});
  }catch(cause){setError(cause instanceof Error?cause.message:'Замес не сохранён');}finally{lock.current=false;setBusy(false);}
 };
 const field=(key:Exclude<keyof typeof draft,'lines'|'basis'>,label:string,decimal=false)=> <label className="block min-w-0 text-xs text-slate-300">{label}<input aria-label={label} className={input} value={draft[key]} inputMode={decimal?'decimal':undefined} onChange={change(key)} disabled={key==='recipeName'&&!!source}/></label>;
 return <div className="space-y-3 min-w-0">
  <h3 className="text-white font-semibold">⚖️ План и измеренные навески</h3>
  <p className="text-xs text-slate-400">План СВ в кг → расчётные навески в г. Фактические массы вводятся отдельно; пустое значение неизвестно. Тип материала не определяет его содержание СВ.</p>
  {saved&&<p role="status" className="text-emerald-300 text-sm">Сохранён измеренный замес {saved.batchCode}. Исходные версии и навески закреплены; передача на намазку доступна в журнале.</p>}
  <fieldset disabled={busy||!!attempt.current||!!saved} className="space-y-3 min-w-0">
   {!!tasks?.length&&<label className="block text-xs text-slate-300">Ссылка на видимое задание (без изменения статуса)<select aria-label="Задание замеса" className={input} value={draft.taskId} onChange={e=>setDraft({...draft,taskId:e.target.value})}><option value="">Без задания</option>{tasks.map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{field('batchCode','Код партии замеса')}{field('recipeName','Название состава')}{field('targetKg','План СВ, кг',true)}</div>
   <p className="text-xs text-slate-400 break-all">{source?`Версия рецепта: ${source.name} · ${source.id} · ${source.updatedAt}`:'Источник состава: явный ручной план'}</p>
   <label className="flex min-h-11 items-start gap-2 text-xs text-slate-300"><input aria-label="Подтверждена база процентов" className="mt-1 h-5 w-5 shrink-0" type="checkbox" checked={draft.basis} onChange={e=>setDraft({...draft,basis:e.target.checked})}/><span>Доли по сухому вкладу составляют 100 %. Для материала с 0 % СВ количество задаётся в % от плановой массы СВ. Масса раствора учитывает его явно указанное содержание СВ.</span></label>
   <div className="flex flex-wrap gap-2">
    {!source&&<button className="min-h-11 px-3 rounded bg-blue-700 text-sm text-white" onClick={()=>setDraft(d=>({...d,lines:[...d.lines,{key:uuidv4(),componentId:'',pct:'',actual:''}]}))}>Добавить материал</button>}
    {source&&<button className="min-h-11 px-3 rounded bg-slate-700 text-sm text-white" onClick={()=>setSource(null)}>Перейти к ручному составу</button>}
   </div>
   {draft.lines.map((line,index)=>{const planned=calculation.plan?.rows[index]?.grams;let actual:number|undefined;try{actual=parseSlurryNumber(line.actual);}catch{}return <article key={line.key} className="space-y-2 rounded border border-slate-700 bg-slate-800/60 p-3 min-w-0">
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
     <label className="text-xs text-slate-300">Материал {index+1}<select aria-label={`Материал ${index+1}`} disabled={!!source} className={input} value={line.componentId} onChange={e=>lineChange(index,{componentId:e.target.value,component:catalog?.find(c=>c.id===e.target.value),actual:''})}><option value="">Выберите материал</option>{[...(line.component?[line.component]:[]),...(catalog??[]).filter(c=>c.id!==line.component?.id)].map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
     <label className="text-xs text-slate-300">Доля {index+1}, %<input disabled={!!source} aria-label={`Доля ${index+1}, %`} className={input} inputMode="decimal" value={line.pct} onChange={e=>lineChange(index,{pct:e.target.value})}/></label>
     <label className="text-xs text-slate-300">Фактическая масса {index+1}, г<input aria-label={`Фактическая масса ${index+1}, г`} className={input} inputMode="decimal" value={line.actual} onChange={e=>lineChange(index,{actual:e.target.value})}/></label>
    </div>
    <p className="text-xs text-slate-300 break-all">{line.component?.name??'Материал не выбран'} · СВ материала: {number(line.component?.solidsMassFraction===undefined?undefined:line.component.solidsMassFraction*100)} % масс. · версия {line.component?.updatedAt??'неизвестна'}</p>
    <p className="text-xs text-slate-400">План: {number(planned)} г · Факт: {number(actual)} г · Δ: {number(planned===undefined||actual===undefined?undefined:actual-planned)} г</p>
    {!source&&<button className="min-h-11 px-3 rounded bg-slate-700 text-xs text-white" onClick={()=>setDraft(d=>({...d,lines:d.lines.filter((_,i)=>i!==index)}))}>Убрать строку {index+1}</button>}
   </article>;})}
   {!calculation.plan&&<p className="text-xs text-amber-200">План недоступен: {calculation.error}</p>}
   <div className="space-y-1 rounded bg-slate-900 p-3 text-xs text-slate-300">
    <p>Плановая масса смеси: {number(calculation.plan?.allTotalG)} г</p>
    <p>Известная сумма навесок: {number(balance?.knownMassG)} г · неизвестных навесок: {balance?.missingCount??'—'}</p>
    <p>Полная фактическая масса: {number(balance?.totalActualG)} г</p>
    <p>СВ по навескам и составу: {number(balance?.solidsPctMass)} % масс. · сухая масса {number(balance?.solidsActualG)} г · жидкая часть {number(balance?.liquidActualG)} г</p>
    <p>Это расчёт по записанным массам и заявленному составу, без вывода о QA или запасах.</p>
   </div>
   {source?.mode?.length?<details className="text-xs text-slate-400"><summary>Плановый режим исходного рецепта (не фактический)</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(source.mode,null,2)}</pre></details>:null}
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{field('viscosity','Измеренная вязкость, мПа·с',true)}{field('fineness','Измеренный перетир, мкм',true)}{field('density','Измеренная плотность, г/см³',true)}{field('note','Основание навесок и состава')}{field('notes','Примечания / дефекты')}</div>
   <p className="text-xs text-slate-400">Неизмеренные свойства оставьте пустыми. Модельная плотность или вязкость не подставляются в измерения и передачу.</p>
   <details className="space-y-2 text-xs text-slate-400"><summary>Отдельная теоретическая оценка плана</summary><div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><label>Введённый φm<input aria-label="φm для модели" className={input} inputMode="decimal" value={phi} onChange={e=>setPhi(e.target.value)}/></label><label>Введённая скорость сдвига, 1/с<input aria-label="Скорость сдвига для модели" className={input} inputMode="decimal" value={shear} onChange={e=>setShear(e.target.value)}/></label></div><PastePropertiesPanel paste={paste} phiMax={Number(phi.replace(',','.'))}/></details>
  </fieldset>
  {error&&<p role="alert" className="text-red-300 text-sm">{error}</p>}
  <div className="flex flex-wrap gap-2">
   <button disabled={busy||!!saved} className="min-h-11 rounded bg-emerald-700 px-3 text-sm text-white disabled:opacity-40" onClick={()=>void save()}>Записать измеренный замес</button>
   {error&&attempt.current&&<button disabled={busy} className="min-h-11 rounded bg-slate-700 px-3 text-sm text-white" onClick={()=>{attempt.current=null;setError('');}}>Изменить незаписанный черновик</button>}
   {!saved&&<button disabled={busy} className="min-h-11 rounded bg-slate-700 px-3 text-sm text-white" onClick={()=>{attempt.current=null;setDraft(d=>({...d,lines:d.lines.map(line=>({...line,component:catalog?.find(c=>c.id===line.componentId)}))}));setError('Версии обновлены явно. Проверьте сохранённые в форме навески перед записью.');}}>Обновить версии материалов; проверить навески</button>}
   <button disabled={busy} className="min-h-11 rounded bg-slate-700 px-3 text-sm text-white" onClick={()=>{attempt.current=null;setSaved(null);setPacket(null);setSource(null);setDraft(empty());setError('');}}>Очистить форму для нового замеса</button>
  </div>
  {packet&&<PacketOutModal packet={packet} onClose={()=>setPacket(null)}/>}
 </div>;
}
