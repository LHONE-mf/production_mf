import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '../../core/db';
import {useAuthStore} from '../../core/store/authStore';
import {useServerConnection} from '../../core/sync/serverConnection';
import {requireFreshDeviceProof} from '../../core/sync/deviceProofClient';
import type {HybridSession} from '../../core/sync/hybridClient';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import type {InventoryMaterial} from '../../core/sync/inventoryCatalogClient';
import type {FormationSerialIdentity} from '../../core/manufacturing/formationSerialIdentity';
import {cellOutputClaims,freezeCellOutput} from '../../core/manufacturing/cellOutputClaims';
import {cellSourceFromIdentity,type CellSubmission} from '../../core/sync/inventoryCellOutputTypes';
import {sameOutput} from '../../core/sync/inventoryOutputTypes';
import type {OutputContext} from '../../core/sync/inventoryOutputs';
import {loadCellOutputs,loadCellOutputSteps,loadCellOutputMaterials,sendCellOutput,validateCellOutputStep,type CellOutputStep} from '../../core/sync/inventoryCellOutputs';
import {useOutputDraft,outputButton as button,outputControl as control} from '../storage/useOutputDraft';

export function FinishedCellOffers(){
 const connection=useServerConnection(),user=useAuthStore(s=>s.currentUser),identities=useLiveQuery(()=>db.formationSerialIdentities.toArray(),[])??[],[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 let proven=false;try{if(connection)proven=requireFreshDeviceProof(connection.session).deviceId===connection.selectedDeviceId&&now<(connection.session.deviceProofExpiresAt??0)-5000;}catch{/* Connection screen renews proof. */}
 const scope=connection?{serverUrl:connection.serverUrl,organizationId:connection.organizationId,actorId:connection.serverActorId,deviceId:connection.selectedDeviceId}:null;
 return <section aria-label="Предложение обработанных ячеек" className="min-w-0 space-y-3 rounded bg-slate-800 p-3 break-words"><h3>Обработанные ячейки → предложение производства</h3>
  <p>Явные номера и отправка предложения не создают складской остаток, приёмку или QA. Физическая приёмка ячеек складом ещё не реализована; выпуск продукции не подтверждён.</p>
  {connection&&scope&&user&&proven&&['chief','master'].includes(connection.serverRole)?<CellOutputPanel key={inventoryScopeKey(scope)+user.id+connection.session.deviceProofExpiresAt} session={connection.session} scope={scope} localActorId={user.id} identities={identities}/>:<p>Подключитесь как Chief / Master и подтвердите устройство в разделе Синхронизация. Исходные предложения остаются на устройстве; локальные наблюдения работают самостоятельно.</p>}
 </section>;
}
interface Props {session:HybridSession;scope:InventoryScope;localActorId:string;identities:FormationSerialIdentity[]}
export function CellOutputPanel({session,scope,localActorId,identities}:Props){
 const key=inventoryScopeKey(scope),claims=useLiveQuery(()=>cellOutputClaims(scope,localActorId),[key,localActorId])??[],held=useLiveQuery(()=>db.cellOutputClaims.toCollection().primaryKeys(),[])??[];
 const [context,setContext]=useState<OutputContext>(),[steps,setSteps]=useState<CellOutputStep[]>([]),[stepAfter,setStepAfter]=useState<string|null>(null),[offered,setOffered]=useState<CellSubmission[]>([]),[offerAfter,setOfferAfter]=useState<string|null>(null),[identityId,setIdentityId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[key,localActorId,session]);
 async function work(task:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await task();}catch(e){if(alive.current){setError(String(e));if(/HTTP (401|403)/.test(String(e)))setContext(undefined);}}finally{running.current=false;if(alive.current)setBusy(false);}}
 async function refresh(){const page=await loadCellOutputs(session,scope),choices=await loadCellOutputSteps(session,scope,page.epoch);if(!alive.current)return;setContext(page);setSteps(choices.items);setStepAfter(choices.nextAfter);setOffered(page.items);setOfferAfter(page.nextAfter);}
 const identity=identities.find(row=>row.id===identityId);
 return <div className="space-y-3">
  <button className={button} disabled={busy} onClick={()=>void work(refresh)}>Загрузить завершённые шаги и предложения ячеек</button>
  {context&&<><p>История: {context.epoch}. {context.postingEnabled?'Предложение отправляется только отдельной кнопкой.':'Проведение приостановлено; исходные предложения удержаны.'}</p>
   <label>Заявление номеров для предложения<select aria-label="Заявление номеров для предложения" className={control} disabled={busy} value={identityId} onChange={e=>setIdentityId(e.target.value)}><option value="">Выберите сохранённые явные номера</option>{identities.map(row=><option key={row.id} value={row.id}>{row.source.batchName} · {row.count} шт · {row.id}{held.includes(row.runId)?' · источник удержан':''}</option>)}</select></label>
   {stepAfter&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const page=await loadCellOutputSteps(session,scope,context.epoch,stepAfter);if(alive.current){setSteps(rows=>[...rows,...page.items]);setStepAfter(page.nextAfter);}})}>Следующие завершённые шаги ячеек</button>}
   {identity&&<CellOfferForm key={JSON.stringify([key,localActorId,identity.id])} {...{session,scope,localActorId,context,steps,identity}} held={held.includes(identity.runId)}/>}
  </>}
  <h4>Исходные предложения ячеек на этом устройстве</h4>
  {claims.map(c=><article className="space-y-2 border border-slate-600 p-2" key={c.runId}><p>Предложение {c.request.operationId} · номера {c.identityId} · {{pending:'Ожидает отдельной отправки / точного повтора; результат может быть неизвестен',accepted:'Сервер подтвердил источник; складская приёмка и QA не записаны',conflict:'Конфликт — исходные данные удержаны',rejected:'Отклонено — требуется сверка'}[c.state]}</p><p>Партия {c.request.productionBatchId} · шаг {c.request.stepNumber} · {c.identity.count} шт · {c.request.reason} · {c.request.evidence}</p>
   {context&&context.epoch!==c.epoch&&<p role="alert">История изменилась. Исходный источник, ID и явные номера удержаны для сверки.</p>}
   {c.state==='pending'&&<button className={button} disabled={busy||!context?.postingEnabled||context.epoch!==c.epoch} onClick={()=>void work(async()=>{await sendCellOutput(session,scope,localActorId,c.runId);await refresh();})}>Отправить исходное предложение ячеек {c.request.operationId.slice(0,8)}</button>}
   <details><summary className="min-h-11 py-2">Исходный источник, предложение и ответ ячеек</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({identity:c.identity,request:c.request,acknowledgement:c.acknowledgement},null,2)}{'\n'}{c.error}</pre></details>
  </article>)}
  <h4>Прочитанные предложения ячеек сервера</h4>{offered.map(o=><article key={o.operationId} className="border border-slate-600 p-2"><p>Сервер принял источник {o.source.identityId} · {o.quantity} шт · партия {o.productionBatchId}. Это не складской остаток и не QA.</p><details><summary className="min-h-11 py-2">Прочитанный источник ячеек {o.operationId}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(o,null,2)}</pre></details></article>)}
  {context&&offerAfter&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const page=await loadCellOutputs(session,scope,context.epoch,offerAfter);if(alive.current){setOffered(rows=>[...rows,...page.items]);setOfferAfter(page.nextAfter);}})}>Следующие предложения ячеек</button>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
