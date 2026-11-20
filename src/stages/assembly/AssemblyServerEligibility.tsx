import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import type {ServerConnection} from '../../core/sync/serverConnection';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import {loadAvailableAssemblyGrades,type AvailableAssemblyGrade} from '../../core/sync/assemblyEligibility';
import {assemblyDrafts,freezeAssemblyOffer,sendAssemblyDraft} from '../../core/sync/assemblyTransfers';

const input='w-full min-w-0 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white';
const button='min-h-11 rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50';

export function AssemblyServerEligibility({connection}:{connection:ServerConnection|null}){
 if(!connection||!['chief','master'].includes(connection.serverRole))
  return <section aria-label="Проверка серверных электродов" className="rounded border border-slate-700 p-3 text-sm">
   <h4 className="font-semibold">Серверные электроды Sorting → Assembly</h4>
   <p>Для проверки подключитесь к серверу как Chief / Master и подтвердите устройство в разделе Синхронизация. Локальные партии ниже сохраняются отдельно.</p>
  </section>;
 const scope:InventoryScope={serverUrl:connection.serverUrl,organizationId:connection.organizationId,
  actorId:connection.serverActorId,deviceId:connection.selectedDeviceId};
 return <VerifiedAssemblyGrades key={inventoryScopeKey(scope)+':'+connection.session.deviceProofExpiresAt}
  connection={connection} scope={scope}/>;
}

