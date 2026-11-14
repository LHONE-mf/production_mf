import React,{useState}from'react';
import type{HybridSession}from'../../core/sync/hybridClient';import type{InventoryScope}from'../../core/sync/inventoryOutbox';
import{inventoryRecoveryEvidence}from'../../core/sync/inventoryRecovery';
export function InventoryRecoveryPanel({session,scope,localActorId}:{session:HybridSession;scope:InventoryScope;localActorId:string}){
 const [evidence,setEvidence]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <details className="border border-slate-600 rounded p-3"><summary className="min-h-11 py-2 cursor-pointer">Данные для сверки после восстановления</summary>
 <p>Пакет содержит исходные намерения и сохранённые подтверждения этого устройства. Он не меняет остатки и не разрешает повторную отправку. Администратор должен сравнить ID и точные запросы с серверным журналом.</p>
 <button type="button" className="min-h-11 px-3 bg-slate-700" disabled={busy} onClick={()=>{setBusy(true);setError('');void inventoryRecoveryEvidence(session,scope,localActorId).then(data=>setEvidence(JSON.stringify(data,null,2))).catch(e=>{setEvidence('');setError(String(e));}).finally(()=>setBusy(false));}}>Подготовить пакет сверки</button>
 {evidence&&<><label className="block">Пакет сверки (JSON)<textarea aria-label="Пакет сверки (JSON)" readOnly className="w-full min-h-40 bg-slate-900" value={evidence}/></label><a className="inline-flex min-h-11 items-center px-3 underline" href={'data:application/json;charset=utf-8,'+encodeURIComponent(evidence)} download="inventory-recovery.json">Сохранить пакет JSON</a></>}
 {error&&<p role="alert">{error}</p>}
 </details>;
}
