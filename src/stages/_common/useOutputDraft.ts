import {useEffect,useRef,useState} from 'react';
import {inventoryOutbox,type ReceivingDraft} from '../../core/sync/inventoryOutbox';
import {saveReceivingDraft} from '../../core/sync/inventoryReceiving';
export const outputControl='block min-h-11 min-w-0 w-full rounded bg-slate-900 p-2';
export const outputButton='min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50';
/** Existing scoped inventory draft store; serialize field writes and surface CAS
 * failures. The initial epoch is never replaced by a later refresh. */
export function useOutputDraft(key:string,initial:Record<string,string>){
 const [row,setRow]=useState<ReceivingDraft>(),[error,setError]=useState('');
 const saved=useRef<ReceivingDraft>(),chain=useRef<Promise<unknown>>(Promise.resolve()),failed=useRef(false),alive=useRef(true);
 useEffect(()=>{let currentEffect=true;alive.current=true;void(async()=>{try{
  const current=await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>await inventoryOutbox.receivingDrafts.get(key)??await saveReceivingDraft(key,0,initial));
  if(currentEffect){saved.current=current;setRow(current);}
 }catch(e){if(currentEffect){failed.current=true;setError(String(e));}}})();return()=>{currentEffect=false;alive.current=false;};},[key]);
 function edit(fields:Record<string,string>){
  setRow(r=>r?{...r,fields}:r);
  chain.current=chain.current.then(async()=>{if(!saved.current||failed.current)throw Error('Исходный черновик не сохранён');const next=await saveReceivingDraft(key,saved.current.revision,fields);saved.current=next;}).catch(e=>{failed.current=true;if(alive.current)setError(String(e));});
 }
 async function flush(){await chain.current;if(failed.current||!saved.current)throw Error('Черновик не сохранён полностью; исходные данные не заменены');return saved.current;}
 return{row,error,edit,flush};
}
