import React,{useEffect,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import type {HybridSession} from '../../core/sync/hybridClient';
import {inventoryScopeKey,type InventoryScope} from '../../core/sync/inventoryOutbox';
import {inventoryLocationPath,type InventoryLocation} from '../../core/sync/inventoryCatalogClient';
import {toInventoryBaseUnits} from '../../core/sync/inventoryReceiving';
import {loadInventoryOutputs,type OfferedOutput} from '../../core/sync/inventoryOutputs';
import {freezeOutputAcceptance,sendOutputAcceptance,outputAcceptanceProposals,type OutputAcceptanceRequest} from '../../core/sync/inventoryOutputAcceptance';
import {useOutputDraft,outputButton as button,outputControl as control} from './useOutputDraft';
interface Props {session:HybridSession;scope:InventoryScope;localActorId:string;epoch:string;locations:InventoryLocation[];onChanged:()=>void}
const receiptStates:Record<string,string>={pending:'Ожидает отдельного подтверждения / точного повтора',accepted:'Складская приёмка записана',conflict:'Конфликт — исходный подсчёт удержан',rejected:'Отклонено — требуется сверка'};
export function InventoryOutputReceipts(props:Props){return <OutputReceipts key={inventoryScopeKey(props.scope)+props.localActorId} {...props}/>;}
function OutputReceipts({session,scope,localActorId,epoch,locations,onChanged}:Props){
 const key=inventoryScopeKey(scope),proposals=useLiveQuery(()=>outputAcceptanceProposals(scope,localActorId),[key,localActorId],[]);
 const [items,setItems]=useState<OfferedOutput[]>([]),[after,setAfter]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const alive=useRef(true),running=useRef(false);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[key,session]);
 useEffect(()=>{setItems([]);setLoaded(false);setAfter(null);},[epoch]);
 async function refresh(){const page=await loadInventoryOutputs(session,scope,epoch);if(alive.current){setItems(page.items);setAfter(page.nextAfter);setLoaded(true);}}
 async function work(task:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await task();}catch(e){if(alive.current){setError(String(e));if(/HTTP (401|403)/.test(String(e))){setLoaded(false);setItems([]);}}}finally{running.current=false;if(alive.current)setBusy(false);}}
 return <section aria-label="Приёмка готовых электродов" className="min-w-0 space-y-3 rounded border border-slate-600 p-3 break-words"><h4>Приёмка готовых электродов из производства</h4>
  <p>Производство только предлагает выход. Склад отдельно проверяет физическое наличие каждого полного сорта и принимает в новую карантинную упаковку. Разрешение QA принимает Chief отдельным действием.</p>
  <button className={button} disabled={busy} onClick={()=>void work(refresh)}>Загрузить предложения готовых электродов</button>
  {loaded&&!items.length&&<p>Прочитанных предложений нет.</p>}
  {items.map(source=><article key={source.operationId} className="space-y-2 border border-slate-600 p-2"><p>Предложение производства {source.operationId} · партия {source.productionBatchId} · шаг {source.stepNumber}</p><p>Источник сортировки {source.source.runId} · нарезка {source.source.cutRunId} · КД {source.source.specId} · {source.source.mode} · автор {source.actorId} · {source.recordedAt}</p><p>{source.reason} · {source.evidence}</p>
   <details><summary className="min-h-11 py-2">Сохранённые решения трёх станций</summary>{source.source.stages.map(s=><p key={s.station}>{{visual:'Визуальный контроль',thickness:'Толщина',mass:'Масса'}[s.station]}: вход {s.inputCount}, прошло {s.passedCount}, отклонено {s.rejectedCount} · {s.workerId}{s.grades?' · '+s.grades.map(g=>g.categoryName+': '+g.count).join('; '):''}{s.rejectionReasons?' · '+s.rejectionReasons.map(r=>r.reason+': '+r.count).join('; '):''}</p>)}</details>
   {source.outputs.map(line=><div key={line.grade} className="space-y-2 border-t border-slate-600 pt-2"><p>Сорт {line.grade}: предложено {line.quantity} шт · материал {line.materialId}</p>{line.stockId?<p>Отдельная складская приёмка записана: контейнер {line.stockId} · операция {line.acceptanceOperationId}. Текущее качество смотрите в остатках.</p>:<AcceptanceForm key={JSON.stringify([key,localActorId,source.operationId,line.grade])} {...{scope,localActorId,epoch,locations,source}} grade={line.grade} held={proposals.some(p=>{try{const r:OutputAcceptanceRequest=JSON.parse(p.fields.request);return r.submissionId===source.operationId&&r.grade===line.grade;}catch{return true;}})}/>}</div>)}
  </article>)}
  {after&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const page=await loadInventoryOutputs(session,scope,epoch,after);if(alive.current){setItems(rows=>[...rows,...page.items]);setAfter(page.nextAfter);}})}>Следующие предложения готовых электродов</button>}
  <h5>Исходные действия складской приёмки</h5>{proposals.map(row=>{let request:OutputAcceptanceRequest|undefined;try{request=JSON.parse(row.fields.request);}catch{/* Preserve evidence. */}return <article key={row.key} className="space-y-2 border border-slate-600 p-2"><p>Приёмка выхода {row.operationId} · {receiptStates[row.fields.state]??'Требуется сверка исходного состояния'} · {row.fields.error}</p>{request&&<p>Предложение {request.submissionId} · сорт {request.grade} · физически {request.quantity} шт · контейнер {request.stockId} · {request.reason} · {request.evidence}</p>}
   {row.fields.epoch!==epoch&&<p role="alert">История исходного подсчёта изменилась; предложение удержано для сверки.</p>}
   {row.fields.state==='pending'&&<button className={button} disabled={busy||row.fields.epoch!==epoch} onClick={()=>void work(async()=>{await sendOutputAcceptance(session,scope,localActorId,row.key);await refresh();if(alive.current)onChanged();})}>Подтвердить исходную приёмку {row.operationId?.slice(0,8)}</button>}
   <details><summary className="min-h-11 py-2">Исходный подсчёт и ответ склада</summary><pre className="whitespace-pre-wrap break-all">{row.fields.request}{'\n'}{row.fields.acknowledgement}</pre></details>
  </article>;})}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
