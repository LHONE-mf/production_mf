import React,{useState,useEffect}from'react';
import{useAuthStore,currentLocalSession}from'../../core/store/authStore';
import{loadInventoryOfflineView,validInventoryOfflineView,invalidateInventoryOfflineViews,type InventoryOfflineView}from'../../core/sync/inventoryOfflineView';
import{inventoryScopeKey,confirmedInventoryForScope,inventoryQueueForScope,validateInventoryStock,type InventoryScope,type ConfirmedInventoryStock}from'../../core/sync/inventoryOutbox';
import{inventoryStockQueueForScope}from'../../core/sync/inventoryStockOutbox';
import{inventoryLocationPath}from'../../core/sync/inventoryCatalogClient';
import{ReceivingForm}from'./ReceivingForm';
import{StockChangeForm}from'./StockChangeForm';
export function OfflineStorage({now,liveScope}:{now:number;liveScope?:InventoryScope}){
 const user=useAuthStore(s=>s.currentUser),login=useAuthStore(s=>s.session);
 const [view,setView]=useState<InventoryOfflineView|null>(null),[stocks,setStocks]=useState<ConfirmedInventoryStock[]>([]),[pending,setPending]=useState<{id:string;state:string;reason:string;error?:string}[]>([]),[error,setError]=useState('');
 useEffect(()=>{if(view&&(view.expiresAt<=now||view.issuedAt>now+120000)){void invalidateInventoryOfflineViews();setView(null);setError('Сохранённый доступ истёк или время устройства изменилось. Очередь сохранена.');}},[view,now]);
 const usable=!!user&&!!login&&currentLocalSession(login,now)&&login.userId===user.id;
 const visible=usable&&view?.localActorId===user.id&&view.localSessionIssuedAt===login.issuedAt&&validInventoryOfflineView(view,user.id,login.issuedAt,now)&&(!liveScope||view.scopeKey===inventoryScopeKey(liveScope))?view:null;
 async function open(){
  if(!usable||!user||!login)return;
  try{
   const saved=await loadInventoryOfflineView(user.id,login.issuedAt,now);
   if(!saved||liveScope&&saved.scopeKey!==inventoryScopeKey(liveScope))throw Error('Сохранённый доступ отсутствует или истёк. Подключитесь к серверу и обновите склад.');
   const rows=await confirmedInventoryForScope(saved.scope);for(const stock of rows)validateInventoryStock(stock);
   const receipts=await inventoryQueueForScope(saved.scope),operations=await inventoryStockQueueForScope(saved.scope);
   // Recheck the current profile after asynchronous IndexedDB reads.
   if(useAuthStore.getState().currentUser?.id!==user.id||useAuthStore.getState().session?.issuedAt!==login.issuedAt)return;
   setView(saved);setStocks(rows);setPending([...receipts.map(r=>({id:r.operationId,state:r.state,reason:r.request.reason,error:r.error})),...operations.map(r=>({id:r.operationId,state:r.state,reason:r.request.reason,error:r.error}))]);setError('');
  }catch(e){setView(null);setError(String(e));}
 }
 if(!usable)return null;
 return <section aria-label="Сохранённый офлайн-склад" className="space-y-3 border border-slate-600 rounded p-3">
 <button className="min-h-11 bg-slate-700 px-3" onClick={()=>void open()}>Открыть сохранённый склад</button>
 {visible&&<><p>Офлайн: последние известные данные от {new Date(visible.syncedAt).toLocaleString('ru-RU')}. Сервер {visible.scope.serverUrl}; организация {visible.scope.organizationId}; устройство {visible.scope.deviceId}. Доступ до {new Date(visible.expiresAt).toLocaleString('ru-RU')}.</p><p>Офлайн-предложения не подтверждают физическое движение и не меняют общие остатки. Для отправки войдите на исходный сервер и заново подтвердите устройство.</p>
 {!stocks.length&&<p>Последний подтверждённый снимок был пустым.</p>}
 {stocks.map(stock=><article key={stock.stockId} className="border rounded p-2 break-words"><p>{visible.materials.find(m=>m.id===stock.materialId)?.name??stock.materialId} · Партия {stock.manufacturerLot} · Контейнер {stock.stockId}</p><p>{inventoryLocationPath(visible.locations,stock.locationId)} · {stock.quality==='quarantine'?'Карантин':stock.quality==='released'?'Разрешено':'Заблокировано'} · Версия {stock.revision}</p><p>Последний известный остаток: {stock.onHand} {stock.unit}; резерв: {stock.reserved} {stock.unit}; свободно по количеству: {stock.available} {stock.unit}</p><StockChangeForm scope={visible.scope} session={{serverUrl:visible.scope.serverUrl,accessToken:'',deviceProofDeviceId:visible.scope.deviceId,offlineEditExpiresAt:visible.expiresAt}} localActorId={user!.id} stock={stock} locations={visible.locations} canCorrect={visible.access.canCorrectStock} materialName={visible.materials.find(m=>m.id===stock.materialId)?.name} sourceLocationName={inventoryLocationPath(visible.locations,stock.locationId)} onQueued={()=>void open()}/></article>)}
 <button className="min-h-11 px-3" onClick={()=>{void invalidateInventoryOfflineViews();setView(null);setError('Офлайн-доступ закрыт на этом устройстве. Очередь и черновики сохранены.');}}>Закрыть сохранённый доступ</button>
 <h4>Сохранённая очередь ({pending.length})</h4>{pending.map(row=><p className="break-words" key={row.id}>{row.id} · {row.state==='pending'?'Ожидает сервера':row.state==='conflict'?'Конфликт':'Отклонено'} · {row.reason} · {row.error}</p>)}
 <ReceivingForm scope={visible.scope} session={{serverUrl:visible.scope.serverUrl,accessToken:'',deviceProofDeviceId:visible.scope.deviceId,offlineEditExpiresAt:visible.expiresAt}} localActorId={user!.id} materials={visible.materials} locations={visible.locations} onQueued={()=>void open()}/>
 </>}
 {view&&!visible&&<p>Сохранённый доступ истёк или отозван. Очередь и черновики сохранены.</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
