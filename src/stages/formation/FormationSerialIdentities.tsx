import React,{useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '../../core/db';
import {useAuthStore} from '../../core/store/authStore';
import {StageId,serialRangeLabel,type SyncPacket,type FormationRun} from '../../core/types';
import {hasFormationResult} from '../../core/manufacturing/formationResults';
import {CELL_OUTPUT_ROLES} from '../../core/manufacturing/assemblyCellOutput';
import {createFormationSerialIdentity,declareFormationSerialIdentity,parseProcessedSerialRanges,validateFormationSerialIdentity,type FormationSerialIdentity} from '../../core/manufacturing/formationSerialIdentity';
import {useLocalFormDraft,LocalDraftStatus} from '../_common/useLocalFormDraft';
interface Form {version:1;runId:string;serials:string;evidence:string;attempt:FormationSerialIdentity|null}
const empty=():Form=>({version:1,runId:'',serials:'',evidence:'',attempt:null});
function parse(value:unknown):Form {
 const row=value as Form;
 if(!row||row.version!==1||typeof row.runId!=='string'||typeof row.serials!=='string'||typeof row.evidence!=='string'||row.serials.length>40000||row.evidence.length>1000||row.attempt===undefined)throw Error('Черновик номеров повреждён; исходные данные сохранены');
 if(row.attempt!==null){validateFormationSerialIdentity(row.attempt);if(row.attempt.runId!==row.runId)throw Error('Источник исходного заявления изменён');}
 return row;
}
const control='min-h-11 min-w-0 w-full rounded bg-slate-900 p-2';
export function FormationSerialIdentities({runs,onPacket}:{runs:FormationRun[];onPacket:(packet:SyncPacket)=>void}){
 const actor=useAuthStore(s=>s.currentUser);
 return actor?<SerialForm key={actor.id} actorId={actor.id} runs={runs} onPacket={onPacket}/>:<p>Войдите в локальный профиль для записи номеров.</p>;
}
function SerialForm({actorId,runs,onPacket}:{actorId:string;runs:FormationRun[];onPacket:(packet:SyncPacket)=>void}){
 const actor=useAuthStore(s=>s.currentUser)!,draft=useLocalFormDraft(actorId,'formation',empty,parse),form=draft.value;
 const identities=useLiveQuery(()=>db.formationSerialIdentities.toArray(),[],[]),[busy,setBusy]=useState(false),[error,setError]=useState(''),lock=useRef(false);
 const source=runs.find(r=>r.id===form.runId),saved=identities.find(r=>r.runId===form.runId),frozen=!!form.attempt;
 async function save(){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   let row=form.attempt;
   if(!row){
    if(!source)throw Error('Выберите сохранённый результат формирования');
    row=createFormationSerialIdentity(source,parseProcessedSerialRanges(form.serials),form.evidence,actor,crypto.randomUUID(),new Date().toISOString());
    await draft.checkpoint({...form,attempt:row});
   }else await draft.checkpoint(form);
   await declareFormationSerialIdentity(row,actorId);
  }catch(e){setError(String(e));}finally{lock.current=false;setBusy(false);}
 }
 async function send(row:FormationSerialIdentity){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{const current=await db.users.get(actorId),original=await db.formationSerialIdentities.get(row.runId);
   if(!current?.isActive||current.id!==row.recordedBy||current.role!==row.recordedRole||JSON.stringify(original)!==JSON.stringify(row))throw Error('Передать исходное заявление может его активный автор с исходной ролью');
   onPacket({v:1,type:'formation-serial-identity',stage:StageId.FORMATION,payload:row,from:actorId,role:current.role,ts:Date.now()});
  }catch(e){setError(String(e));}finally{lock.current=false;setBusy(false);}
 }
 return <section aria-label="Номера обработанных ячеек" className="min-w-0 space-y-3 break-words">
  <h3>Явные номера обработанных ячеек</h3>
  <p>Полный входной диапазон не определяет обработанную часть. Укажите все её номера по фактической записи. Это отдельное неизменяемое заявление, без итогового QC, выпуска или складского остатка.</p>
  <LocalDraftStatus draft={draft} disabled={busy}/>
  <fieldset className="min-w-0 space-y-3" disabled={!draft.ready||busy||frozen||!!saved}>
   <label>Результат формирования<select aria-label="Источник номеров формирования" className={control} value={form.runId} onChange={e=>draft.edit({...form,runId:e.target.value,serials:'',evidence:''})}><option value="">Выберите сохранённый связанный результат</option>{runs.filter(r=>hasFormationResult(r)&&r.serialRange&&r.cellsOut>0&&(r.workerId===actorId||CELL_OUTPUT_ROLES.includes(actor.role))).map(r=><option key={r.id} value={r.id}>{r.batchName} · {r.id} · обработано {r.cellsOut}</option>)}</select></label>
   {source&&<p>Полный вход: {serialRangeLabel(source.serialRange)} · подано {source.cellsIn}, обработано {source.cellsOut}, отклонено {source.cellsScrap}, не определено {source.cellsUnknown}. Префикс сохраняется из источника.</p>}
   <label>Номера обработанной части<textarea aria-label="Явные номера обработанных ячеек" className={control} rows={4} maxLength={40000} value={form.serials} onChange={e=>draft.edit({...form,serials:e.target.value})}/></label>
   <p>По возрастанию, без пересечений: 10-11; 13. Можно разделять точкой с запятой, запятой или новой строкой. Не более 1000 диапазонов. Количество должно совпасть со всем обработанным выходом.</p>
   <label>Основание определения номеров<input aria-label="Основание номеров формирования" className={control} maxLength={1000} value={form.evidence} onChange={e=>draft.edit({...form,evidence:e.target.value})}/></label>
  </fieldset>
  {frozen&&<><p>Исходный ID {form.attempt!.id} и снимок зафиксированы. Повтор сохраняет те же номера, автора и источник.</p><details><summary className="min-h-11 py-2">Зафиксированное исходное заявление</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(form.attempt,null,2)}</pre></details></>}
  <button className="min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50" disabled={busy||!draft.ready||!!draft.error||!!saved||(!source&&!frozen)} onClick={()=>void save()}>Сохранить исходное заявление номеров</button>
  {saved&&<button className="min-h-11 rounded bg-slate-700 px-3" disabled={busy||draft.saving} onClick={()=>void draft.reset().catch(e=>setError(String(e)))}>Открыть новую форму номеров</button>}
  {error&&<p role="alert">{error}</p>}
  <h4>Сохранённые заявления</h4>
  {identities.map(row=><article key={row.id} className="min-w-0 space-y-2 rounded border border-slate-600 p-3"><p>{row.source.batchName} · источник {row.runId} · заявление {row.id}</p><p>Явно обработано {row.count} · префикс {row.source.serialRange?.prefix||'без префикса'} · {row.ranges.map(r=>r.start===r.end?String(r.start):`${r.start}-${r.end}`).join('; ')}</p><p>{row.evidence} · {row.recordedBy} · {row.recordedAt}. QA и складская приёмка не подтверждены.</p>
   <details><summary className="min-h-11 py-2">Исходный снимок и номера</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(row,null,2)}</pre></details>
   {row.recordedBy===actorId&&row.recordedRole===actor.role&&<button disabled={busy} className="min-h-11 rounded bg-slate-700 px-3" onClick={()=>void send(row)}>Передать исходное заявление номеров</button>}
  </article>)}
 </section>;
}
