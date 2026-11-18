import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '../../core/db';
import {useAuthStore} from '../../core/store/authStore';
import {useServerConnection} from '../../core/sync/serverConnection';
import {requireFreshDeviceProof} from '../../core/sync/deviceProofClient';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import type {HybridSession} from '../../core/sync/hybridClient';
import type {MixBatch} from '../../core/types';
import {buildSlurryConsumption,freezeSlurryConsumption,sendSlurryConsumption,slurryConsumptionProposals,loadRoomMaterials,type RoomMaterial} from '../../core/sync/slurryConsumption';
import {toInventoryBaseUnits} from '../../core/sync/inventoryReceiving';
import {useOutputDraft,outputButton as button,outputControl as control} from '../_common/useOutputDraft';

export function SlurryMaterials(){
 const connection=useServerConnection(),user=useAuthStore(s=>s.currentUser),[now,setNow]=useState(Date.now());
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
 let proven=false;try{if(connection)proven=requireFreshDeviceProof(connection.session).deviceId===connection.selectedDeviceId&&now<(connection.session.deviceProofExpiresAt??0)-5000;}catch{/* Explicit proof renewal in Sync. */}
 const scope=connection?{serverUrl:connection.serverUrl,organizationId:connection.organizationId,actorId:connection.serverActorId,deviceId:connection.selectedDeviceId}:null;
 return <section className="min-w-0 space-y-3 break-words rounded bg-slate-800 p-3"><h3>Материалы комнаты и фактический расход</h3>
  {!proven&&<p>Для загрузки и отправки обновите подтверждение устройства. Сохранённые формы и предложения остаются доступными.</p>}
  <p>Получение выдачи подтвердите в разделе «Склад → Выдача». Только принятые материалы входят в остаток комнаты. Расход берётся из сохранённых фактических навесок; склад повторно не списывается.</p>
  {connection&&user&&scope?<SlurryMaterialsPanel key={inventoryScopeKey(scope)+user.id+connection.session.deviceProofExpiresAt} session={connection.session} scope={scope} localActorId={user.id}/>:<p>Подключите сервер и подтвердите устройство в разделе «Синхронизация». Локальные замесы работают офлайн; исходные предложения расхода сохранены.</p>}
 </section>;
}
export function SlurryMaterialsPanel({session,scope,localActorId}:{session:HybridSession;scope:InventoryScope;localActorId:string}){
 const batches=useLiveQuery(()=>db.mixBatches.where('workerId').equals(localActorId).toArray(),[localActorId])??[];
 const proposals=useLiveQuery(()=>slurryConsumptionProposals(scope,localActorId),[inventoryScopeKey(scope),localActorId])??[];
 const forms=useLiveQuery(()=>inventoryOutbox.receivingDrafts.filter(r=>{try{const k=JSON.parse(r.key);return k[0]===inventoryScopeKey(scope)&&k[1]===localActorId&&k[2]==='slurry-use-form';}catch{return false;}}).toArray(),[inventoryScopeKey(scope),localActorId])??[];
 const [page,setPage]=useState<Awaited<ReturnType<typeof loadRoomMaterials>>>(),[batchId,setBatchId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),running=useRef(false);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function work(fn:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(String(e));}finally{running.current=false;if(alive.current)setBusy(false);}}
 async function refresh(){const next=await loadRoomMaterials(session,scope);if(alive.current)setPage(next);}
 const batch=batches.find(b=>b.id===batchId),savedForm=forms.find(r=>JSON.parse(r.key)[3]===batchId);
 return <div className="min-w-0 space-y-3">
  <button className={button} disabled={busy} onClick={()=>void work(refresh)}>Обновить остатки Slurry</button>
  {page?.items.map(r=><article className="rounded border border-slate-600 p-2" key={r.issue.id}><p>{r.materialName} · {r.materialCode} · лот {r.issue.source?.manufacturerLot}</p><p>Партия {r.batchCode} · шаг {r.issue.stepNumber} · выдача {r.issue.id}</p><p>Принято {r.settlement.issued}; расход {r.settlement.consumed}; возврат {r.settlement.returned}; списано {r.settlement.scrapped}; неразнесено {r.settlement.outstanding} {r.issue.unit}. {r.eligible?'Источник не удержан':'Источник удержан / недоступен для расхода'}</p></article>)}
  {page?.nextAfter&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const next=await loadRoomMaterials(session,scope,'slurry',page.nextAfter!);if(next.epoch!==page.epoch)throw Error('История изменилась; исходные формы сохранены');if(alive.current)setPage({...next,items:[...page.items,...next.items]});})}>Следующие материалы комнаты</button>}
  <label>Сохранённый замес для расхода<select className={control} value={batchId} onChange={e=>setBatchId(e.target.value)}><option value="">Выберите фактические навески</option>{batches.filter(b=>b.measurementVersion===1).map(b=><option key={b.id} value={b.id}>{b.batchCode} · {b.recipeName}</option>)}</select></label>
  {batch&&(page||savedForm)&&<ConsumptionForm key={batch.id} {...{scope,localActorId,batch,epoch:page?.epoch??savedForm!.fields.epoch,choices:page?.items??[]}}/>}
  <h4>Исходные предложения расхода</h4>
  {proposals.map(r=><article key={r.key} className="space-y-2 rounded border border-slate-600 p-2"><p>Расход {r.operationId} · {{pending:'Ожидает отправки / исходного повтора; ответ может быть неизвестен',accepted:'Сервер подтвердил фактический расход',conflict:'Конфликт — исходные данные удержаны',rejected:'Отклонено — требуется сверка'}[r.fields.state]}</p>
   {r.fields.state==='pending'&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{await sendSlurryConsumption(session,scope,localActorId,r.key);await refresh();})}>Отправить исходный расход {r.operationId?.slice(0,8)}</button>}
   <details><summary className="min-h-11 py-2">Исходные навески, лоты и ответ</summary><pre className="whitespace-pre-wrap break-all">{r.fields.request}{'\n'}{r.fields.acknowledgement}{'\n'}{r.fields.error}</pre></details>
  </article>)}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
