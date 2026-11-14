import React,{useEffect,useRef,useState} from 'react';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryScope} from '../../core/sync/inventoryOutbox';
import {loadMaterialBalances,materialBalancesCsv,type MaterialBalancePage} from '../../core/sync/inventoryMaterialSummary';
const cls='block min-h-11 w-full rounded bg-slate-900 p-2';
export function InventoryMaterialSummaryPanel({scope,session,epoch}:{
 scope:InventoryScope;session:HybridSession;epoch:string;
}){
 const [days,setDays]=useState('30'),[page,setPage]=useState<MaterialBalancePage|null>(null),
  [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const run=useRef(0),identity=[scope.serverUrl,scope.organizationId,scope.actorId,scope.deviceId,epoch].join('|');
 useEffect(()=>{run.current++;setPage(null);setBusy(false);setError('');return()=>{run.current++;};},[identity]);
 async function load(after?:string){
  if(busy)return;
  const value=Number(days);
  if(!Number.isInteger(value)||value<0||value>365){setError('Количество дней должно быть целым от 0 до 365.');return;}
  const token=++run.current;setBusy(true);setError('');
  try{
   const result=await loadMaterialBalances(session,scope,epoch,value,after,50);
   if(token===run.current)setPage(result);
  }catch(cause){if(token===run.current){setPage(null);setError('Сводка недоступна: '+String(cause));}}
  finally{if(token===run.current)setBusy(false);}
 }
 function download(){
  if(!page)return;
  const blob=new Blob([materialBalancesCsv(page)],{type:'text/csv;charset=utf-8'}),
   url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='production-mf-material-balances-page.csv';
  document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
 }
 return <details className="rounded border border-slate-600 p-3" aria-label="Материальная сводка склада">
  <summary className="min-h-11 cursor-pointer py-2">Сводка по материалам · физический и пригодный остаток</summary>
  <p>Суммы рассчитаны на сервере по подтверждённым контейнерам в базовых единицах каждого материала. Пригодный остаток дополнительно учитывает QA, срок, резервы и ограничения исходных упаковок. Не включены незавершённые движения и расход в Slurry.</p>
  <label>Период предупреждения об окончании срока (дней)
   <input className={cls} aria-label="Дней до истечения для сводки" type="number" step="1" min="0" max="365"
     value={days} onChange={e=>{run.current++;setDays(e.target.value);setPage(null);setBusy(false);}}/>
  </label>
  <button type="button" className="my-2 min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50"
   disabled={busy} onClick={()=>void load()}>{busy?'Загрузка…':'Загрузить сводку материалов'}</button>
  {error&&<p role="alert">{error}</p>}
  {page&&<section aria-label="Результат материальной сводки" className="space-y-2">
   <p>Состояние на {new Date(page.asOf).toLocaleString('ru-RU')} · {page.items.length} материалов на странице.</p>
   {page.items.map(row=><div role="group" aria-label={'Баланс материала '+row.materialId} key={row.materialId}
      className="rounded border border-slate-600 p-2">
    <p>{row.name} ({row.code}) · {row.unit} · {row.active?'Активен':'Неактивен'}</p>
    <p>Физически: {row.onHand} · Резерв: {row.reserved} · Без резерва: {row.physicallyUnreserved}</p>
    <p>Пригодно для производства: {row.eligibleAvailable} · Карантин: {row.quarantined} · Заблокировано: {row.blocked} · Просрочено: {row.expired}</p>
    <p>Упаковок: {row.packageCount} · Партий производителя: {row.manufacturerLots} · Истекающих упаковок: {row.expiringPackages}</p>
   </div>)}
   <div className="flex flex-wrap gap-2">
    <button type="button" className="min-h-11 rounded bg-blue-700 px-3" onClick={download}>Скачать CSV страницы сводки</button>
    {page.hasMore&&page.nextAfter&&<button type="button" disabled={busy} className="min-h-11 rounded border px-3" onClick={()=>void load(page.nextAfter!)}>Следующая страница материалов</button>}
   </div>
  </section>}
 </details>;
}
