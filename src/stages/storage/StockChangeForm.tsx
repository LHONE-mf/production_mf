import React,{useEffect,useRef,useState} from 'react';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope,type InventoryStockSnapshot,type ReceivingDraft} from '../../core/sync/inventoryOutbox';
import {saveReceivingDraft,freezeStockDraft,toInventoryBaseUnits} from '../../core/sync/inventoryReceiving';
import type {InventoryStockChangeDraft} from '../../core/sync/inventoryStockOutbox';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryLocation} from '../../core/sync/inventoryCatalogClient';

export function StockChangeForm(props:{scope:InventoryScope;session:HybridSession;localActorId:string;stock:InventoryStockSnapshot;locations:InventoryLocation[];canCorrect:boolean;onQueued:()=>void}){
 const key=JSON.stringify([inventoryScopeKey(props.scope),props.localActorId,'stock',props.stock.stockId]);
 return <ScopedStockChange key={key} {...props} draftKey={key}/>;
}
function ScopedStockChange({scope,session,stock,locations,canCorrect,onQueued,draftKey}:{scope:InventoryScope;session:HybridSession;stock:InventoryStockSnapshot;locations:InventoryLocation[];canCorrect:boolean;localActorId:string;onQueued:()=>void;draftKey:string}){
 const [draft,setDraft]=useState<ReceivingDraft>(),[error,setError]=useState(''),[preview,setPreview]=useState<Extract<InventoryStockChangeDraft,{kind:'transfer'|'adjust'}>>(),[busy,setBusy]=useState(false),[restart,setRestart]=useState(false);
 const row=useRef<ReceivingDraft>(),chain=useRef(Promise.resolve()),alive=useRef(true),failed=useRef(false),locked=useRef(false);
 useEffect(()=>{alive.current=true;void(async()=>{try{const prior=await inventoryOutbox.receivingDrafts.get(draftKey);const saved=prior??await saveReceivingDraft(draftKey,0,{kind:'transfer',revision:String(stock.revision),onHand:String(stock.onHand),destination:'',quantity:'',reason:'',direction:'decrease'});if(!saved.fields||Object.values(saved.fields).some(v=>typeof v!=='string'))throw Error('Повреждённое предложение сохранено для проверки');row.current=saved;if(alive.current)setDraft(saved);}catch(e){if(alive.current)setError(String(e));}})();return()=>{alive.current=false;};},[draftKey]);
 function edit(form:HTMLFormElement){
  if(!row.current||row.current.operationId||locked.current)return;
  const fields={...row.current.fields,...Object.fromEntries(new FormData(form).entries())} as Record<string,string>;
  setBusy(true);chain.current=chain.current.then(async()=>{if(failed.current)return;const saved=await saveReceivingDraft(draftKey,row.current!.revision,fields);row.current=saved;if(alive.current)setDraft(saved);}).catch(e=>{failed.current=true;if(alive.current)setError('Изменение не сохранено. Данные оставлены в форме. '+String(e));}).finally(()=>{if(alive.current)setBusy(false);});
 }
 function request():Extract<InventoryStockChangeDraft,{kind:'transfer'|'adjust'}>{
  const fields=row.current!.fields;
  const common={stockId:stock.stockId,expectedRevision:Number(fields.revision),reason:fields.reason.trim()};
  if(!common.reason)throw Error('Укажите основание и свидетельство физической проверки');
  if(fields.kind==='transfer')return {...common,kind:'transfer',quantity:Number(fields.onHand),toLocationId:fields.destination};
  if(!canCorrect)throw Error('Коррекция доступна только начальнику и назначенному менеджеру склада');
  return {...common,kind:'adjust',quantity:toInventoryBaseUnits(fields.quantity,stock.unit,stock.unit),adjustment:fields.direction==='increase'?'increase':'decrease'};
 }
 async function confirm(){
  if(locked.current)return;locked.current=true;setBusy(true);
  try{await chain.current;if(failed.current)throw Error('Сначала восстановите сохранение черновика');const op=request();await freezeStockDraft(draftKey,row.current!.revision,session,scope,op);row.current=await inventoryOutbox.receivingDrafts.get(draftKey);if(alive.current){setDraft(row.current);setPreview(undefined);onQueued();}}
  catch(e){if(alive.current)setError('Предложение не отправлено. Обновите остаток и проверьте исходную версию. '+String(e));}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 }
 async function startNew(){
  if(locked.current)return;locked.current=true;setBusy(true);
  try{
   const saved=await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,inventoryOutbox.stockOperations,async()=>{
    const current=await inventoryOutbox.receivingDrafts.get(draftKey);
    if(!current||current.revision!==row.current?.revision)throw Error('Предложение изменено в другом окне');
    const outstanding=await inventoryOutbox.stockOperations.where('[scopeKey+stockId]').equals([inventoryScopeKey(scope),stock.stockId]).count();
    if(outstanding)throw Error('Сначала отправьте или разберите предыдущее предложение. Конфликт не изменяется автоматически.');
    const next={key:draftKey,revision:current.revision+1,fields:{kind:'transfer',revision:String(stock.revision),onHand:String(stock.onHand),destination:'',quantity:'',reason:'',direction:'decrease'}};
    await inventoryOutbox.receivingDrafts.put(next);return next;
   });row.current=saved;if(alive.current){setDraft(saved);setRestart(false);setError('');}
  }catch(e){if(alive.current)setError(String(e));}finally{locked.current=false;if(alive.current)setBusy(false);}
 }
 if(!draft)return <p>{error||'Восстановление предложения…'}</p>;
 return <details className="space-y-2 rounded border border-slate-600 p-2"><summary className="min-h-11 cursor-pointer py-2">Перемещение / коррекция контейнера</summary>
 <p>Исходная версия: {draft.fields.revision}; текущая подтверждённая: {stock.revision}. Предложение не обновляет версию автоматически.</p>
 {draft.operationId?<><p>Сохранённая операция: {draft.operationId}. Проверьте очередь.</p><button className="min-h-11 px-3" onClick={()=>setRestart(true)}>Новое предложение после сверки</button></>:<form className="space-y-2" onChange={e=>edit(e.currentTarget)} onSubmit={e=>{e.preventDefault();void chain.current.then(()=>{try{if(failed.current)throw Error('Ошибка сохранения черновика');setPreview(request());setError('');}catch(error){setError(String(error));}});}}>
 <fieldset disabled={!!preview||locked.current} className="space-y-2">
 <label className="block">Действие склада<select name="kind" aria-label="Действие склада" defaultValue={draft.fields.kind} className="block min-h-11 w-full bg-slate-900"><option value="transfer">Переместить весь контейнер</option>{canCorrect&&<option value="adjust">Коррекция количества</option>}</select></label>
 <p>Перемещение всего контейнера: {draft.fields.onHand} {stock.unit}. Резерв должен быть нулевым.</p>
 <label className="block">Место назначения<select name="destination" aria-label="Место назначения" defaultValue={draft.fields.destination} className="block min-h-11 w-full bg-slate-900"><option value="">Выберите другое место</option>{locations.filter(l=>l.active&&l.id!==stock.locationId).map(l=><option key={l.id} value={l.id}>{l.label} · {l.id.slice(0,8)}</option>)}</select></label>
 {canCorrect&&<><label className="block">Направление коррекции<select className="block min-h-11 bg-slate-900" name="direction" defaultValue={draft.fields.direction}><option value="decrease">Уменьшить</option><option value="increase">Увеличить</option></select></label><label className="block">Величина коррекции ({stock.unit})<input aria-label="Величина коррекции" name="quantity" inputMode="decimal" defaultValue={draft.fields.quantity} className="block min-h-11 w-full bg-slate-900 p-2"/></label></>}
 <label className="block">Основание изменения<input aria-label="Основание изменения" name="reason" maxLength={2000} defaultValue={draft.fields.reason} className="block min-h-11 w-full bg-slate-900 p-2"/></label>
 </fieldset><button type="submit" disabled={busy||!!preview||failed.current} className="min-h-11 bg-blue-700 px-3">Проверить изменение</button>
 </form>}
 {!draft.operationId&&<button type="button" className="min-h-11 px-3" onClick={()=>setRestart(true)}>Сверить заново после обновления остатков</button>}
 {restart&&<div role="alertdialog"><p>Поля незавершённой формы будут заменены. Предыдущее отправленное предложение должно быть принято. Новое использует текущую подтверждённую версию {stock.revision}; сначала обновите остатки. Старый ID остаётся в серверной истории.</p><button className="min-h-11 px-3" disabled={busy} onClick={()=>void startNew()}>Подтвердить новый черновик</button><button className="min-h-11 px-3" disabled={busy} onClick={()=>setRestart(false)}>Оставить прежний</button></div>}
 {preview&&<div role="alertdialog" aria-label="Подтверждение изменения"><p>{stock.manufacturerLot} · {stock.stockId} · {preview.kind==='transfer'?'Весь контейнер в '+(locations.find(l=>l.id===preview.toLocationId)?.label??preview.toLocationId):'Коррекция '+preview.adjustment} · {preview.quantity} {stock.unit} · Версия {preview.expectedRevision}</p><p>Подтвердите физическую проверку. Остаток изменится только после принятия сервером.</p><button className="min-h-11 px-3" disabled={busy} onClick={()=>void confirm()}>Сохранить изменение в очередь</button><button className="min-h-11 px-3" disabled={busy} onClick={()=>setPreview(undefined)}>Вернуться к изменению</button></div>}
 <p>Резервирование требует утверждённого QA-допуска и действующей производственной партии. Физическая выдача, возврат и частичное перемещение пока недоступны.</p>
 {error&&<p role="alert">{error}</p>}
 </details>;
}
