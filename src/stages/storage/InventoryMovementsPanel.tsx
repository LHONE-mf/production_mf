import React,{useEffect,useRef,useState} from 'react';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryScope} from '../../core/sync/inventoryOutbox';
import type {InventoryMaterial} from '../../core/sync/inventoryCatalogClient';
import {inventoryMovementsCsv,loadInventoryMovements,
 type MovementFilters,type MovementPage} from '../../core/sync/inventoryMovements';

const cls='block min-h-11 w-full rounded bg-slate-900 p-2';
const actions=[
 ['','Все движения'],['receive','Приёмка'],['quality_change','Решение Chief по QA'],
 ['reserve','Резерв'],['release_reservation','Снятие резерва'],
 ['issue','Физическая выдача (не расход)'],['return','Возврат'],
 ['transfer','Перемещение'],['adjust','Коррекция'],
 ['count_adjustment','Коррекция по инвентаризации'],
 ['split_in','Разделение: новая упаковка'],['split_out','Разделение: исходная упаковка'],
 ['scrap','Списание'],
] as const;
export function InventoryMovementsPanel({scope,session,epoch,materials}:{
 scope:InventoryScope;session:HybridSession;epoch:string;materials:InventoryMaterial[];
}){
 const [draft,setDraft]=useState({materialId:'',stockId:'',kind:'',from:'',through:''});
 const [active,setActive]=useState<MovementFilters|null>(null);
 const [page,setPage]=useState<MovementPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),identity=[scope.serverUrl,scope.organizationId,scope.actorId,scope.deviceId,epoch].join('|');
 useEffect(()=>{generation.current++;setActive(null);setPage(null);setBusy(false);setError('');return()=>{generation.current++;};},[identity]);
 function edit(key:keyof typeof draft,value:string){
  generation.current++;setBusy(false);setError('');setActive(null);setPage(null);
  setDraft(old=>({...old,[key]:value}));
 }
 async function load(next=false){
  if(busy)return;
  const filters:MovementFilters=next&&active?active:{
   ...(draft.materialId?{materialId:draft.materialId}:{}),
   ...(draft.stockId.trim()?{stockId:draft.stockId.trim()}:{}),
   ...(draft.kind?{kind:draft.kind}:{}),
   ...(draft.from?{from:draft.from}:{}),
   ...(draft.through?{through:draft.through}:{}),
  };
  if(filters.from&&filters.through&&filters.from>filters.through){
   setError('Дата окончания раньше даты начала.');return;
  }
  const token=++generation.current;
  setBusy(true);setError('');
  try{
   const result=await loadInventoryMovements(session,scope,epoch,{
    ...filters,...(next&&page?{after:page.nextAfter,until:page.throughSequence}:{}),
    limit:50,
   });
   if(token===generation.current){setActive(filters);setPage(result);}
  }catch(cause){if(token===generation.current){setPage(null);setError('Не удалось получить журнал: '+String(cause));}}
  finally{if(token===generation.current)setBusy(false);}
 }
 function download(){
  if(!page)return;
  const blob=new Blob([inventoryMovementsCsv(page)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='production-mf-movements-page.csv';
  document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
 }
 return <details className="rounded border border-slate-600 p-3" aria-label="Журнал движений склада">
  <summary className="min-h-11 cursor-pointer py-2">История движений · подтверждённый серверный журнал</summary>
  <p>Журнал не включает локальные черновики, наблюдения без подтверждения, а также ещё не реализованный фактический расход в Slurry. Выдача и расход — разные события.</p>
  <div className="grid gap-2 sm:grid-cols-2">
   <label>Материал<select className={cls} value={draft.materialId} aria-label="Фильтр журнала по материалу" onChange={e=>edit('materialId',e.target.value)}>
    <option value="">Все материалы</option>
    {materials.map(m=><option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
   </select></label>
   <label>Тип события<select className={cls} value={draft.kind} aria-label="Фильтр по типу движения" onChange={e=>edit('kind',e.target.value)}>
    {actions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
   <label>Контейнер (UUID)<input className={cls} aria-label="Фильтр журнала по контейнеру" value={draft.stockId} onChange={e=>edit('stockId',e.target.value)} placeholder="Без фильтра"/></label>
   <label>Начальная дата (UTC)<input type="date" className={cls} aria-label="События с даты" value={draft.from} onChange={e=>edit('from',e.target.value)}/></label>
   <label>Конечная дата включительно (UTC)<input type="date" className={cls} aria-label="События по дату" value={draft.through} onChange={e=>edit('through',e.target.value)}/></label>
  </div>
  <button type="button" disabled={busy} className="my-2 min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50" onClick={()=>void load()}>{busy?'Загрузка…':'Показать журнал'}</button>
  {error&&<p role="alert">{error}</p>}
  {page&&<section aria-label="Результат журнала движений" className="space-y-2">
   <p>Подтверждённые события до № {page.throughSequence}; текущая страница: {page.items.length} записей. Последующие изменения не добавляются в этот просмотр.</p>
   {page.items.map(item=><div role="group" aria-label={'Операция склада '+item.operationId} key={item.sequence} className="rounded border border-slate-600 p-2">
    <p>№ {item.sequence} · {new Date(item.recordedAt).toLocaleString('ru-RU')} · {item.kind}</p>
    <p>{item.materialName??'Материал не указан'} · {item.materialCode??''} · {item.manufacturerLot??''}</p>
    <p>Контейнер {item.stockId} · {item.quantity} {item.unit??'ед.'} · партия производства {item.productionBatchId??'не указана'}</p>
    <p>Основание: {item.reason} · Автор: {item.actorId}</p>
   </div>)}
   {!page.items.length&&<p>Записей в выбранной области нет.</p>}
   <p>CSV экспортирует только показанную проверенную страницу. Полный отчёт требует выгрузки всех страниц в рамках одной истории и времени среза.</p>
   <div className="flex flex-wrap gap-2">
    <button type="button" className="min-h-11 rounded bg-blue-700 px-3" onClick={download}>Скачать CSV страницы журнала</button>
    {page.hasMore&&<button type="button" disabled={busy} className="min-h-11 rounded border px-3" onClick={()=>void load(true)}>Следующая страница</button>}
   </div>
  </section>}
 </details>;
}
