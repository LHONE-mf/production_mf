import React,{useState} from 'react';
import type {HybridSession} from '../../core/sync/hybridClient';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import {loadWarehouseAccess} from '../../core/sync/inventoryCatalogClient';
import {inventoryRecoveryEvidence,latestInventoryRecoveryArchive,approveInventoryRecovery,applyInventoryRecovery,type InventoryRecoveryBundle} from '../../core/sync/inventoryRecovery';
export function InventoryRecoveryPanel({session,scope,localActorId,onReconciled}:{session:HybridSession;scope:InventoryScope;localActorId:string;onReconciled?:()=>void}){
 const [packet,setPacket]=useState<InventoryRecoveryBundle|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[chief,setChief]=useState(false);
 const [reason,setReason]=useState(''),[reference,setReference]=useState(''),[approvalId,setApprovalId]=useState('');
 const evidence=packet?JSON.stringify(packet,null,2):'';
 let own=false;try{own=!!packet&&inventoryScopeKey(packet.scope)===inventoryScopeKey(scope);}catch{/* Imported packages are validated before approval. */}
 async function run(work:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await work();}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function prepare(data:InventoryRecoveryBundle){setChief((await loadWarehouseAccess(session,scope)).level==='chief');setPacket(data);setApprovalId(crypto.randomUUID());setReason('');setReference('');}
 return <details className="border border-slate-600 rounded p-3"><summary className="min-h-11 py-2 cursor-pointer">Данные для сверки после восстановления</summary>
 <p>Сравните исходные запросы, подтверждения и старые остатки с восстановленным журналом и физическим учётом. Подтверждение Chief разрешает только обновить кэш. Неопределённые операции останутся на сверке; отправка склада возобновляется администратором отдельно.</p>
 <button type="button" className="min-h-11 px-3 bg-slate-700" disabled={busy} onClick={()=>void run(async()=>prepare(await inventoryRecoveryEvidence(session,scope,localActorId)))}>Подготовить пакет сверки</button>
 <button type="button" className="min-h-11 px-3" disabled={busy} onClick={()=>void run(async()=>{await prepare(await latestInventoryRecoveryArchive(session,scope));setMessage('Открыт сохранённый архив исходных данных.');})}>Открыть последний архив сверки</button>
 <label className="block">Пакет другого устройства для Chief<input aria-label="Импорт пакета сверки" type="file" accept="application/json,.json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void run(async()=>{if(file.size>2*1024*1024)throw Error('Пакет превышает 2 МБ');await prepare(JSON.parse(await file.text()));});event.target.value='';}}/></label>
 {packet&&<><label className="block">Пакет сверки (JSON)<textarea aria-label="Пакет сверки (JSON)" readOnly className="w-full min-h-40 bg-slate-900" value={evidence}/></label><a className="inline-flex min-h-11 items-center px-3 underline" href={'data:application/json;charset=utf-8,'+encodeURIComponent(evidence)} download="inventory-recovery.json">Сохранить пакет JSON</a>
 {chief&&<><label className="block">Результат сверки истории<input aria-label="Результат сверки истории" className="min-h-11 w-full bg-slate-900 p-2" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label><label className="block">Документ / свидетельство сверки<input aria-label="Документ / свидетельство сверки" className="min-h-11 w-full bg-slate-900 p-2" maxLength={2000} value={reference} onChange={e=>setReference(e.target.value)}/></label><button type="button" className="min-h-11 px-3" disabled={busy||!reason.trim()||!reference.trim()} onClick={()=>void run(async()=>{await approveInventoryRecovery(session,scope,packet,reason,reference,approvalId);setMessage('Подтверждение Chief записано. Примените его на исходном устройстве.');})}>Подтвердить сверку истории</button></>}
 {own&&<button type="button" className="min-h-11 px-3" disabled={busy} onClick={()=>void run(async()=>{const result=await applyInventoryRecovery(session,scope,localActorId,packet.evidenceDigest);setPacket(null);onReconciled?.();setMessage('Старые данные сохранены в архиве. Неопределённые операции удержаны для сверки. Обновите подтверждённые данные.'+(result.postingEnabled?'':' Отправка сервера приостановлена.'));})}>Применить подтверждённую сверку к кэшу</button>}
 </>}
 {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </details>;
}
