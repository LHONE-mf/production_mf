import React,{useEffect,useRef,useState} from 'react';
import type {ServerConnection} from '../../core/sync/serverConnection';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import {loadAvailableAssemblyGrades,type AvailableAssemblyGrade} from '../../core/sync/assemblyEligibility';

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
 return <section aria-label="Проверка серверных электродов" className="min-w-0 space-y-3 rounded border border-slate-600 bg-slate-800 p-3 text-sm break-words">
  <h4 className="font-semibold">Серверные электроды Sorting → Assembly</h4>
  <p className="text-slate-300">Только чтение: укажите действующую партию ячеек Assembly, номер её шага и ID назначенного получателя из утверждённого маршрута. Сервер проверит каждый сорт отдельно. Этот список не резервирует электроды и не подтверждает физическую приёмку.</p>
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
   <p className="text-amber-200">Только проверено; передача и приёмка пока недоступны.</p>
  </article>)}
  {loaded&&after&&<button type="button" className={button} disabled={busy} onClick={()=>void refresh(true)}>Проверить следующие предложения</button>}
  {error&&<p role="alert" className="text-red-300">{error}</p>}
 </section>;
}
