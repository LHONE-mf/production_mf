import {useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import type {AssemblyOp,AssemblyOperationUnits,AssemblyRun,AssemblyOperationSource} from '../../core/types';
import {validateAssemblySources} from '../../core/manufacturing/assemblySource';
import {validateAssemblyOperation} from '../../core/manufacturing/assemblyOperations';

export function useAssemblyOperationSave(onAddOp:(op:AssemblyOp)=>Promise<void>,run:AssemblyRun){
 const [sourceChoice,setSourceChoice]=useState(''),[reference,setReference]=useState(''),[conversionNote,setConversionNote]=useState('');
 const [units,setUnits]=useState<AssemblyOperationUnits>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),attempt=useRef<{signature:string;op:AssemblyOp}|null>(null);
 const commit=async(draft:AssemblyOp,onSuccess:()=>void)=>{
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');
  try{
   let source:AssemblyOperationSource;
   if(sourceChoice==='intake')source={kind:'intake',sortRunId:run.intake?.sortRunId??''};
   else if(sourceChoice==='declared')source={kind:'declared',reference:reference.trim()};
   else if(sourceChoice.startsWith('operation:'))source={kind:'operation',operationId:sourceChoice.slice(10)};
   else throw new Error('Укажите источник операции');
   const prepared={...draft,source,conversionNote:conversionNote.trim()||undefined};
   const {finishedAt,id,recordedAt,...content}=prepared;
   const signature=JSON.stringify(content);
   if(attempt.current&&attempt.current.signature!==signature)throw new Error('Черновик изменён после попытки. Проверьте журнал и нажмите «Новая операция» для отдельной записи.');
   const now=new Date().toISOString();
   const op=attempt.current?.op??{...prepared,id:uuidv4(),recordedAt:now,finishedAt:now};
   validateAssemblyOperation(op);
   validateAssemblySources({...run,sourceLedger:1,ops:[...run.ops,op]});
   attempt.current={signature,op};
   await onAddOp(op);
   attempt.current=null;setSourceChoice('');setReference('');setConversionNote('');onSuccess();
  }catch(cause){setError(cause instanceof Error?cause.message:'Операция не сохранена. Повторите попытку.');}
  finally{lock.current=false;setBusy(false);}
 };
 return {sourceChoice,setSourceChoice,reference,setReference,conversionNote,setConversionNote,units,setUnits,busy,error,commit,resetAttempt:()=>{if(!lock.current){attempt.current=null;setError('');}}};
}
