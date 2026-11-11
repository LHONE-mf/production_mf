import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type AssemblyRun,type User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {FillRoom} from './FillRoom';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved packet preview</p>}));
it('persists a pending destination before preview and retries receipt with the same identity without leaking to another room',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const master:User={id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()};const receiver:User={...master,id:'receiver',login:'receiver',fullName:'Receiver',role:UserRole.WORKER};await db.users.bulkAdd([master,receiver]);useAuthStore.setState({currentUser:master});
 const source:AssemblyRun={id:'job',batchName:'Counted cells',cellType:'unassigned',ops:[{id:'cells',source:{kind:'declared',reference:'source'},substation:'crimp-cyl',workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]}],sourceLedger:1,operationLedger:1,cellsOut:0,cellsScrap:0,defects:[],workerId:'operator',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T13:00:00Z',cellOutput:{id:'output',operationId:'cells',count:4,cellType:'cylindrical',serialRange:{prefix:'MF-',start:10,end:13},recordedBy:'master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Count basis'}};await db.assemblyRuns.add(source);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const click=async(text:string)=>act(async()=>{[...node.querySelectorAll('button')].find(button=>button.textContent?.includes(text))!.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const input=node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(<FillRoom box="dry-room"/>));await vi.waitFor(()=>expect(node.textContent).toContain('заявлено 4'));
  const fail=()=>{throw Error('Instruction journal failed');};db.journal.hook('creating',fail);
  try{await click('Назначить в этот бокс');await vi.waitFor(()=>expect(node.textContent).toContain('Instruction journal failed'));expect(await db.electrolyteIncoming.count()).toBe(0);expect(node.textContent).not.toContain('Saved packet preview');}finally{db.journal.hook('creating').unsubscribe(fail);}
  await click('Назначить в этот бокс');await vi.waitFor(()=>expect(node.textContent).toContain('Ожидается явная приёмка'));expect((await db.electrolyteIncoming.toArray())[0].receivedAt).toBeUndefined();
  await act(async()=>root.render(<FillRoom box="floor7-room5"/>));await vi.waitFor(()=>expect(node.textContent).toContain('Передач в этот бокс пока нет'));expect(node.textContent).not.toContain('Saved packet preview');expect(node.textContent).not.toContain('Назначить в этот бокс');
  await act(async()=>{root.render(<FillRoom box="dry-room"/>);useAuthStore.setState({currentUser:receiver});});await vi.waitFor(()=>expect(node.querySelector('input[aria-label="Фактически принято, ячеек"]')).not.toBeNull());
  await fill('Фактически принято, ячеек','4');await fill('Основание приёмки','Count checked');
  let failedId='';const failReceipt=(_key:unknown,record:{id:string})=>{failedId=record.id;throw Error('Receipt journal failed');};db.journal.hook('creating',failReceipt);
  try{await click('Записать приёмку');await vi.waitFor(()=>expect(node.textContent).toContain('Receipt journal failed'));}finally{db.journal.hook('creating').unsubscribe(failReceipt);}
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Фактически принято, ячеек"]')!.value).toBe('4');
  await click('Записать приёмку');await vi.waitFor(()=>expect(node.textContent).toContain('Приёмка записана: 4'));expect((await db.electrolyteIncoming.toArray())[0].receipt?.id).toBe(failedId);
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
