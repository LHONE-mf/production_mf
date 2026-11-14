import {inventoryLocationPath} from '../../core/sync/inventoryCatalogClient';
import React,{useEffect,useRef,useState} from 'react';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope,type ReceivingDraft} from '../../core/sync/inventoryOutbox';
import {saveReceivingDraft,freezeReceivingDraft,toInventoryBaseUnits} from '../../core/sync/inventoryReceiving';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {InventoryMaterial,InventoryLocation} from '../../core/sync/inventoryCatalogClient';
const empty=()=>({stockId:crypto.randomUUID(),materialId:'',locationId:'',manufacturerLot:'',quantity:'',unit:'',supplier:'',receiptReference:'',reason:'',expiresOn:'',manufacturedOn:''});
export function ReceivingForm({scope,session,localActorId,materials,locations,onQueued}:{scope:InventoryScope;session:HybridSession;localActorId:string;materials:InventoryMaterial[];locations:InventoryLocation[];onQueued:()=>void}){
 const key=JSON.stringify([inventoryScopeKey(scope),localActorId,'receive']);
 return <ScopedReceiving key={key} {...{scope,session,materials,locations,onQueued}} draftKey={key}/>;
}
function ScopedReceiving({scope,session,materials,locations,onQueued,draftKey}:{scope:InventoryScope;session:HybridSession;materials:InventoryMaterial[];locations:InventoryLocation[];onQueued:()=>void;draftKey:string}){
 const [draft,setDraft]=useState<ReceivingDraft>(),[error,setError]=useState(''),[saving,setSaving]=useState(false),[preview,setPreview]=useState(false),[newReceipt,setNewReceipt]=useState(false);
 const row=useRef<ReceivingDraft>(),chain=useRef(Promise.resolve()),mounted=useRef(true),locked=useRef(false);
 useEffect(()=>{mounted.current=true;void(async()=>{try{let saved=await inventoryOutbox.receivingDrafts.get(draftKey);if(!saved)saved=await saveReceivingDraft(draftKey,0,empty());if(!saved.fields||!Number.isSafeInteger(saved.revision)||saved.revision<1||['stockId','materialId','locationId','manufacturerLot','quantity','unit','supplier','receiptReference','reason'].some(field=>typeof saved.fields[field]!=='string'))throw Error('Повреждённый черновик сохранён для проверки администратора');row.current=saved;if(mounted.current)setDraft(saved);}catch(e){if(mounted.current)setError(String(e));}})();return()=>{mounted.current=false;};},[draftKey]);
 function edit(field:string,value:string){
  if(!row.current||row.current.operationId||locked.current)return;
  const fields={...row.current.fields,[field]:value};row.current={...row.current,fields};setDraft(row.current);setSaving(true);
  chain.current=chain.current.then(async()=>{
   const current=await inventoryOutbox.receivingDrafts.get(draftKey);
   if(!current||current.operationId)throw Error('Черновик уже подтверждён');
   const saved=await saveReceivingDraft(draftKey,row.current!.revision,fields);
   row.current={...row.current!,revision:saved.revision};
   if(mounted.current){setDraft({...row.current});setError('');}
  }).catch(e=>{locked.current=true;if(mounted.current)setError('Черновик не сохранён. Введённые данные оставлены на экране. '+String(e));}).finally(()=>{if(mounted.current)setSaving(false);});
 }
 const fields=draft?.fields,material=materials.find(m=>m.id===fields?.materialId),location=locations.find(l=>l.id===fields?.locationId);
 function request(){
  if(!fields||!material||material.active===false||!location||!location.active||!fields.manufacturerLot.trim()||!fields.reason.trim())throw Error('Выберите материал и активное место, укажите партию производителя и основание');
  return {stockId:fields.stockId,materialId:material.id,locationId:location.id,manufacturerLot:fields.manufacturerLot.trim(),quantity:toInventoryBaseUnits(fields.quantity,fields.unit||material.baseUnit,material.baseUnit),expectedRevision:0 as const,reason:fields.reason.trim(),...(fields.supplier.trim()?{supplier:fields.supplier.trim()}:{}),...(fields.receiptReference.trim()?{receiptReference:fields.receiptReference.trim()}: {}),...(fields.expiresOn?{expiresOn:fields.expiresOn}:{}),...(fields.manufacturedOn?{manufacturedOn:fields.manufacturedOn}:{})};
 }
 async function confirm(){
  if(locked.current)return;locked.current=true;setSaving(true);
  try{await chain.current;const data=request();const id=await freezeReceivingDraft(draftKey,row.current!.revision,session,scope,data);row.current=(await inventoryOutbox.receivingDrafts.get(draftKey))!;if(mounted.current){setDraft(row.current);setPreview(false);setError('');onQueued();}return id;}
  catch(e){if(mounted.current)setError(String(e));}
  finally{locked.current=false;if(mounted.current)setSaving(false);}
 }
 async function startNew(){
  if(!row.current?.operationId||locked.current)return;locked.current=true;
  try{const prior=row.current;const saved=await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{const current=await inventoryOutbox.receivingDrafts.get(draftKey);if(current?.revision!==prior.revision||current.operationId!==prior.operationId)throw Error('Форма изменена в другом окне');const next={key:draftKey,revision:prior.revision+1,fields:empty()};await inventoryOutbox.receivingDrafts.put(next);return next;});row.current=saved;setDraft(saved);setNewReceipt(false);}
  catch(e){setError(String(e));}finally{locked.current=false;}
 }
 if(!fields)return <p role="status">{error||'Восстановление черновика приёмки…'}</p>;
 const input=(field:string,label:string,maxLength:number)=> <label className="block" key={field}>{label}<input aria-label={label} maxLength={maxLength} type={field==='expiresOn'||field==='manufacturedOn'?'date':'text'} inputMode={field==='quantity'?'decimal':undefined} className="block min-h-11 w-full rounded bg-slate-900 p-2" value={fields[field]??''} onChange={e=>edit(field,e.target.value)}/></label>;
 return <section aria-label="Серверная приёмка" className="space-y-3 rounded border border-slate-600 p-3">
 <h4>Приёмка в подтверждённый склад</h4><p>Новая упаковка получает отдельный ID, даже для той же партии производителя. Сохранение в очередь не меняет остаток. После подтверждения сервером — карантин.</p>
 <fieldset disabled={!!draft?.operationId||saving&&preview} className="space-y-2">
 <label className="block">Материал приёмки<select aria-label="Материал приёмки" className="block min-h-11 w-full bg-slate-900" value={fields.materialId} onChange={e=>edit('materialId',e.target.value)}><option value="">Выберите материал</option>{materials.filter(m=>m.active!==false).map(m=><option key={m.id} value={m.id}>{m.name} ({m.baseUnit})</option>)}</select></label>
 {input('manufacturerLot','Партия производителя',200)}
 <label className="block">Место приёмки<select aria-label="Место приёмки" className="block min-h-11 w-full bg-slate-900" value={fields.locationId} onChange={e=>edit('locationId',e.target.value)}><option value="">Выберите место</option>{locations.filter(l=>l.active).map(l=><option key={l.id} value={l.id}>{inventoryLocationPath(locations,l.id)} · {l.id.slice(0,8)}</option>)}</select></label>
 {input('quantity','Количество приёмки',30)}
 <label className="block">Единица приёмки<select aria-label="Единица приёмки" className="block min-h-11 w-full bg-slate-900" value={fields.unit||material?.baseUnit||''} onChange={e=>edit('unit',e.target.value)}><option value="">Выберите единицу</option>{(material?.baseUnit==='mg'?['mg','g','kg']:material?.baseUnit==='ul'?['ul','ml','L']:material?.baseUnit==='mm'?['mm','m']:['pieces']).map(u=><option key={u}>{u}</option>)}</select></label>
 <p>Даты необязательны. Годность действует до конца указанной даты UTC; новые поступления остаются в карантине.</p>{input('manufacturedOn','Дата изготовления (UTC)',10)}{input('expiresOn','Годен по (дата UTC)',10)}
 {input('supplier','Поставщик',200)}{input('receiptReference','Документ приёмки',200)}{input('reason','Основание приёмки / свидетельство',2000)}
 </fieldset>
 <p>Контейнер: {fields.stockId}</p>
 {draft?.operationId?<><p role="status">Операция сохранена: {draft.operationId}. Повторная отправка использует этот ID. Проверьте её статус в очереди.</p><button type="button" className="min-h-11 px-3 bg-slate-700" onClick={()=>setNewReceipt(true)}>Другая упаковка</button></>:<button type="button" className="min-h-11 px-3 bg-blue-700" disabled={saving||locked.current} onClick={()=>{try{request();setError('');setPreview(true);}catch(e){setError(String(e));}}}>Проверить приёмку</button>}
 {preview&&<div role="alertdialog" aria-label="Подтверждение приёмки" className="space-y-2 border p-3"><p>{material?.name} · {fields.manufacturerLot} · {fields.quantity} {fields.unit||material?.baseUnit} · {location&&inventoryLocationPath(locations,location.id)} · Карантин</p><p>Изготовлено (UTC): {fields.manufacturedOn||'не указано'} · Годен по (дата UTC): {fields.expiresOn||'не указано'}</p><p>Контейнер: {fields.stockId}. Это предложение для сервера; физическое наличие требует проверки оператора.</p><button className="min-h-11 px-3 bg-blue-700" disabled={saving} onClick={()=>void confirm()}>Сохранить приёмку в очередь</button><button className="min-h-11 px-3" disabled={saving} onClick={()=>setPreview(false)}>Вернуться к форме</button></div>}
 {newReceipt&&<div role="alertdialog"><p>Создать другую упаковку? Предыдущая операция останется в очереди или серверной истории. Не создавайте новую упаковку для повтора неизвестного ответа.</p><button className="min-h-11 px-3" onClick={()=>void startNew()}>Да, другая физическая упаковка</button><button className="min-h-11 px-3" onClick={()=>setNewReceipt(false)}>Оставить текущую</button></div>}
 <p role="status">{error?'Черновик требует проверки':saving?'Сохранение…':'Черновик сохранён на этом устройстве'}</p>{error&&<p role="alert">{error}</p>}
 </section>;
}
