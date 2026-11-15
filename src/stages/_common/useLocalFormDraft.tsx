import React,{useEffect,useRef,useState} from 'react';
import {loadLocalDraft,saveLocalDraft,type DraftScope} from '../../core/db/localFormDrafts';

type Update<T>=T|((old:T)=>T);
/** Serialize local checkpoints. A failed/conflicting write stops later writes
 * until explicit retry/reload; no automatic overwrite of another window. */
export function useLocalFormDraft<T>(actorId:string,scope:DraftScope,initial:()=>T,parse:(value:unknown)=>T){
 const [value,setValue]=useState(initial),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[stored,setStored]=useState(false);
 const current=useRef(value),revision=useRef(0),queue=useRef(Promise.resolve()),pending=useRef(0),alive=useRef(true);
 const init=useRef(initial),parser=useRef(parse);
 function install(next:T){current.current=next;if(alive.current)setValue(next);}
 async function read(){
  if(alive.current)setReady(false);
  await queue.current.catch(()=>{});
  try{
   const row=await loadLocalDraft(actorId,scope);const next=row?.payload==null?init.current():parser.current(row.payload);
   revision.current=row?.revision??0;queue.current=Promise.resolve();install(next);
   if(alive.current){setStored(row?.payload!=null);setError('');setReady(true);}
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
 }
 useEffect(()=>{alive.current=true;void read();return()=>{alive.current=false;};},[actorId,scope]);
 function enqueue(payload:T|null):Promise<void>{
  const snapshot=structuredClone(payload);pending.current++;if(alive.current)setSaving(true);
  const job=queue.current.then(async()=>{
   const row=await saveLocalDraft(actorId,scope,revision.current,snapshot);revision.current=row.revision;
   if(alive.current){setStored(snapshot!==null);setError('');}
  });
  queue.current=job;
  void job.catch(e=>{if(alive.current)setError(e instanceof Error?e.message:String(e));}).finally(()=>{pending.current--;if(alive.current)setSaving(pending.current>0);});
  return job;
 }
 function checkpoint(update:Update<T>){
  if(!ready)return Promise.reject(Error('Черновик ещё не прочитан'));
  const next=typeof update==='function'?(update as (old:T)=>T)(current.current):update;install(next);return enqueue(next);
 }
 function edit(update:Update<T>){void checkpoint(update).catch(()=>{});}
 async function reset(){await enqueue(null);install(init.current());}
 async function retry(){await queue.current.catch(()=>{});queue.current=Promise.resolve();return enqueue(current.current);}
 return {value,ready,saving,error,stored,edit,checkpoint,reset,reload:read,retry};
}
export function LocalDraftStatus({draft,disabled=false}:{draft:{ready:boolean;saving:boolean;error:string;stored:boolean;reload:()=>Promise<void>;retry:()=>Promise<void>};disabled?:boolean}){
 return <div className="space-y-2 rounded border border-slate-700 p-3 text-xs text-slate-300">
  <p role="status">{!draft.ready?'Чтение черновика…':draft.saving?'Сохранение черновика на устройстве…':draft.error?'Последние изменения черновика не сохранены':draft.stored?'Черновик формы сохранён на устройстве':'Автосохранение формы на устройстве включено'}</p>
  {draft.error&&<><p role="alert" className="text-red-300">{draft.error}. Сохранённая запись не удалена.</p><div className="flex flex-wrap gap-2">
   {draft.ready&&<button disabled={disabled||draft.saving} className="min-h-11 rounded bg-slate-700 px-3" onClick={()=>void draft.retry().catch(()=>{})}>Повторить сохранение черновика</button>}
   <button disabled={disabled||draft.saving} className="min-h-11 rounded bg-slate-700 px-3" onClick={()=>void draft.reload()}>Загрузить сохранённый черновик вместо формы</button>
  </div></>}
  <p>Черновик не является записью производства и не отправляется на сервер. После перезапуска проверьте восстановленные значения и версии источников.</p>
 </div>;
}
