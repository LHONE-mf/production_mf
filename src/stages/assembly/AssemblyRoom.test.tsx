import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {AssemblyModule} from './AssemblyRoom';
it('resumes a saved intake rather than taking the same sorted source twice',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 useAuthStore.setState({currentUser:{id:'operator',login:'operator',fullName:'Operator',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
 const cut={id:'cut',incomingId:'roll',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
 const spec={id:'spec',cutRunId:'cut',batchName:'roll',electrodeType:'strip' as const,parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
 await db.sortRuns.add({id:'sorted',cutRunId:'cut',cutRunSnapshot:cut,specSnapshot:spec,specId:'spec',batchName:'roll',goodCount:10,buckets:[{categoryName:'A',count:8}],rejected:2,workerId:'sorter',createdAt:1,updatedAt:1});
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 try{
  await act(async()=>{root.render(<AssemblyModule/>);});
  await vi.waitFor(()=>expect(node.textContent).toContain('roll'));
  const fail=()=>{throw Error('Journal unavailable');};db.journal.hook('creating',fail);
  try{
   await act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Взять в сборку'))!.click();});
   await vi.waitFor(()=>expect(node.querySelector('[role="alert"]')?.textContent).toContain('Journal unavailable'));
   expect(await db.assemblyRuns.count()).toBe(0);
  }finally{db.journal.hook('creating').unsubscribe(fail);}
  for(let i=0;i<2;i++){
   await act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Взять в сборку'))!.click();});
   await vi.waitFor(async()=>expect(await db.assemblyRuns.count()).toBeGreaterThan(0));
   await act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Партии с сортировки'))!.click();});
  }
  expect(await db.assemblyRuns.count()).toBe(1);
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