interface Line {id:string;issueId:string;componentId:string;grams:string}
function ConsumptionForm({scope,localActorId,batch,epoch,choices}:{scope:InventoryScope;localActorId:string;batch:MixBatch;epoch:string;choices:RoomMaterial[]}){
 const draft=useOutputDraft(JSON.stringify([inventoryScopeKey(scope),localActorId,'slurry-use-form',batch.id]),{source:JSON.stringify(batch),epoch,choices:JSON.stringify(choices),productionBatchId:'',stepNumber:'',operationId:crypto.randomUUID(),lines:JSON.stringify([]),reason:'',evidence:''});
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 if(!draft.row)return <p>{draft.error||'Читаем исходную форму расхода…'}</p>;
 const fields=draft.row.fields;
 let saved:MixBatch,sources:RoomMaterial[],lines:Line[];
 try{saved=JSON.parse(fields.source);sources=JSON.parse(fields.choices);lines=JSON.parse(fields.lines);if(!saved||!Array.isArray(saved.weighings)||!Array.isArray(sources)||!Array.isArray(lines))throw Error('Unknown draft');}catch{return <div role="alert">Исходная форма не распознана и сохранена для сверки.<pre className="whitespace-pre-wrap break-all">{JSON.stringify(fields,null,2)}</pre></div>; }
 function edit(patch:Record<string,string>){draft.edit({...fields,...patch});}
 const compatible=sources.filter(r=>r.issue.productionBatchId===fields.productionBatchId&&String(r.issue.stepNumber)===fields.stepNumber&&r.issue.unit==='mg');
 return <form aria-label="Фактический расход замеса" className="min-w-0 space-y-2 rounded border border-slate-600 p-3" onSubmit={e=>{e.preventDefault();if(running.current)return;running.current=true;setBusy(true);setError('');void(async()=>{try{
  const row=await draft.flush(),original:MixBatch=JSON.parse(row.fields.source),held:RoomMaterial[]=JSON.parse(row.fields.choices),selected:Line[]=JSON.parse(row.fields.lines);
  const request=buildSlurryConsumption(original,{operationId:row.fields.operationId,deviceId:scope.deviceId,productionBatchId:row.fields.productionBatchId,stepNumber:Number(row.fields.stepNumber),reason:row.fields.reason,evidence:row.fields.evidence,allocations:selected.map(l=>{
   const choice=held.find(r=>r.issue.id===l.issueId);if(!choice||!choice.eligible||choice.issue.unit!=='mg'||choice.issue.productionBatchId!==row.fields.productionBatchId||String(choice.issue.stepNumber)!==row.fields.stepNumber)throw Error('Выберите принятую массовую выдачу правильной партии и шага');
   const quantity=toInventoryBaseUnits(l.grams,'g','mg');if(quantity>choice.settlement.outstanding)throw Error('Распределение превышает сохранённый остаток');
   return{operationId:l.id,issueId:l.issueId,materialId:choice.issue.materialId,componentId:l.componentId,quantity,expectedSettlementRevision:choice.settlement.revision};
  })});
  await freezeSlurryConsumption(scope,localActorId,row.fields.epoch,original,request);
 }catch(e){if(alive.current)setError(String(e));}finally{running.current=false;if(alive.current)setBusy(false);}})();}}>
  <p>Исходный замес {saved.batchCode}. Плановые массы не списываются. Подтвердите соответствие компонента и складского материала по рабочей спецификации.</p>
  {saved.weighings.map(w=><p key={w.componentId}>{saved.componentSnapshots?.find(c=>c.id===w.componentId)?.name}: фактически {w.actualG} г (план {w.plannedG} г)</p>)}
  <label>Партия и операция Slurry<select className={control} value={fields.productionBatchId+':'+fields.stepNumber} onChange={e=>{const [productionBatchId,stepNumber]=e.target.value.split(':');edit({productionBatchId,stepNumber,lines:'[]'});}}><option value=":">Выберите партию и шаг</option>{sources.filter((r,i,all)=>all.findIndex(x=>x.issue.productionBatchId===r.issue.productionBatchId&&x.issue.stepNumber===r.issue.stepNumber)===i).map(r=><option key={r.issue.productionBatchId+':'+r.issue.stepNumber} value={r.issue.productionBatchId+':'+r.issue.stepNumber}>{r.batchCode} · {r.issue.stepNumber}</option>)}</select></label>
  {lines.map((line,i)=><fieldset key={line.id} className="min-w-0 space-y-2 rounded border border-slate-600 p-2"><legend>Источник {i+1}</legend>
   <label>Компонент<select className={control} value={line.componentId} onChange={e=>edit({lines:JSON.stringify(lines.map(l=>l.id===line.id?{...l,componentId:e.target.value}:l))})}><option value="">Выберите компонент</option>{saved.weighings.map(w=><option key={w.componentId} value={w.componentId}>{saved.componentSnapshots?.find(c=>c.id===w.componentId)?.name}</option>)}</select></label>
   <label>Принятый лот<select className={control} value={line.issueId} onChange={e=>edit({lines:JSON.stringify(lines.map(l=>l.id===line.id?{...l,issueId:e.target.value}:l))})}><option value="">Выберите исходную выдачу</option>{compatible.map(r=><option key={r.issue.id} value={r.issue.id} disabled={!r.eligible}>{r.materialCode} · {r.issue.source?.manufacturerLot} · {r.settlement.outstanding} мг · {r.issue.id}</option>)}</select></label>
   <label>Распределено фактически, г<input className={control} inputMode="decimal" value={line.grams} onChange={e=>edit({lines:JSON.stringify(lines.map(l=>l.id===line.id?{...l,grams:e.target.value}:l))})}/></label>
   <button type="button" className={button} onClick={()=>edit({lines:JSON.stringify(lines.filter(l=>l.id!==line.id))})}>Убрать источник {i+1}</button>
  </fieldset>)}
  <button type="button" className={button} onClick={()=>edit({lines:JSON.stringify([...lines,{id:crypto.randomUUID(),issueId:'',componentId:'',grams:''}])})}>Добавить исходный лот</button>
  {(['reason','evidence']as const).map(k=><label className="block" key={k}>{k==='reason'?'Основание расхода':'Свидетельство навесок и соответствия материала'}<textarea className={control} value={fields[k]} onChange={e=>edit({[k]:e.target.value})}/></label>)}
  <button className={button} disabled={busy||!!draft.error}>Сохранить предложение расхода без отправки</button>
  {(error||draft.error)&&<p role="alert">{error||draft.error}</p>}
 </form>;
}
