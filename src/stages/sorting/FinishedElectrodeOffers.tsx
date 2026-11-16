import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import type {SortRun} from '../../core/types';
import {db} from '../../core/db';
import {useAuthStore} from '../../core/store/authStore';
import {useServerConnection} from '../../core/sync/serverConnection';
import {requireFreshDeviceProof} from '../../core/sync/deviceProofClient';
import type {HybridSession} from '../../core/sync/hybridClient';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import type {InventoryMaterial} from '../../core/sync/inventoryCatalogClient';
import {freezeWarehouseOutput,warehouseOutputClaims} from '../../core/manufacturing/warehouseOutputClaims';
import {sourceFromSortRun,finishedBuckets} from '../../core/sync/inventoryOutputTypes';
import {loadInventoryOutputs,loadOutputSteps,loadOutputMaterials,sendWarehouseOutput,validateOutputStep,type OutputStep,type OutputContext,type OfferedOutput} from '../../core/sync/inventoryOutputs';
import {useOutputDraft,outputButton as button,outputControl as control} from '../_common/useOutputDraft';

export function FinishedElectrodeOffers({runs}:{runs:SortRun[]}){
 const connection=useServerConnection(),user=useAuthStore(s=>s.currentUser),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 let proven=false;try{if(connection)proven=requireFreshDeviceProof(connection.session).deviceId===connection.selectedDeviceId&&now<(connection.session.deviceProofExpiresAt??0)-5000;}catch{/* Connection screen renews proof. */}
 const scope=connection?{serverUrl:connection.serverUrl,organizationId:connection.organizationId,actorId:connection.serverActorId,deviceId:connection.selectedDeviceId}:null;
 return <section aria-label="Предложение готовых электродов" className="min-w-0 space-y-3 rounded bg-slate-800 p-3 break-words"><h3>Готовые электроды → отдельная приёмка склада</h3>
  <p>Завершение сортировки и отправка предложения не создают складской остаток. Склад отдельно считает и принимает каждый полный сорт в карантин; Chief отдельно решает QA.</p>
  {connection&&scope&&user&&proven&&['chief','master'].includes(connection.serverRole)?<ProductionOutputPanel key={inventoryScopeKey(scope)+user.id+connection.session.deviceProofExpiresAt} session={connection.session} scope={scope} localActorId={user.id} runs={runs}/>:<p>Подключитесь как Chief / Master и подтвердите устройство в разделе Синхронизация. Исходные предложения остаются на устройстве; локальная сортировка работает самостоятельно.</p>}
 </section>;
}
interface Props {session:HybridSession;scope:InventoryScope;localActorId:string;runs:SortRun[]}
export function ProductionOutputPanel({session,scope,localActorId,runs}:Props){
 const key=inventoryScopeKey(scope),claims=useLiveQuery(()=>warehouseOutputClaims(scope,localActorId),[key,localActorId])??[],claimedCuts=useLiveQuery(async()=>(await db.warehouseOutputClaims.toCollection().primaryKeys()).map(String),[])??[];
 const [context,setContext]=useState<OutputContext>(),[steps,setSteps]=useState<OutputStep[]>([]),[stepAfter,setStepAfter]=useState<string|null>(null),[offered,setOffered]=useState<OfferedOutput[]>([]),[offerAfter,setOfferAfter]=useState<string|null>(null),[runId,setRunId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[key,localActorId,session]);
 async function work(task:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await task();}catch(e){if(alive.current){setError(String(e));if(/HTTP (401|403)/.test(String(e)))setContext(undefined);}}finally{running.current=false;if(alive.current)setBusy(false);}}
 async function refresh(){const page=await loadInventoryOutputs(session,scope),choices=await loadOutputSteps(session,scope,page.epoch);if(!alive.current)return;setContext(page);setSteps(choices.items);setStepAfter(choices.nextAfter);setOffered(page.items);setOfferAfter(page.nextAfter);}
 const run=runs.find(r=>r.id===runId);
 return <div className="space-y-3">
  <button className={button} disabled={busy} onClick={()=>void work(refresh)}>Загрузить завершённые шаги и предложения</button>
  {context&&<><p>История: {context.epoch}. {context.postingEnabled?'Отправка после отдельного подтверждения.':'Проведение приостановлено; исходные предложения удержаны.'}</p>
   <label>Локальный итог сортировки<select aria-label="Локальный итог сортировки" className={control} disabled={busy} value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Выберите завершённый трёхстанционный итог</option>{runs.filter(r=>r.sortingWorkflow?.finalizedSortRunId===r.id).map(r=><option key={r.id} value={r.id}>{r.batchName} · {r.id}{claimedCuts.includes(r.cutRunId??'')?' · источник удержан':''}</option>)}</select></label>
   {stepAfter&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const page=await loadOutputSteps(session,scope,context.epoch,stepAfter);if(alive.current){setSteps(rows=>[...rows,...page.items]);setStepAfter(page.nextAfter);}})}>Следующие завершённые шаги</button>}
   {run&&<SourceOfferForm key={JSON.stringify([key,localActorId,run.id])} {...{session,scope,localActorId,context,steps,run}} held={claimedCuts.includes(run.cutRunId??'')}/>}
  </>}
  <h4>Исходные предложения на этом устройстве</h4>
  {claims.map(c=><article className="space-y-2 border border-slate-600 p-2" key={c.cutRunId}><p>Предложение {c.request.operationId} · источник {c.runId} / {c.cutRunId} · {{pending:'Ожидает отдельной отправки / точного повтора',accepted:'Сервер подтвердил предложение; склад отдельно',conflict:'Конфликт — исходные данные удержаны',rejected:'Отклонено — требуется сверка'}[c.state]}</p><p>Партия {c.request.productionBatchId} · шаг {c.request.stepNumber} · {c.request.outputs.map(o=>`${o.grade}: ${o.quantity} шт`).join('; ')} · {c.request.reason} · {c.request.evidence}</p>
   {context&&context.epoch!==c.epoch&&<p role="alert">История изменилась. Исходный источник, ID и количества удержаны для сверки.</p>}
   {c.state==='pending'&&<button className={button} disabled={busy||!context?.postingEnabled||context.epoch!==c.epoch} onClick={()=>void work(async()=>{await sendWarehouseOutput(session,scope,localActorId,c.cutRunId);await refresh();})}>Отправить исходное предложение {c.request.operationId.slice(0,8)}</button>}
   <details><summary className="min-h-11 py-2">Исходное предложение и ответ производства</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(c.request,null,2)}{'\n'}{c.acknowledgement?JSON.stringify(c.acknowledgement,null,2):c.error}</pre></details>
  </article>)}
  <h4>Прочитанные предложения сервера</h4>{offered.map(o=><article key={o.operationId} className="border border-slate-600 p-2"><p>Сервер принял предложение {o.operationId} · {o.source.runId} · партия {o.productionBatchId}</p>{o.outputs.map(line=><p key={line.grade}>{line.grade}: {line.quantity} шт · {line.stockId?'Отдельно принято складом: '+line.stockId:'Складская приёмка ещё не записана в этом прочитанном состоянии'}</p>)}</article>)}
  {context&&offerAfter&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const page=await loadInventoryOutputs(session,scope,context.epoch,offerAfter);if(alive.current){setOffered(rows=>[...rows,...page.items]);setOfferAfter(page.nextAfter);}})}>Следующие предложения производства</button>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