function CellOfferForm({session,scope,localActorId,context,steps,identity,held}:Omit<Props,'identities'>&{context:OutputContext;steps:CellOutputStep[];identity:FormationSerialIdentity;held:boolean}){
 const draftKey=JSON.stringify([inventoryScopeKey(scope),localActorId,'cell-output-form',identity.id]),draft=useOutputDraft(draftKey,{epoch:context.epoch,identity:JSON.stringify(identity),operationId:crypto.randomUUID(),step:'',material:'',reason:'',evidence:''});
 const [materials,setMaterials]=useState<InventoryMaterial[]>([]),[after,setAfter]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 let original:FormationSerialIdentity|undefined,step:CellOutputStep|undefined,sourceError='';
 try{if(draft.row){original=JSON.parse(draft.row.fields.identity);cellSourceFromIdentity(original!);if(!sameOutput(original,identity))throw Error('Заявление номеров изменено; исходная форма удержана');if(draft.row.fields.step){step=JSON.parse(draft.row.fields.step);validateCellOutputStep(step!);}}}catch(e){sourceError=String(e);}
 async function work(task:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await task();}catch(e){if(alive.current)setError(String(e));}finally{running.current=false;if(alive.current)setBusy(false);}}
 if(!draft.row)return <p>{draft.error||'Читаем исходную форму ячеек…'}</p>;
 const fields=draft.row.fields,epochChanged=fields.epoch!==context.epoch;
 return <form aria-label="Исходное предложение ячеек" className="min-w-0 space-y-2 border border-slate-600 p-3" onSubmit={e=>{e.preventDefault();void work(async()=>{
  const row=await draft.flush();if(row.fields.epoch!==context.epoch||!context.postingEnabled||held||sourceError)throw Error('Исходный источник или история недоступны для нового предложения');
  const selected:CellOutputStep=JSON.parse(row.fields.step),saved:FormationSerialIdentity=JSON.parse(row.fields.identity);validateCellOutputStep(selected);cellSourceFromIdentity(saved);
  if(saved.count!==selected.quantity)throw Error('Явный обработанный выход не совпадает с фактическим завершённым шагом; сверка обязательна');
  await freezeCellOutput(scope,localActorId,row.fields.epoch,saved,{operationId:row.fields.operationId,deviceId:scope.deviceId,productionBatchId:selected.productionBatchId,stepNumber:selected.stepNumber,completionId:selected.completionId,materialId:row.fields.material,reason:row.fields.reason,evidence:row.fields.evidence});
 });}}>
  <p>Исходный ID {fields.operationId}. Источник {original?.runId} · обработано {original?.count} шт; полный вход {original?.source.cellsIn}, отклонено {original?.source.cellsScrap}, не определено {original?.source.cellsUnknown}. Явные номера: {original?.source.serialRange?.prefix??''} {original?.ranges.map(r=>r.start===r.end?String(r.start):`${r.start}–${r.end}`).join('; ')}. Не назначаем номера браку/неизвестному и не выводим QC из наблюдений.</p>
  {held&&<p>Источник удержан сохранённым предложением. Используйте его исходный ID ниже.</p>}{epochChanged&&<p role="alert">Исходная история формы изменилась; форма не перепривязана.</p>}
  <fieldset disabled={busy||held||epochChanged||!!sourceError} className="min-w-0 space-y-2">
   <label>Завершённый шаг ячеек<select aria-label="Завершённый шаг ячеек" className={control} required value={step?.completionId??''} onChange={e=>{const next=steps.find(s=>s.completionId===e.target.value);draft.edit({...fields,step:next?JSON.stringify(next):'',material:''});setMaterials([]);setAfter(null);}}><option value="">Выберите фактический финальный шаг</option>{step&&!steps.some(s=>s.completionId===step!.completionId)&&<option value={step.completionId}>Исходный шаг {step.productionBatchId} · {step.stepNumber}</option>}{steps.map(s=><option key={s.completionId} value={s.completionId}>{s.batchCode} · {s.stepNumber}. {s.name} · {s.quantity} шт</option>)}</select></label>
   <button type="button" className={button} disabled={!step} onClick={()=>void work(async()=>{const page=await loadCellOutputMaterials(session,scope,fields.epoch,step!);if(alive.current){setMaterials(page.items);setAfter(page.nextAfter);}})}>Загрузить материалы ячеек</button>
   {after&&<button type="button" className={button} onClick={()=>void work(async()=>{const page=await loadCellOutputMaterials(session,scope,fields.epoch,step!,after);if(alive.current){setMaterials(rows=>[...rows,...page.items]);setAfter(page.nextAfter);}})}>Следующие материалы ячеек</button>}
   <label>Материал ячеек<select aria-label="Материал ячеек" className={control} required value={fields.material} onChange={e=>draft.edit({...fields,material:e.target.value})}><option value="">Выберите материал ячейки в штуках</option>{fields.material&&!materials.some(m=>m.id===fields.material)&&<option value={fields.material}>Исходный материал {fields.material}</option>}{materials.map(m=><option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}</select></label>
   <label>Основание предложения ячеек<input aria-label="Основание предложения ячеек" className={control} required maxLength={2000} value={fields.reason} onChange={e=>draft.edit({...fields,reason:e.target.value})}/></label>
   <label>Свидетельство выхода ячеек<textarea aria-label="Свидетельство выхода ячеек" className={control} required maxLength={2000} value={fields.evidence} onChange={e=>draft.edit({...fields,evidence:e.target.value})}/></label>
   <button className={button} disabled={!step}>Сохранить исходное предложение ячеек</button>
  </fieldset>{(error||draft.error||sourceError)&&<p role="alert">{error||draft.error||sourceError}</p>}
 </form>;
}
