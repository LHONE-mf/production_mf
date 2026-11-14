import React,{useEffect,useRef,useState} from 'react';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryScope} from '../../core/sync/inventoryOutbox';
import type {InventoryMaterial} from '../../core/sync/inventoryCatalogClient';
import {inventoryAlertsCsv,loadInventoryAlerts,type InventoryAlertsPage,type InventoryAlertKind} from '../../core/sync/inventoryAlerts';

const descriptions:Record<InventoryAlertKind,string>={
 quarantine:'Карантин',blocked:'Заблокировано',expired:'Срок истёк',
 expiring:'Скоро истечёт',restricted:'Недоступно к использованию',low:'Низкий доступный остаток',
};
const control='block min-h-11 w-full rounded bg-slate-900 p-2';
export function InventoryAlertsPanel({scope,session,epoch,materials}:{
 scope:InventoryScope;session:HybridSession;epoch:string;materials:InventoryMaterial[];
}){
 const [materialId,setMaterialId]=useState(''),[days,setDays]=useState('30'),
  [quantity,setQuantity]=useState('0'),[showAll,setShowAll]=useState(false),
  [page,setPage]=useState<InventoryAlertsPage|null>(null),[busy,setBusy]=useState(false),
  [error,setError]=useState(''),[after,setAfter]=useState<string|undefined>();
 const run=useRef(0);
 const identity=[scope.serverUrl,scope.organizationId,scope.actorId,scope.deviceId,epoch].join(':');
 useEffect(()=>{run.current++;setPage(null);setAfter(undefined);setError('');setBusy(false);
  return()=>{run.current++;};},[identity,materialId,days,quantity,showAll]);
 async function refresh(next?:string){
  if(busy)return;
  const count=Number(quantity),warning=Number(days),token=++run.current;
  if(!Number.isSafeInteger(count)||count<0||!Number.isInteger(warning)||warning<0||warning>365||
      (count>0&&!materialId)){setError('Укажите материал для порога выше нуля и целые неотрицательные значения.');return;}
  setBusy(true);setError('');
  try{
   const result=await loadInventoryAlerts(session,scope,epoch,{
    after:next,expiryDays:warning,lowAvailable:count,materialId:materialId||undefined,
    view:showAll?'all':'alerts',limit:50,
   });
   if(token===run.current){setPage(result);setAfter(next);}
  }catch(e){if(token===run.current){setPage(null);setError('Не удалось загрузить подтверждённый отчёт: '+String(e));}}
  finally{if(token===run.current)setBusy(false);}
 }
 function download(){
  if(!page)return;
  const blob=new Blob([inventoryAlertsCsv(page)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download='production-mf-stock-alerts-page.csv';
  document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
 }
 return <details className="rounded border border-slate-600 p-3" aria-label="Предупреждения склада">
   <summary className="min-h-11 cursor-pointer py-2">Предупреждения и отчёт по остаткам</summary>
   <p className="my-2">Подтверждённый серверный снимок. Данные обновляются только по запросу. Порог задаётся разово в базовых единицах выбранного материала; это не сохранённое правило уведомлений. Учёт вне склада и будущий расход сюда не включаются.</p>
   <div className="grid gap-2 sm:grid-cols-2">
    <label>Материал для порога<select className={control} aria-label="Материал для предупреждений" value={materialId} onChange={e=>{setMaterialId(e.target.value);setQuantity('0');}}>
      <option value="">Все материалы (только нулевой порог)</option>
      {materials.map(m=><option value={m.id} key={m.id}>{m.code} · {m.name} · {m.baseUnit}</option>)}
    </select></label>
    <label>Низкий доступный остаток (базовых единиц)<input className={control} type="number" min="0" step="1" aria-label="Порог доступного остатка" disabled={!materialId} value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
    <label>Срок истекает в ближайшие дни<input className={control} type="number" min="0" max="365" step="1" aria-label="Дней до срока" value={days} onChange={e=>setDays(e.target.value)}/></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/>Показать все позиции (не только предупреждения)</label>
   </div>
   <button type="button" className="my-2 min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50" disabled={busy} onClick={()=>void refresh()}>{busy?'Загрузка…':'Сформировать отчёт'}</button>
   {error&&<p role="alert">{error}</p>}
   {page&&<section aria-label="Результат проверки остатков" className="space-y-2">
     <p>Снимок на {new Date(page.asOf).toLocaleString('ru-RU')} · Показано {page.items.length} позиций этой страницы. Пустая страница возможна, если предупреждения отфильтрованы.</p>
     {page.items.map(item=><article key={item.stock.stockId} className="rounded border border-slate-600 p-2">
      <p>{item.materialName} ({item.materialCode}) · {item.stock.manufacturerLot}</p>
      <p>Контейнер: {item.stock.stockId}</p>
      <p>Место: {item.locationLabel} · Доступно: {item.stock.available} {item.stock.unit} · Резерв: {item.stock.reserved} {item.stock.unit}</p>
      <p>{item.stock.expiresAt?'Годность до '+new Date(Date.parse(item.stock.expiresAt)-1).toLocaleDateString('ru-RU',{timeZone:'UTC'}):'Срок годности не указан'}</p>
      <p>{item.alerts.length?item.alerts.map(a=>descriptions[a]).join(' · '):'Предупреждений нет'}</p>
     </article>)}
     <p>CSV содержит только текущую проверенную страницу ({page.items.length} строк), не полный склад и не локальные черновики.</p>
     <div className="flex flex-wrap gap-2">
       <button type="button" className="min-h-11 rounded bg-blue-700 px-3" onClick={download}>Скачать CSV страницы</button>
       {after&&<button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={()=>void refresh()}>С начала</button>}
       {page.hasMore&&page.nextAfter&&<button type="button" className="min-h-11 rounded border px-3" disabled={busy} onClick={()=>void refresh(page.nextAfter!)}>Следующая страница</button>}
     </div>
   </section>}
 </details>;
}