function SourceOfferForm({session,scope,localActorId,context,steps,run,held}:Omit<Props,'runs'>&{context:OutputContext;steps:OutputStep[];run:SortRun;held:boolean}){
 const draftKey=JSON.stringify([inventoryScopeKey(scope),localActorId,'output-form',run.id]),draft=useOutputDraft(draftKey,{epoch:context.epoch,step:'',assignments:'{}',reason:'',evidence:''});
 const [materials,setMaterials]=useState<InventoryMaterial[]>([]),[after,setAfter]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 let buckets:ReturnType<typeof finishedBuckets>=[],sourceError='';try{buckets=finishedBuckets(sourceFromSortRun(run));}catch(e){sourceError=String(e);}
 let step:OutputStep|undefined,assignments:Record<string,string>={};try{if(draft.row?.fields.step){step=JSON.parse(draft.row.fields.step);validateOutputStep(step!);}const parsed=JSON.parse(draft.row?.fields.assignments??'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();assignments=parsed;}catch{sourceError='Исходная форма повреждена; данные сохранены для сверки';}
 async function work(task:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await task();}catch(e){if(alive.current)setError(String(e));}finally{running.current=false;if(alive.current)setBusy(false);}}
 if(!draft.row)return <p>{draft.error||'Читаем исходную форму…'}</p>;
 const fields=draft.row.fields,epochChanged=fields.epoch!==context.epoch;
 return <form aria-label="Исходное предложение электродов" className="space-y-2 border border-slate-600 p-3" onSubmit={e=>{e.preventDefault();void work(async()=>{
  const row=await draft.flush();if(row.fields.epoch!==context.epoch||!context.postingEnabled||held||sourceError)throw Error('Исходный источник или история недоступны для нового предложения');
  const selected:OutputStep=JSON.parse(row.fields.step);validateOutputStep(selected);
  const output=buckets.map(g=>({grade:g.categoryName,quantity:g.count,materialId:(JSON.parse(row.fields.assignments) as Record<string,string>)[g.categoryName]}));
  if(output.reduce((n,o)=>n+o.quantity,0)!==selected.quantity)throw Error('Фактический итог не совпадает с количеством завершённого шага; сверка обязательна');
  await freezeWarehouseOutput(scope,localActorId,row.fields.epoch,run,{operationId:crypto.randomUUID(),deviceId:scope.deviceId,productionBatchId:selected.productionBatchId,stepNumber:selected.stepNumber,completionId:selected.completionId,outputs:output,reason:row.fields.reason,evidence:row.fields.evidence});
 });}}>
  <p>Источник {run.id}, нарезка {run.cutRunId}. Фактический итог: {buckets.map(g=>`${g.categoryName}: ${g.count} шт`).join('; ')}. Выберите соответствующий действительный серверный шаг; план не используется.</p>
  {held&&<p>Источник удержан сохранённым предложением. Для отправки используйте его исходный ID ниже.</p>}{epochChanged&&<p role="alert">Исходная история формы изменилась; форма не перепривязана.</p>}
  <fieldset disabled={busy||held||epochChanged||!!sourceError} className="min-w-0 space-y-2">
   <label>Завершённый шаг партии<select aria-label="Завершённый шаг партии" className={control} required value={step?.completionId??''} onChange={e=>{const next=steps.find(s=>s.completionId===e.target.value);draft.edit({...fields,step:next?JSON.stringify(next):'',assignments:'{}'});setMaterials([]);setAfter(null);}}><option value="">Выберите завершение фактического выхода</option>{step&&!steps.some(s=>s.completionId===step!.completionId)&&<option value={step.completionId}>Сохранённый исходный шаг {step.productionBatchId} · {step.stepNumber}</option>}{steps.map(s=><option key={s.completionId} value={s.completionId}>{s.batchCode} · {s.materialLine} · {s.stepNumber}. {s.name} · {s.quantity} шт</option>)}</select></label>
   <button type="button" className={button} disabled={!step} onClick={()=>void work(async()=>{const page=await loadOutputMaterials(session,scope,fields.epoch,step!);if(alive.current){setMaterials(page.items);setAfter(page.nextAfter);}})}>Загрузить материалы выхода</button>
   {after&&<button type="button" className={button} onClick={()=>void work(async()=>{const page=await loadOutputMaterials(session,scope,fields.epoch,step!,after);if(alive.current){setMaterials(rows=>[...rows,...page.items]);setAfter(page.nextAfter);}})}>Следующие материалы выхода</button>}
   {buckets.map(g=><label key={g.categoryName}>Материал сорта {g.categoryName} · {g.count} шт<select aria-label={'Материал сорта '+g.categoryName} className={control} required value={assignments[g.categoryName]??''} onChange={e=>draft.edit({...fields,assignments:JSON.stringify({...assignments,[g.categoryName]:e.target.value})})}><option value="">Выберите материал электрода в штуках</option>{assignments[g.categoryName]&&!materials.some(m=>m.id===assignments[g.categoryName])&&<option value={assignments[g.categoryName]}>Исходный материал {assignments[g.categoryName]}</option>}{materials.map(m=><option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}</select></label>)}
   <label>Основание предложения<input aria-label="Основание предложения" className={control} required maxLength={2000} value={fields.reason} onChange={e=>draft.edit({...fields,reason:e.target.value})}/></label>
   <label>Свидетельство фактического выхода<textarea aria-label="Свидетельство фактического выхода" className={control} required maxLength={2000} value={fields.evidence} onChange={e=>draft.edit({...fields,evidence:e.target.value})}/></label>
   <button className={button} disabled={!step}>Сохранить исходное предложение без приёмки</button>
  </fieldset>{(error||draft.error||sourceError)&&<p role="alert">{error||draft.error||sourceError}</p>}
 </form>;
}
