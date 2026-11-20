import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {useAuthStore} from '../../core/store/authStore';
import {UserRole,type User} from '../../core/types';
import {inventoryOutbox} from '../../core/sync/inventoryOutbox';
import {setServerConnection} from '../../core/sync/serverConnection';
import {StorageModule} from './StorageModule';

it('lets an unconnected warehouse user save a real pending receipt for later server sync',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await inventoryOutbox.delete();await inventoryOutbox.open();
 const user:User={id:'warehouse-local',login:'warehouse',fullName:'Warehouse',password:'test-only',
  role:UserRole.WORKER,isActive:true,createdAt:new Date()};
 useAuthStore.getState().login(user);setServerConnection(null);
 const node=document.createElement('div');document.body.appendChild(node);
 const root=createRoot(node);
 const click=async(label:string)=>act(async()=>{
  const item=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes(label));
  expect(item).toBeDefined();item!.click();
 });
 const fill=async(label:string,value:string)=>act(async()=>{
  const el=node.querySelector<HTMLInputElement>('[aria-label="'+label+'"]');
  expect(el).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);
  el!.dispatchEvent(new Event('input',{bubbles:true}));
 });
 try{
  await act(async()=>root.render(<StorageModule/>));
  await click('Добавить локальное поступление для синхронизации');
  expect(node.textContent).toContain('синхронизация с сервером');
  await fill('Код или точное название материала','PVDF');
  await fill('Место склада (название или полный путь)','Склад / Полка 1');
  await fill('Партия изготовителя','LOT-501');
  await fill('Фактически принятое количество','5');
  await fill('Документ поступления','IN-501');
  await fill('Основание фактической приёмки','Физически пересчитано');
  await click('Сохранить поступление для синхронизации');
  await vi.waitFor(()=>expect(node.textContent).toContain('Ожидает подключения'));
  const rows=await inventoryOutbox.localReceipts.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({localActorId:user.id,materialCode:'PVDF',manufacturerLot:'LOT-501',state:'pending'});
  expect(await inventoryOutbox.stocks.count()).toBe(0);
  expect(await inventoryOutbox.operations.count()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  await act(async()=>root.unmount());inventoryOutbox.close();await inventoryOutbox.open();
  const second=createRoot(node);
  try{await act(async()=>second.render(<StorageModule/>));
   await click('Добавить локальное поступление для синхронизации');
   await vi.waitFor(()=>expect(node.textContent).toContain('LOT-501'));
   expect(await inventoryOutbox.localReceipts.count()).toBe(1);
  }finally{await act(async()=>second.unmount());}
 }finally{
  if(node.childNodes.length){/* React already unmounted when testing restart. */}
  node.remove();setServerConnection(null);useAuthStore.getState().logout();
  inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();
 }
});
