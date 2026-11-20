import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import type {ServerConnection} from '../../core/sync/serverConnection';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import {assemblyDrafts,freezeAssemblyReceipt,loadAssemblyHandoffs,sendAssemblyDraft,
 type AssemblyHandoff,type AssemblyHandoffListing} from '../../core/sync/assemblyTransfers';

const input='w-full min-w-0 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white';
const button='min-h-11 rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50';

export function AssemblyPhysicalReceipts({connection}:{connection:ServerConnection|null}){
 if(!connection)return null;
 const scope:InventoryScope={serverUrl:connection.serverUrl,organizationId:connection.organizationId,
  actorId:connection.serverActorId,deviceId:connection.selectedDeviceId};
 return <AssemblyReceiptsPanel key={inventoryScopeKey(scope)+':'+connection.session.deviceProofExpiresAt}
  connection={connection} scope={scope}/>;
}

function AssemblyReceiptsPanel({connection,scope}:{connection:ServerConnection;scope:InventoryScope}){
 const drafts=useLiveQuery(()=>assemblyDrafts(scope,'receive'),[inventoryScopeKey(scope)])??[];
 const [items,setItems]=useState<AssemblyHandoffListing[]>([]);
 const [after,setAfter]=useState<string|null>(null);
 const [epoch,setEpoch]=useState<string>();
 const [loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const running=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function work(task:()=>Promise<void>){
  if(running.current)return;
  running.current=true;setBusy(true);setError('');
  try{await task();}catch(cause){
   if(alive.current){setError(cause instanceof Error?cause.message:String(cause));setItems([]);setAfter(null);setEpoch(undefined);setLoaded(false);}
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function refresh(next=false){
  const page=await loadAssemblyHandoffs(connection.session,scope,next?epoch:undefined,
   next?after??undefined:undefined);
  if(alive.current){
   setItems(previous=>next?[...previous,...page.items]:page.items);
   setAfter(page.nextAfter);setEpoch(page.epoch);setLoaded(true);
  }
 }
 async function receive(handoff:AssemblyHandoff,observed:number,reason:string,evidence:string){
  await work(async()=>{
   const frozen=await freezeAssemblyReceipt(scope,epoch!,handoff,observed,reason,evidence);
   await sendAssemblyDraft(connection.session,scope,frozen.key);
   if(alive.current){setItems([]);setAfter(null);setLoaded(false);setEpoch(undefined);}
  });
 }
 async function retry(key:string){await work(async()=>{await sendAssemblyDraft(connection.session,scope,key);
  if(alive.current){setItems([]);setAfter(null);setLoaded(false);setEpoch(undefined);}});}
 return <section aria-label="Физическая приёмка Assembly" className="min-w-0 space-y-3 rounded border border-slate-600 bg-slate-800 p-3 text-sm break-words">
  <h4 className="font-semibold">Назначенные мне передачи электродов</h4>
  <p>Сервер показывает только передачи, адресованные текущему участнику. Получатель физически пересчитывает полный сорт, записывает основание и подтверждает приёмку отдельно. Качество QA остаётся непроверенным; складской остаток не создаётся.</p>
  <button className={button} disabled={busy} onClick={()=>void work(()=>refresh())}>Загрузить мои передачи</button>
  {loaded&&items.length===0&&<p>Передач для этого получателя нет.</p>}
  {items.map(({handoff,received})=>{
   const saved=drafts.find(d=>{try{return JSON.parse(d.fields.request).handoffId===handoff.operationId;}catch{return false;}});
   return <article key={handoff.operationId} className="space-y-2 rounded border border-slate-600 p-2">
    <p className="font-semibold">Сорт {handoff.grade} · заявлено {handoff.quantity} шт.</p>
    <p>Серверная партия Assembly {handoff.assemblyBatchId} · шаг {handoff.assemblyStepNumber}</p>
    <p>Передача {handoff.operationId} · источник Sorting {handoff.submissionId}</p>
    <p>Оригинальная маркировка: production:{handoff.submissionId}:{handoff.grade}</p>
    {received?<p>Физическая приёмка подтверждена сервером: {received.operationId}</p>:
     saved?<p>Для передачи уже сохранён исходный подсчёт ({saved.fields.state}); действия ниже.</p>:
     <PhysicalCountForm disabled={busy} onSave={(n,reason,evidence)=>void receive(handoff,n,reason,evidence)}/>}
   </article>;
  })}
  {loaded&&after&&<button className={button} disabled={busy} onClick={()=>void work(()=>refresh(true))}>Следующие передачи</button>}
  <h5 className="font-semibold">Сохранённые физические подсчёты</h5>
  {drafts.map(d=><article key={d.key} className="space-y-1 rounded border border-slate-600 p-2">
   <p>Операция {d.operationId} · {d.fields.state==='accepted'?'Принято сервером':d.fields.state==='pending'?'Ожидает отправки / точного повтора':'Конфликт; требуется сверка'}</p>
   {d.fields.state==='pending'&&<button className={button} disabled={busy} onClick={()=>void retry(d.key)}>Повторить исходный ID приёмки</button>}
   <details><summary>Исходный подсчёт и подтверждение</summary>
    <pre className="whitespace-pre-wrap break-all text-xs">{d.fields.request}{'\n'}{d.fields.acknowledgement}</pre>
   </details>
  </article>)}
  {error&&<p role="alert" className="text-red-300">{error}</p>}
 </section>;
}
function PhysicalCountForm({disabled,onSave}:{disabled:boolean;onSave:(quantity:number,reason:string,evidence:string)=>void}){
 const [quantity,setQuantity]=useState(''),[reason,setReason]=useState(''),[evidence,setEvidence]=useState('');
 return <form className="space-y-2" onSubmit={event=>{event.preventDefault();onSave(Number(quantity),reason,evidence);}}>
  <label className="block">Фактически пересчитано, шт.
   <input aria-label="Фактически пересчитано, шт." required inputMode="numeric" type="number" min="1" step="1" className={input}
    value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>
  <label className="block">Основание приёмки
   <input required maxLength={2000} className={input} value={reason} onChange={event=>setReason(event.target.value)}/></label>
  <label className="block">Свидетельство физического подсчёта
   <input required maxLength={2000} className={input} value={evidence} onChange={event=>setEvidence(event.target.value)}/></label>
  <button className={button} disabled={disabled}>Сохранить и подтвердить физическую приёмку</button>
 </form>;
}
