import {useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import type {AssemblyOp,AssemblyOperationUnits} from '../../core/types';
import {validateAssemblyOperation} from '../../core/manufacturing/assemblyOperations';

export function useAssemblyOperationSave(onAddOp:(op:AssemblyOp)=>Promise<void>){
 const [units,setUnits]=useState<AssemblyOperationUnits>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),attempt=useRef<{signature:string;op:AssemblyOp}|null>(null);
 const commit=async(draft:AssemblyOp,onSuccess:()=>void)=>{
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');
  try{
   const {finishedAt,id,recordedAt,...content}=draft;
   const signature=JSON.stringify(content);
   if(attempt.current&&attempt.current.signature!==signature)throw new Error('Черновик изменён после попытки. Проверьте журнал и нажмите «Новая операция» для отдельной записи.');
   const now=new Date().toISOString();
   const op=attempt.current?.op??{...draft,id:uuidv4(),recordedAt:now,finishedAt:now};
   validateAssemblyOperation(op);
   attempt.current={signature,op};
   await onAddOp(op);
   attempt.current=null;onSuccess();
  }catch(cause){setError(cause instanceof Error?cause.message:'Операция не сохранена. Повторите попытку.');}
  finally{lock.current=false;setBusy(false);}
 };
 return {units,setUnits,busy,error,commit,resetAttempt:()=>{if(!lock.current){attempt.current=null;setError('');}}};
}
