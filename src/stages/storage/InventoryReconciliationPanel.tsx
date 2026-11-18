import React,{useEffect,useRef,useState} from 'react';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryScope} from '../../core/sync/inventoryOutbox';
import type {InventoryMaterial} from '../../core/sync/inventoryCatalogClient';
import {collectIssueReconciliation,issueReconciliationCsv,loadIssueReconciliation,
 type ReconciliationFilters,type ReconciliationPage} from '../../core/sync/inventoryReconciliation';

const cls='block min-h-11 w-full rounded bg-slate-900 p-2';
export function InventoryReconciliationPanel({scope,session,epoch,materials}:{
 scope:InventoryScope;session:HybridSession;epoch:string;materials:InventoryMaterial[];
}){
 const [draft,setDraft]=useState({productionBatchId:'',recipientId:'',materialId:'',stockId:''});
 const [active,setActive]=useState<ReconciliationFilters>({});
 const [page,setPage]=useState<ReconciliationPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),identity=[scope.serverUrl,scope.organizationId,scope.actorId,scope.deviceId,epoch].join('|');
 useEffect(()=>{generation.current++;setPage(null);setBusy(false);setError('');return()=>{generation.current++;};},[identity]);
 function edit(key:keyof typeof draft,value:string){
  generation.current++;setPage(null);setBusy(false);setError('');setDraft(old=>({...old,[key]:value}));
 }
 async function load(next=false){
  if(busy)return;
  const filters=next?active:Object.fromEntries(Object.entries(draft).filter(([,v])=>v.trim()).map(([k,v])=>[k,v.trim()]));
  const token=++generation.current;setBusy(true);setError('');
  try{
   const result=await loadIssueReconciliation(session,scope,epoch,{...filters,
    ...(next&&page?{after:page.nextAfter!,untilIssue:page.throughIssueSequence,untilOutcome:page.throughOutcomeSequence}:{})});
   if(token===generation.current){setPage(result);setActive(filters);}
  }catch(cause){if(token===generation.current){setPage(null);setError('Сверка недоступна: '+String(cause));}}
  finally{if(token===generation.current)setBusy(false);}
 }
 function download(result:ReconciliationPage,name:string){
  const url=URL.createObjectURL(new Blob([issueReconciliationCsv(result)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
 }
 async function full(){
  if(busy||!page)return;
  const token=++generation.current;setBusy(true);setError('');
  try{
   const result=await collectIssueReconciliation(after=>loadIssueReconciliation(session,scope,epoch,{
    ...active,after,limit:100,untilIssue:page.throughIssueSequence,untilOutcome:page.throughOutcomeSequence,
   }),page);
   if(token===generation.current)download(result,'production-mf-issue-reconciliation-snapshot.csv');
  }catch(cause){if(token===generation.current)setError('Выгрузка отменена без неполного файла: '+String(cause));}
  finally{if(token===generation.current)setBusy(false);}
 }
 return <details className="rounded border border-slate-600 p-3" aria-label="Сверка выданных материалов">
  <summary className="min-h-11 cursor-pointer py-2">Сверка выдач · возврат · списание · расход</summary>
  <p>Только физически выданные и принятые получателем материалы. При отсутствии навесок расход НЕ ЗАПИСАН. Расход показывается только по подтверждённым навескам. Неразнесённое количество = принято − возвращено − списано − подтверждённый расход; оно не подтверждает, что материал остался неиспользованным.</p>
  <div className="grid gap-2 sm:grid-cols-2">
   <label>Материал<select className={cls} aria-label="Материал сверки выдач" value={draft.materialId} onChange={e=>edit('materialId',e.target.value)}>
    <option value="">Все материалы</option>{materials.map(m=><option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
   </select></label>
   {([['productionBatchId','Партия производства для сверки'],['recipientId','Получатель для сверки'],['stockId','Исходный контейнер для сверки']] as const).map(([key,label])=>
    <label key={key}>{label} (UUID)<input className={cls} aria-label={label} value={draft[key]} onChange={e=>edit(key,e.target.value)} placeholder="Без фильтра"/></label>)}
  </div>
  <button type="button" className="my-2 min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50" disabled={busy} onClick={()=>void load()}>Показать сверку выдач</button>
  {error&&!page&&<p role="alert">{error}</p>}
  {page&&<section aria-label="Результат сверки выдач" className="space-y-2 break-words">
   <p>История {page.epoch} · события выдач до № {page.throughIssueSequence}, возврата/списания до № {page.throughOutcomeSequence}. Названия справочников текущие; количества и связи исторические.</p>
   {page.items.map(row=><div role="group" aria-label={'Сверка выдачи '+row.issueId} key={row.issueId} className="rounded border border-slate-600 p-2">
    <p>{row.materialName} · {row.materialCode} · партия производителя {row.manufacturerLot}</p>
    <p>Партия {row.batchCode} ({row.productionBatchId}) · шаг {row.stepNumber} · получатель {row.recipientName} ({row.recipientId})</p>
    <p>Выдача {row.issueId} · исходный контейнер {row.stockId}</p>
    <p>Принято: {row.issued} · Возвращено: {row.returned} · Списано из выдачи: {row.scrapped} · Неразнесено: {row.outstanding} {row.unit}</p>
    <p>Фактический расход: {row.consumed===null?'НЕ ЗАПИСАН':row.consumed+' '+row.unit}. Выдача не является измерением расхода.</p>
   </div>)}
   {!page.items.length&&<p>Принятых выдач в выбранной области нет.</p>}
   <p>CSV содержит выбранную страницу или весь фиксированный срез до 10 000 выдач. При ошибке или превышении лимита полный файл не создаётся.</p>
   <div className="flex flex-wrap gap-2">
    {error&&<p role="alert" className="w-full">{error}</p>}
    <button type="button" className="min-h-11 rounded bg-blue-700 px-3" onClick={()=>download(page,'production-mf-issue-reconciliation-page.csv')}>Скачать CSV страницы сверки</button>
    <button type="button" disabled={busy} className="min-h-11 rounded border px-3" onClick={()=>void full()}>Скачать весь срез сверки</button>
    {page.hasMore&&<button type="button" disabled={busy} className="min-h-11 rounded border px-3" onClick={()=>void load(true)}>Следующая страница сверки</button>}
   </div>
  </section>}
 </details>;
}
