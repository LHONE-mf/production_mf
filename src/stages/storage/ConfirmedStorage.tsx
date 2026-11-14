import React,{useEffect,useRef,useState} from 'react';
import {useServerConnection} from '../../core/sync/serverConnection';
import {requireFreshDeviceProof} from '../../core/sync/deviceProofClient';
import {useAuthStore} from '../../core/store/authStore';
import {loadWarehouseAccess,loadInventoryMaterials,loadInventoryLocations} from '../../core/sync/inventoryCatalogClient';
import {pullInventoryChanges} from '../../core/sync/inventoryClient';
import {confirmedInventoryForScope,inventoryQueueForScope,inventoryScopeKey,type ConfirmedInventoryStock} from '../../core/sync/inventoryOutbox';
import {inventoryStockQueueForScope} from '../../core/sync/inventoryStockOutbox';

export function ConfirmedStorage(){
 const connection=useServerConnection(),user=useAuthStore(s=>s.currentUser);
 const [now,setNow]=useState(Date.now()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[search,setSearch]=useState('');
 const [view,setView]=useState<{key:string;at:number;stocks:ConfirmedInventoryStock[];names:Record<string,string>;locations:Record<string,string>;queue:{id:string;state:string;kind:string;error?:string}[]}|null>(null);
 const generation=useRef(0);
 const scope=connection?{serverUrl:connection.serverUrl,organizationId:connection.organizationId,actorId:connection.serverActorId,deviceId:connection.selectedDeviceId}:null;
 let key='',proven=false;
 try{if(scope&&connection){key=inventoryScopeKey(scope)+'::'+(user?.id??'');proven=requireFreshDeviceProof(connection.session).deviceId===scope.deviceId;}}catch{/* Connect through the existing Sync screen. */}
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{generation.current++;setView(null);setError('');setBusy(false);return()=>{generation.current++;};},[key,connection]);
 const fresh=proven&&!!connection&&now<(connection.session.deviceProofExpiresAt??0)-5000;
 const visible=fresh&&view?.key===key?view:null;
 async function refresh(){
  if(!scope||!connection||!fresh||busy)return;
  const run=++generation.current;setBusy(true);setError('');
  try{
   await loadWarehouseAccess(connection.session,scope);
   const names:Record<string,string>={},locations:Record<string,string>={};
   for(const [load,target,label] of [[loadInventoryMaterials,names,'name'],[loadInventoryLocations,locations,'label']] as const){
    let after:string|undefined;
    for(let page=0;page<100;page++){
     const result=await load(connection.session,scope,after,100);
     for(const row of result.items)target[row.id]=label==='name'?(row as {name:string}).name:(row as {label:string}).label;
     if(!result.hasMore)break;
     if(page===99)throw Error('Каталог слишком большой. Требуется уточнение области доступа.');
     after=result.nextAfter!;
    }
   }
   for(let page=0;page<100;page++){
    if(run!==generation.current)return;
    const result=await pullInventoryChanges(connection.session,scope,100);
    if(!result.hasMore)break;
    if(page===99)throw Error('История ещё загружается. Повторите обновление.');
   }
   const [stocks,receipts,operations]=await Promise.all([confirmedInventoryForScope(scope),inventoryQueueForScope(scope),inventoryStockQueueForScope(scope)]);
   if(run!==generation.current)return;
   setView({key,at:Date.now(),stocks,names,locations,queue:[...receipts.map(r=>({id:r.operationId,state:r.state,kind:'Приёмка',error:r.error})),...operations.map(r=>({id:r.operationId,state:r.state,kind:r.request.kind,error:r.error}))]});
  }catch(e){if(run===generation.current){setView(null);setError('Обновление недоступно. Проверьте подключение, сеанс и полномочия в разделе Синхронизация. '+(e instanceof Error?e.message:''));}}
  finally{if(run===generation.current)setBusy(false);}
 }
 return <section aria-label="Подтверждённый склад" className="min-w-0 space-y-3 rounded-lg bg-slate-800 p-3 break-words">
  <h3 className="font-semibold">Подтверждённый склад</h3>
  {!connection?<p>Сервер не подключён. Войдите на сервер в разделе Синхронизация.</p>:!fresh?<p>Требуется проверка устройства в разделе Синхронизация. Сохранённая очередь остаётся на устройстве.</p>:<>
   <p>Обновление читает серверные данные. Операции отправляются только после отдельного подтверждения.</p>
   <button type="button" className="min-h-11 rounded bg-blue-700 px-3" disabled={busy} onClick={()=>void refresh()}>{busy?'Загрузка…':'Обновить подтверждённые данные'}</button>
   {!visible&&!busy&&!error&&<p>Данные ещё не загружены. Нажмите обновление.</p>}
   {visible&&<>
    <p>Последняя успешная синхронизация: {new Date(visible.at).toLocaleString('ru-RU')}. Последние известные остатки; изменения на других устройствах требуют обновления.</p>
    <label className="block">Поиск материала, партии, места<input className="block min-h-11 w-full rounded bg-slate-900 p-2" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    {!visible.stocks.length&&<p>Подтверждённых остатков пока нет.</p>}
    {visible.stocks.filter(s=>[s.manufacturerLot,s.stockId,visible.names[s.materialId],visible.locations[s.locationId],s.quality].join(' ').toLowerCase().includes(search.toLowerCase())).map(s=><article className="rounded border border-slate-600 p-3" key={s.stockId}>
     <p>{visible.names[s.materialId]??s.materialId} · Партия производителя: {s.manufacturerLot}</p><p>Контейнер: {s.stockId}</p><p>Место: {visible.locations[s.locationId]??s.locationId}</p>
     <p>Качество: {s.quality==='quarantine'?'Карантин':s.quality==='released'?'Разрешено':'Заблокировано'} · Версия {s.revision}</p>
     <p>На руках: {s.onHand} {s.unit} · Резерв: {s.reserved} {s.unit} · Свободно по количеству: {s.available} {s.unit}</p><p>Карантин и блокировка запрещают использование в производстве.</p>
    </article>)}
    <h4>Операции / Синхронизация ({visible.queue.length})</h4>
    <p>Предложения не меняют подтверждённые остатки.</p>
    {visible.queue.map(q=><p key={q.id}>{q.kind} · {q.id} · {q.state==='pending'?'Ожидает отправки':q.state==='conflict'?'Конфликт':'Отклонено'} {q.error}</p>)}
   </>}
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