function VerifiedAssemblyGrades({connection,scope}:{connection:ServerConnection;scope:InventoryScope}){
 const [batch,setBatch]=useState('');
 const [step,setStep]=useState('');
 const [recipient,setRecipient]=useState(connection.serverActorId);
 const [items,setItems]=useState<AvailableAssemblyGrade[]>([]);
 const [after,setAfter]=useState<string|null>(null);
 const [epoch,setEpoch]=useState<string>();
 const [loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const drafts=useLiveQuery(()=>assemblyDrafts(scope,'offer'),[inventoryScopeKey(scope)])??[];
 const running=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 function clear(){
  setItems([]);setAfter(null);setEpoch(undefined);setLoaded(false);setError('');
 }
 async function refresh(next=false){
  if(running.current)return;
  running.current=true;setBusy(true);setError('');
  if(!next)clear();
  try{
   const page=await loadAvailableAssemblyGrades(connection.session,scope,{
    assemblyBatchId:batch.trim(),assemblyStepNumber:Number(step),recipientId:recipient.trim(),
   },next?epoch:undefined,next?after??undefined:undefined);
   if(alive.current){
    setItems(previous=>next?[...previous,...page.items]:page.items);
    setAfter(page.nextAfter);setEpoch(page.epoch);setLoaded(true);
   }
  }catch(cause){
   if(alive.current){
    // Never leave stale positive eligibility visible after a failed check.
    setItems([]);setAfter(null);setEpoch(undefined);setLoaded(false);
    setError(cause instanceof Error?cause.message:String(cause));
   }
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function sendGrade(item:AvailableAssemblyGrade,reason:string,evidence:string,sendNow:boolean){
  if(running.current)return;
  running.current=true;setBusy(true);setError('');
  try{
   const frozen=await freezeAssemblyOffer(scope,epoch!,item,{
    assemblyBatchId:batch.trim(),assemblyStepNumber:Number(step),recipientId:recipient.trim(),
   },reason,evidence);
   if(alive.current)setNotice('Передача '+frozen.operationId+' сохранена локально; её можно вручную повторить после восстановления связи.');
   if(sendNow){
    await sendAssemblyDraft(connection.session,scope,frozen.key);
    if(alive.current)setNotice('Сервер подтвердил передачу '+frozen.operationId+'. Физическая приёмка выполняется отдельно.');
   }
   if(alive.current){setItems(current=>current.filter(r=>r.submissionId!==item.submissionId||r.grade!==item.grade));setLoaded(false);setEpoch(undefined);setAfter(null);}
  }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function retryDraft(key:string){
  if(running.current)return;
  running.current=true;setBusy(true);setError('');
  try{await sendAssemblyDraft(connection.session,scope,key);
   if(alive.current){setItems([]);setLoaded(false);setAfter(null);setEpoch(undefined);}
  }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:String(cause));}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 return <section aria-label="Проверка серверных электродов" className="min-w-0 space-y-3 rounded border border-slate-600 bg-slate-800 p-3 text-sm break-words">
  <h4 className="font-semibold">Серверные электроды Sorting → Assembly</h4>
  <p className="text-slate-300">Укажите действующую партию ячеек, шаг и назначенного получателя. Проверка не резервирует электроды. Для каждого сорта требуется отдельное свидетельство и явная передача; получатель затем подтверждает физическую приёмку отдельно.</p>
  <fieldset disabled={busy} className="space-y-2">
   <label className="block">ID серверной партии Assembly
    <input aria-label="ID партии Assembly" className={input} placeholder="UUID партии ячеек" value={batch} onChange={e=>{setBatch(e.target.value);clear();}}/>
   </label>
   <label className="block">Номер шага Assembly
    <input aria-label="Номер шага Assembly" className={input} type="number" min="1" step="1" inputMode="numeric" value={step} onChange={e=>{setStep(e.target.value);clear();}}/>
   </label>
   <label className="block">ID назначенного получателя
    <input aria-label="ID получателя Assembly" className={input} placeholder="UUID участника Assembly" value={recipient} onChange={e=>{setRecipient(e.target.value);clear();}}/>
   </label>
   <button type="button" className={button} disabled={busy||!batch.trim()||!step||!recipient.trim()} onClick={()=>void refresh()}>Проверить доступные сорта на сервере</button>
  </fieldset>
  {loaded&&<p className="text-slate-300">Проверенные предложения: {items.length} доступных сортов. История сервера: {epoch}. Проверка актуальна только на момент запроса.</p>}
  {loaded&&items.length===0&&<p>В прочитанных предложениях подходящих сортов нет. Если предложений больше, проверьте следующие страницы.</p>}
  {items.map(item=><article key={item.submissionId+':'+item.grade} className="space-y-1 rounded border border-slate-600 p-2">
   <p className="font-semibold">Сорт {item.grade} · {item.quantity} шт.</p>
   <p>Партия Sorting: {item.sourceBatchId} · шаг {item.sourceStepNumber}</p>
   <p>Итог сортировки: {item.sortRunId}</p>
   <p className="break-all text-slate-400">Предложение: {item.submissionId} · материал: {item.materialId}</p>
   <p className="text-amber-200">Предварительная проверка: сервер перепроверит маршрут и источник при передаче.</p>
   {drafts.some(d=>{try{const r=JSON.parse(d.fields.request);return r.submissionId===item.submissionId&&r.grade===item.grade;}catch{return false;}})?
    <p>Исходная заявка этого сорта сохранена ниже; используйте только её ID.</p>:
    <AssemblyGradeOfferForm key={item.submissionId+item.grade} disabled={busy} onSave={(reason,evidence,sendNow)=>void sendGrade(item,reason,evidence,sendNow)}/>}
  </article>)}
  {loaded&&after&&<button type="button" className={button} disabled={busy} onClick={()=>void refresh(true)}>Проверить следующие предложения</button>}
  <h5 className="font-semibold">Исходные операции передачи (сохраняются на устройстве)</h5>
  {drafts.map(d=><article key={d.key} className="rounded border border-slate-600 p-2 space-y-1">
   <p>Операция {d.operationId} · {d.fields.state==='accepted'?'Сервер подтвердил передачу':d.fields.state==='pending'?'Ожидает отправки / точного повтора':'Конфликт; требуется сверка'}</p>
   {d.fields.state==='pending'&&<button className={button} disabled={busy} onClick={()=>void retryDraft(d.key)}>Повторить исходный ID</button>}
   <details><summary>Исходная заявка и подтверждение</summary><pre className="whitespace-pre-wrap break-all text-xs">{d.fields.request}{'\n'}{d.fields.acknowledgement}</pre></details>
  </article>)}
  {notice&&<p role="status" className="text-blue-200">{notice}</p>}
  {error&&<p role="alert" className="text-red-300">{error}</p>}
 </section>;
}

function AssemblyGradeOfferForm({disabled,onSave}:{disabled:boolean;onSave:(reason:string,evidence:string,sendNow:boolean)=>void}){
 const [reason,setReason]=useState(''),[evidence,setEvidence]=useState('');
 return <form className="space-y-2" onSubmit={event=>{event.preventDefault();onSave(reason,evidence,true);}}>
  <label className="block">Основание передачи<input required maxLength={2000} className={input}
   value={reason} onChange={event=>setReason(event.target.value)}/></label>
  <label className="block">Физическое свидетельство передачи<input required maxLength={2000} className={input}
   value={evidence} onChange={event=>setEvidence(event.target.value)}/></label>
  <div className="flex flex-wrap gap-2">
   <button type="button" className={button} disabled={disabled||!reason.trim()||!evidence.trim()} onClick={()=>onSave(reason,evidence,false)}>Сохранить локально (без отправки)</button>
   <button className={button} disabled={disabled||!reason.trim()||!evidence.trim()}>Сохранить и отправить этот сорт</button>
  </div>
 </form>;
}
