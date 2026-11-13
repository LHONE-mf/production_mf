import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {StorageModule} from './StorageModule';
const outgoing=vi.hoisted(()=>({packet:null as unknown}));
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:({packet}:{packet:unknown})=>{outgoing.packet=packet;return <p>Saved storage history packet</p>;}}));
it('retains receipt fields and failed identity, saves once, and searches recorded lot/location history',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const worker:User={id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};await db.users.add(worker);useAuthStore.setState({currentUser:worker});
 const node=document.createElement('div');document.body.appendChild(node);let root=createRoot(node);
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
 const click=async(text:string)=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const input=node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(<StorageModule/>));await fill('Материал','Recorded powder');await fill('Код партии материала','LOT-1');await fill('Место получения','Shelf 1');await fill('Основание поступления','Weighed against document 17');await click('Записать поступление');await wait(()=>expect(node.textContent).toContain('пустое значение неизвестно'));expect(await db.journal.count()).toBe(0);
  await click('Журнал работ');await click('Инструмент');expect(node.querySelector<HTMLInputElement>('input[aria-label="Материал"]')!.value).toBe('Recorded powder');
  await fill('Количество поступления','2,125');await act(async()=>{const select=node.querySelector<HTMLSelectElement>('select[aria-label="Единица количества"]')!;select.value='kg';select.dispatchEvent(new Event('change',{bubbles:true}));});
  let failedId='';const fail=(_key:unknown,row:{id:string})=>{failedId=row.id;throw Error('Storage journal failed');};db.journal.hook('creating',fail);
  try{await click('Записать поступление');await wait(()=>expect(node.textContent).toContain('Storage journal failed'));expect(await db.journal.count()).toBe(0);}finally{db.journal.hook('creating').unsubscribe(fail);}
  await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await act(async()=>root.render(<StorageModule/>));
  await wait(()=>expect(node.querySelector<HTMLInputElement>('input[aria-label="Материал"]')?.value).toBe('Recorded powder'));
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Количество поступления"]')!.value).toBe('2,125');
  await act(async()=>{const b=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать поступление'))!;b.click();b.click();});await wait(()=>expect(node.textContent).toContain('Поступление записано'));
  expect(await db.journal.count()).toBe(1);expect((await db.journal.toArray())[0].id).toBe(failedId);
  await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await act(async()=>root.render(<StorageModule/>));await wait(()=>expect(node.textContent).toContain('Поступление записано'));

  await fill('Поиск поступлений','not-found');await wait(()=>expect(node.textContent).toContain('Совпадений нет'));await fill('Поиск поступлений','lot-1');await wait(()=>expect(node.textContent).toContain('Recorded powder'));await click('История и место');await fill('Новое место','Shelf 2');await fill('Основание смены места','Observed placement');await wait(()=>expect(node.textContent).toContain('Черновик формы сохранён на устройстве'));
  await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await act(async()=>root.render(<StorageModule/>));await wait(()=>expect(node.querySelector<HTMLInputElement>('input[aria-label="Новое место"]')?.value).toBe('Shelf 2'));
  let moveId='';const failMove=(_key:unknown,row:{id:string})=>{moveId=row.id;throw Error('Location write failed');};db.journal.hook('creating',failMove);
  try{await click('Записать место');await wait(()=>expect(node.textContent).toContain('Location write failed'));expect(await db.journal.count()).toBe(1);}finally{db.journal.hook('creating').unsubscribe(failMove);}
  await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await act(async()=>root.render(<StorageModule/>));await wait(()=>expect(node.querySelector<HTMLInputElement>('input[aria-label="Новое место"]')?.value).toBe('Shelf 2'));await click('Записать место');await wait(()=>expect(node.textContent).toContain('Место записано'));expect(await db.journal.count()).toBe(2);expect(await db.journal.get(moveId)).toBeDefined();
  await act(async()=>root.unmount());root=createRoot(node);await act(async()=>root.render(<StorageModule/>));await wait(()=>expect(node.textContent).toContain('Место записано'));expect(await db.journal.count()).toBe(2);

  await click('Обновить историю явно');const failExport=()=>{throw Error('Export must not write');};db.journal.hook('creating',failExport);
  try{await click('Передать сохранённую историю');await wait(()=>expect(node.textContent).toContain('Saved storage history packet'));expect((outgoing.packet as {payload:{entries:unknown[]}}).payload.entries).toHaveLength(2);expect(await db.journal.count()).toBe(2);}finally{db.journal.hook('creating').unsubscribe(failExport);}
  const row=(await db.localFormDrafts.toArray())[0];const invalid={...row.payload as Record<string,unknown>,selected:undefined};await act(async()=>root.unmount());await db.localFormDrafts.update(row.key,{payload:invalid});root=createRoot(node);await act(async()=>root.render(<StorageModule/>));await wait(()=>expect(node.querySelector('[role="alert"]')).not.toBeNull());expect(node.querySelector('input[aria-label="Материал"]')).toBeNull();expect((await db.localFormDrafts.get(row.key))?.payload).toEqual(invalid);

 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
