import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {syntheticFormationLineage} from '../../../tests/fixtures/formation-lineage';
import {FormationModule} from './FormationRoom';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:({packet}:{packet:{type:string}})=><p>Exported {packet.type}</p>}));
it('recovers explicit serial fields and original failed declaration across reopen, then commits once without changing source/QC/stock',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const users:User[]=[{id:'chief',login:'chief',fullName:'Chief',password:'test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}];await db.users.bulkAdd(users);
 const source=await syntheticFormationLineage('chief','worker');useAuthStore.setState({currentUser:users[1]});
 const node=document.createElement('div');document.body.appendChild(node);let root=createRoot(node);
 const click=async(text:string)=>act(async()=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent===text);expect(button,text).toBeDefined();button!.click();});
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
 const edit=async(label:string,value:string)=>act(async()=>{const el=node.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('[aria-label="'+label+'"]')!;expect(el,label).toBeTruthy();const prototype=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});
 async function mount(){await act(async()=>root.render(<FormationModule/>));await click('Номера обработанных');await wait(()=>{expect(node.querySelector('fieldset')).toBeTruthy();expect(node.textContent).not.toContain('Чтение черновика…');});}
 async function reopen(){await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await mount();}
 try{
  await mount();await wait(()=>expect(node.textContent).toContain(source.batchName));await edit('Источник номеров формирования',source.id);await edit('Явные номера обработанных ячеек','10; 12');await edit('Основание номеров формирования','Actual channel sheet');await wait(()=>expect(node.textContent).toContain('Черновик формы сохранён'));
  await reopen();expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('10; 12');expect(await db.formationSerialIdentities.count()).toBe(0);
  let operation='';const fail=(_key:unknown,row:{id:string})=>{operation=row.id;throw Error('Identity journal unavailable');};db.journal.hook('creating',fail);
  try{await click('Сохранить исходное заявление номеров');await wait(()=>expect(node.textContent).toContain('Identity journal unavailable'));expect(await db.formationSerialIdentities.count()).toBe(0);}finally{db.journal.hook('creating').unsubscribe(fail);}
  await reopen();expect(node.textContent).toContain(operation);expect(node.querySelector('fieldset')?.disabled).toBe(true);
  await click('Сохранить исходное заявление номеров');await wait(()=>expect(node.textContent).toContain('Передать исходное заявление номеров'));
  const saved=await db.formationSerialIdentities.get(source.id);expect(saved?.id).toBe(operation);expect(saved?.ranges).toEqual([{start:10,end:10},{start:12,end:12}]);expect(saved?.source).toEqual(source);expect(await db.formationRuns.get(source.id)).toEqual(source);expect(await db.formationSerialIdentities.count()).toBe(1);
  await click('Передать исходное заявление номеров');await wait(()=>expect(node.textContent).toContain('Exported formation-serial-identity'));
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