function AcceptanceForm({scope,localActorId,epoch,locations,source,grade,held}:Pick<Props,'scope'|'localActorId'|'epoch'|'locations'>&{source:OfferedOutput;grade:string;held:boolean}){
 const key=JSON.stringify([inventoryScopeKey(scope),localActorId,'output-accept-form',source.operationId,grade]);
 const draft=useOutputDraft(key,{epoch,quantity:'',locationId:'',reason:'',evidence:'',manufacturedOn:'',expiresOn:''});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const running=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 if(!draft.row)return <p>{draft.error||'Читаем исходный подсчёт…'}</p>;const fields=draft.row.fields,changed=fields.epoch!==epoch;
 return <form aria-label={'Физическая приёмка сорта '+grade} className="space-y-2" onSubmit={e=>{e.preventDefault();if(running.current)return;running.current=true;setBusy(true);setError('');void(async()=>{try{
  const row=await draft.flush();if(row.fields.epoch!==epoch||held)throw Error('Исходная приёмка уже сохранена или история изменилась');
  if(!locations.some(l=>l.id===row.fields.locationId&&l.active))throw Error('Выберите действительное место приёмки');
  await freezeOutputAcceptance(scope,localActorId,row.fields.epoch,source,{grade,locationId:row.fields.locationId,quantity:toInventoryBaseUnits(row.fields.quantity,'pieces','pieces'),reason:row.fields.reason,evidence:row.fields.evidence,
   ...(row.fields.manufacturedOn?{manufacturedOn:row.fields.manufacturedOn}:{}),...(row.fields.expiresOn?{expiresOn:row.fields.expiresOn}:{})});
 }catch(e){if(alive.current)setError(String(e));}finally{running.current=false;if(alive.current)setBusy(false);}})();}}>
  {held&&<p>Используйте сохранённый исходный подсчёт ниже. Новая операция для того же сорта не создаётся.</p>}{changed&&<p role="alert">История формы изменилась; физический подсчёт не перепривязан.</p>}
  <fieldset disabled={busy||held||changed} className="min-w-0 space-y-2">
   <label>Физически принято, шт<input aria-label="Физически принято, шт" className={control} required inputMode="numeric" maxLength={16} value={fields.quantity} onChange={e=>draft.edit({...fields,quantity:e.target.value})}/></label>
   <label>Место приёмки выхода<select aria-label="Место приёмки выхода" className={control} required value={fields.locationId} onChange={e=>draft.edit({...fields,locationId:e.target.value})}><option value="">Выберите место</option>{fields.locationId&&!locations.some(l=>l.id===fields.locationId)&&<option value={fields.locationId}>Исходное место {fields.locationId}</option>}{locations.filter(l=>l.active).map(l=><option key={l.id} value={l.id}>{inventoryLocationPath(locations,l.id)}</option>)}</select></label>
   <label>Основание приёмки выхода<input aria-label="Основание приёмки выхода" className={control} required maxLength={2000} value={fields.reason} onChange={e=>draft.edit({...fields,reason:e.target.value})}/></label>
   <label>Свидетельство физического подсчёта<input aria-label="Свидетельство физического подсчёта" className={control} required maxLength={2000} value={fields.evidence} onChange={e=>draft.edit({...fields,evidence:e.target.value})}/></label>
   <label>Дата изготовления выхода (если известна)<input aria-label="Дата изготовления выхода" type="date" className={control} value={fields.manufacturedOn} onChange={e=>draft.edit({...fields,manufacturedOn:e.target.value})}/></label>
   <label>Годен до (если известно)<input aria-label="Годен до выхода" type="date" className={control} value={fields.expiresOn} onChange={e=>draft.edit({...fields,expiresOn:e.target.value})}/></label>
   <button className={button}>Сохранить физический подсчёт без проведения</button>
  </fieldset>{(error||draft.error)&&<p role="alert">{error||draft.error}</p>}
 </form>;
}
