import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {v4 as uuidv4} from 'uuid';
import {db} from '../../core/db';
import {StageId,type SyncPacket} from '../../core/types';
import {PacketOutModal} from '../_ui/PacketOutModal';
import {useAuthStore} from '../../core/store/authStore';
import {useLocalFormDraft,LocalDraftStatus} from '../_common/useLocalFormDraft';
import {STORAGE_UNITS,inspectStorageJournal,saveStorageEvent,exportStorageHistory,validateStorageEvent,type StorageEvent,type StorageReceipt,type RecordedLot} from '../../core/manufacturing/storageReceipts';

const inputClass='w-full min-h-[44px] rounded border border-slate-600 bg-slate-900 px-3 py-2 text-white';
const buttonClass='min-h-[44px] rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50';
const emptyReceipt={material:'',materialReference:'',supplier:'',documentReference:'',lotCode:'',quantity:'',unit:'',location:'',evidence:''};
type ReceiptDraft=typeof emptyReceipt;
interface StorageForm {version:1;draft:ReceiptDraft;selected:RecordedLot|null;place:string;basis:string;attempt:StorageEvent|null;}
const emptyForm=():StorageForm=>({version:1,draft:{...emptyReceipt},selected:null,place:'',basis:'',attempt:null});
function parseForm(value:unknown,actorId:string):StorageForm {
 const form=value as StorageForm;
 if(!form||form.version!==1||!form.draft||Object.keys(emptyReceipt).some(key=>typeof form.draft[key as keyof ReceiptDraft]!=='string')||typeof form.place!=='string'||typeof form.basis!=='string')throw Error('Структура складского черновика не поддерживается; исходные данные сохранены');
 if(form.attempt!==null){validateStorageEvent(form.attempt);if(form.attempt.actorId!==actorId)throw Error('Автор складской попытки не совпадает с профилем');}
 if(form.selected!==null){if(!form.selected)throw Error('Исходная история места в черновике повреждена');validateStorageEvent(form.selected.receipt);if(form.selected.receipt.kind!=='receipt'||!Array.isArray(form.selected.history)||!form.selected.history.length||form.selected.location!==undefined&&typeof form.selected.location!=='string')throw Error('Исходная история места в черновике повреждена');for(const event of form.selected.history)validateStorageEvent(event);}
 return form;
}
const fields:[keyof Omit<ReceiptDraft,'unit'>,string][]=[['material','Материал'],['materialReference','Код материала (если известен)'],['supplier','Поставщик (если известен)'],['documentReference','Документ (если известен)'],['lotCode','Код партии материала'],['quantity','Количество поступления'],['location','Место получения'],['evidence','Основание поступления']];
function parseQuantity(raw:string):number {
 if(!raw.trim())throw Error('Количество: пустое значение неизвестно; введите полученное количество');
 if(!/^\d+(?:[.,]\d+)?$/.test(raw.trim()))throw Error('Количество: введите положительное число, допускается десятичная запятая');
 return Number(raw.trim().replace(',','.'));
}
export function StorageRegister(){
 const actor=useAuthStore(s=>s.currentUser);
 return actor?<RegisterForActor key={actor.id} actor={actor}/>:<p>Войдите в локальный профиль для записи поступлений.</p>;
}
function RegisterForActor({actor}:{actor:NonNullable<ReturnType<typeof useAuthStore.getState>['currentUser']>}){
 const register=useLiveQuery(async()=>inspectStorageJournal(await db.journal.toArray()),[]);
 const recovery=useLocalFormDraft(actor.id,'storage',emptyForm,value=>parseForm(value,actor.id));
 const {draft,selected,place,basis,attempt}=recovery.value;
 const setDraft=(draft:ReceiptDraft)=>recovery.edit(form=>({...form,draft}));
 const setPlace=(place:string)=>recovery.edit(form=>({...form,place}));const setBasis=(basis:string)=>recovery.edit(form=>({...form,basis}));
 const [query,setQuery]=useState('');
 const [navigation,setNavigation]=useState<{kind:'new'|'lot';lotId?:string}|null>(null);
 // A new receipt or a different lot should never silently discard a local draft.
 // Confirmation is inline: no browser confirm() (unreliable in native WebViews).
 const dirty=!saved&&(
   !!attempt||Object.values(draft).some(value=>value.trim()!=='')||
   !!selected&&(place.trim()!==''||basis.trim()!=='')
 );
 const [packet,setPacket]=useState<SyncPacket|null>(null);
 const [error,setError]=useState('');const [message,setMessage]=useState('');
 const [pending,setPending]=useState(false);const busy=useRef(false);
 const [saved,setSaved]=useState<StorageEvent>();const [checking,setChecking]=useState(false);
 useEffect(()=>{
  if(!recovery.ready||!attempt){setSaved(undefined);return;}let active=true;setChecking(true);
  void db.journal.get(attempt.id).then(row=>{if(!active||!row)return;if(row.params?.storageEvent!==JSON.stringify(attempt))throw Error('Сохранённая запись отличается от восстановленной попытки; история сохранена');setSaved(attempt);setMessage(attempt.kind==='receipt'?'Поступление записано':'Место записано');}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setChecking(false);});
  return()=>{active=false;};
 },[recovery.ready,attempt]);
 const frozen=!!attempt||!!saved||pending||checking;
 async function persist(create:()=>StorageEvent){
  if(busy.current||saved||checking||!recovery.ready||recovery.error)return;busy.current=true;setPending(true);setError('');setMessage('');
  try{
   const event=attempt??create();validateStorageEvent(event);await recovery.checkpoint(form=>({...form,attempt:event}));
   const result=await saveStorageEvent(event,actor.id);setSaved(result);
   setMessage(result.kind==='receipt'?'Поступление записано':'Место записано');
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{busy.current=false;setPending(false);}
 }
 async function sendHistory(lot:RecordedLot){
  if(busy.current)return;busy.current=true;setPending(true);setError('');
  try{const payload=await exportStorageHistory(lot.history,actor.id);setPacket({v:1,type:'storage-history',stage:StageId.STORAGE,from:payload.exportedBy,role:payload.exportedRole,ts:payload.exportedAt,payload});}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{busy.current=false;setPending(false);}
 }
 function clearMessages(){setSaved(undefined);setError('');setMessage('');}
 function resetAttempt(){clearMessages();recovery.edit(form=>({...form,attempt:null}));}
 async function performNewReceipt(){if(busy.current)return;busy.current=true;setPending(true);try{await recovery.reset();clearMessages();setNavigation(null);}catch(e){setError(String(e));}finally{busy.current=false;setPending(false);}}
 function performOpenLot(lot:RecordedLot){clearMessages();recovery.edit(form=>({...form,selected:lot,place:'',basis:'',attempt:null}));setNavigation(null);}
 function newReceipt(){if(busy.current||pending||checking)return;if(dirty){setNavigation({kind:'new'});return;}void performNewReceipt();}
 function openLot(lot:RecordedLot){if(busy.current||pending||checking)return;if(selected?.receipt.id===lot.receipt.id)return;if(dirty){setNavigation({kind:'lot',lotId:lot.receipt.id});return;}performOpenLot(lot);}
 function confirmNavigation(){
  if(!navigation||busy.current||pending||checking)return;
  if(navigation.kind==='new'){void performNewReceipt();return;}
  const lot=register?.lots.find(item=>item.receipt.id===navigation.lotId);
  if(!lot){setError('Выбранная партия больше не доступна, обновите реестр');return;}
  performOpenLot(lot);
 }
 const lots=(register?.lots??[]).filter(lot=>[lot.receipt.material,lot.receipt.materialReference,lot.receipt.lotCode,lot.receipt.supplier,lot.receipt.documentReference,...lot.history.map(e=>e.location)].some(value=>value?.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))));
 if(!recovery.ready)return <LocalDraftStatus draft={recovery}/>;
 return <div className="space-y-4 break-words">
  <div className="rounded border border-amber-700 bg-slate-800 p-3 text-sm text-slate-200">
   <h3 className="text-lg font-semibold">Записанные поступления и история мест</h3>
   <p>Это записи наблюдений на устройстве. Остаток, расход, перемещение запасов и QA не подтверждены. Количество не пересчитывается между единицами.</p>
   <p>Одна запись поступления на материал/партию/поставщика. Неизвестный поставщик сохраняется неизвестным. Повторные частичные поступления и разделение партии требуют отдельного порядка учёта.</p>
  </div>
  <LocalDraftStatus draft={recovery} disabled={pending||checking}/>
  {navigation&&<section role="alertdialog" aria-label="Подтверждение смены складской формы"
    className="rounded-lg border-2 border-amber-500 bg-slate-900 p-4 space-y-3">
    <h4 className="font-semibold text-amber-200">Есть незавершённые данные склада</h4>
    <p className="text-sm text-slate-200">
      {navigation.kind==='new'?'Начать новое поступление?':'Открыть другую партию?'}
      {' '}Текущие незавершённые поля и попытка сохранения будут сброшены.
      Сохранённые записи в журнале останутся без изменений.
    </p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded bg-amber-700 px-4 text-white"
        disabled={pending||checking} onClick={confirmNavigation}>Сбросить незавершённую форму</button>
      <button type="button" className="min-h-11 rounded bg-slate-700 px-4 text-white"
        onClick={()=>setNavigation(null)}>Оставить текущую форму</button>
    </div>
  </section>}
  {(register?.problems.length??0)>0&&<p role="alert" className="text-amber-300">История требует проверки: {register!.problems.length} записей/связей. Старые записи сохранены; новые записи заблокированы до проверки. {register!.problems[0]}</p>}
  {error&&<p role="alert" className="rounded border border-red-600 p-3 text-red-300">{error}</p>}
  {message&&<p role="status" className="text-green-300">{message}. Сохранено на устройстве, физический остаток не рассчитан.</p>}
  {attempt&&!saved&&<p className="text-sm text-amber-200">Снимок попытки сохранения зафиксирован. Повтор использует тот же ID. Для исправления явно откройте редактирование.</p>}
  {!selected?<section className="space-y-3 rounded border border-slate-700 bg-slate-800 p-3">
   <h4 className="font-semibold">Фактическое поступление</h4>
   <fieldset disabled={frozen} className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
    {fields.map(([key,label])=><label key={key} className="min-w-0 text-sm text-slate-200">{label}<input aria-label={label} className={inputClass} value={draft[key]} inputMode={key==='quantity'?'decimal':undefined} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}
    <label className="text-sm text-slate-200">Единица количества<select aria-label="Единица количества" className={inputClass} value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})}><option value="">Выберите единицу явно</option>{Object.entries(STORAGE_UNITS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   </fieldset>
   <div className="flex flex-wrap gap-2">
    <button className={buttonClass} disabled={pending||checking||!!saved||!!recovery.error} onClick={()=>void persist(()=>({version:1,kind:'receipt',id:`storage:${uuidv4()}`,material:draft.material.trim(),materialReference:draft.materialReference.trim()||undefined,supplier:draft.supplier.trim()||undefined,documentReference:draft.documentReference.trim()||undefined,lotCode:draft.lotCode.trim(),quantity:parseQuantity(draft.quantity),unit:draft.unit as StorageReceipt['unit'],location:draft.location.trim(),evidence:draft.evidence.trim(),actorId:actor.id,actorRole:actor.role,recordedAt:Date.now()}))}>{pending?'Сохранение…':'Записать поступление'}</button>
    {attempt&&!saved&&<button className={buttonClass} disabled={pending||checking} onClick={resetAttempt}>Редактировать попытку</button>}
    <button className={buttonClass} disabled={pending||checking} onClick={newReceipt}>Новое поступление</button>
   </div>
  </section>:<section className="space-y-3 rounded border border-slate-600 bg-slate-800 p-3">
   <h4 className="font-semibold">История партии {selected.receipt.lotCode}: {selected.receipt.material}</h4>
   <p className="text-sm">Снимок на момент открытия. Последнее место: {selected.location??'требует проверки'}. {selected.receipt.quantity} {STORAGE_UNITS[selected.receipt.unit]} — записано при поступлении.</p>
   {selected.history.map(event=><div key={event.id} className="rounded bg-slate-900 p-3 text-sm"><p>{event.kind==='receipt'?'Поступление':`${event.fromLocation} →`} {event.location}</p><p>{event.evidence}</p><p>{new Date(event.recordedAt).toLocaleString('ru-RU')} · {event.actorId} · {event.actorRole}</p><p className="text-slate-400">ID: {event.id}</p></div>)}
   <fieldset disabled={frozen||!selected.location} className="space-y-3">
    <label className="block text-sm">Новое место<input aria-label="Новое место" className={inputClass} value={place} onChange={e=>setPlace(e.target.value)}/></label>
    <label className="block text-sm">Основание смены места<input aria-label="Основание смены места" className={inputClass} value={basis} onChange={e=>setBasis(e.target.value)}/></label>
   </fieldset>
   <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={pending||checking||!!saved||!!recovery.error||!selected.location} onClick={()=>void persist(()=>({version:1,kind:'location',id:`storage:${uuidv4()}`,receiptId:selected.receipt.id,previousEventId:selected.history[selected.history.length-1].id,fromLocation:selected.location!,location:place.trim(),evidence:basis.trim(),actorId:actor.id,actorRole:actor.role,recordedAt:Date.now()}))}>Записать место</button>
    {attempt&&!saved&&<button className={buttonClass} disabled={pending||checking} onClick={resetAttempt}>Редактировать попытку</button>}
    <button className={buttonClass} disabled={pending||checking} onClick={()=>{const latest=register?.lots.find(lot=>lot.receipt.id===selected.receipt.id);if(latest){clearMessages();recovery.edit(form=>({...form,selected:latest,attempt:null}));}}}>Обновить историю явно</button>
    <button className={buttonClass} disabled={pending||checking||!selected.location} onClick={()=>void sendHistory(selected)}>Передать сохранённую историю</button>
    <button className={buttonClass} disabled={pending||checking} onClick={()=>{clearMessages();recovery.edit(form=>({...form,selected:null,attempt:null}));}}>К поступлениям</button>
   </div>
  </section>}
  <section className="space-y-3"><h4 className="font-semibold">Реестр записанных поступлений</h4>
   <label className="block text-sm">Поиск по материалу, партии, поставщику, документу и месту<input aria-label="Поиск поступлений" className={inputClass} value={query} onChange={e=>setQuery(e.target.value)}/></label>
   {!register?<p>Чтение записей…</p>:!register.lots.length?<p>Поступлений пока нет. Старые свободные записи доступны в журнале работ.</p>:!lots.length?<p>Совпадений нет.</p>:lots.map(lot=><article key={lot.receipt.id} className="space-y-2 rounded border border-slate-700 bg-slate-800 p-3">
    <h5 className="font-semibold">{lot.receipt.material} · {lot.receipt.lotCode}</h5><p>{lot.receipt.quantity} {STORAGE_UNITS[lot.receipt.unit]} · записано при поступлении</p><p>Последнее записанное место: {lot.location??'требует проверки'}</p><p className="text-sm">Код материала: {lot.receipt.materialReference??'неизвестен'} · Поставщик: {lot.receipt.supplier??'неизвестен'} · Документ: {lot.receipt.documentReference??'неизвестен'}</p><p className="text-sm">Основание: {lot.receipt.evidence}</p><p className="text-sm">{new Date(lot.receipt.recordedAt).toLocaleString('ru-RU')} · {lot.receipt.actorId} · {lot.receipt.actorRole}</p>
    <button className={buttonClass} disabled={pending||checking} onClick={()=>openLot(lot)}>История и место</button>
   </article>)}
  </section>
  {packet&&<PacketOutModal packet={packet} onClose={()=>setPacket(null)}/>}
  <p className="text-xs text-slate-400">После успешного локального сохранения черновики формы восстанавливаются для текущего профиля. Новая версия истории места принимается только после явного обновления. Сохранённые записи доступны офлайн; роль локального профиля не предоставляет серверные полномочия.</p>
 </div>;
}
