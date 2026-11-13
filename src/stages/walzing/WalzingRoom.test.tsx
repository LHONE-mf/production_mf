import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {WalzingRoom} from './WalzingRoom';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved walzing packet</p>}));
it('requires explicit whole counts, retains an atomic failed draft and retries one saved result before export',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const worker:User={id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};await db.users.add(worker);useAuthStore.setState({currentUser:worker});
 const now=new Date().toISOString();await db.walzingIncoming.add({id:'old',batchName:'Historical job',cellsIn:4,receivedAt:now,updatedAt:now});
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const click=async(text:string)=>act(async()=>{[...node.querySelectorAll('button')].find(button=>button.textContent?.includes(text))!.click();});
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
 const fill=async(label:string,value:string)=>act(async()=>{const input=node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(<WalzingRoom/>));await wait(()=>expect(node.textContent).toContain('Historical job'));await click('Взять в работу');
  await click('Сохранить и передать');await wait(()=>expect(node.textContent).toContain('Пустое значение не считается нулём'));expect(await db.walzRuns.count()).toBe(0);
  for(const [label,value]of [['Подано ячеек','4'],['Обработано (без QA)','3.5'],['Отклонено','0.5'],['Не определено','0']])await fill(label,value);
  await click('Сохранить и передать');await wait(()=>expect(node.textContent).toContain('целые количества'));
  await fill('Обработано (без QA)','3');await fill('Отклонено','1');
  let id='';const fail=(_key:unknown,row:{id:string})=>{id=row.id;throw Error('Walzing journal failed');};db.journal.hook('creating',fail);
  try{await click('Сохранить и передать');await wait(()=>expect(node.textContent).toContain('Walzing journal failed'));expect(await db.walzRuns.count()).toBe(0);expect(node.textContent).not.toContain('Saved walzing packet');}finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Обработано (без QA)"]')!.value).toBe('3');
  await act(async()=>{const b=[...node.querySelectorAll('button')].find(button=>button.textContent?.includes('Сохранить и передать'))!;b.click();b.click();});await wait(()=>expect(node.textContent).toContain('Saved walzing packet'));
  expect(await db.walzRuns.count()).toBe(1);expect((await db.walzRuns.toArray())[0].id).toBe(id);expect(await db.journal.get(id)).toBeDefined();
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
