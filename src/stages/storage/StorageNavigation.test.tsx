import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {StageId,UserRole,type User} from '../../core/types';
import {saveStorageEvent,type StorageReceipt} from '../../core/manufacturing/storageReceipts';
import {useAuthStore} from '../../core/store/authStore';
import {StorageModule} from './StorageModule';

let node:HTMLDivElement|undefined,root:Root|undefined;
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount());
 root=undefined;node?.remove();node=undefined;
 useAuthStore.setState({currentUser:null});
 db.close();await db.delete();vi.unstubAllGlobals();
});
async function mount() {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 await db.open();
 const user:User={id:'warehouse',login:'warehouse',fullName:'Warehouse operator',
   password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};
 await db.users.add(user);useAuthStore.setState({currentUser:user});
 node=document.createElement('div');document.body.appendChild(node);
 root=createRoot(node);
 await act(async()=>root!.render(<StorageModule/>));
 await vi.waitFor(()=>expect(node!.querySelector<HTMLInputElement>('[aria-label="Материал"]')).toBeTruthy());
 return node!;
}
async function fill(label:string,value:string){
 const input=node!.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]');
 expect(input,label).toBeTruthy();
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input!.dispatchEvent(new Event('input',{bubbles:true}));
 });
}
async function click(text:string){
 const button=[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes(text));
 expect(button,text).toBeTruthy();
 await act(async()=>button!.click());
}
it('keeps unfinished receipt and failed retry ID until explicit discard confirmation',async()=>{
 const page=await mount();
 await fill('Материал','PVDF');
 await fill('Код партии материала','LOT-7');
 await click('Новое поступление');
 expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain('незавершённые');
 expect(page.querySelector<HTMLInputElement>('[aria-label="Материал"]')?.value).toBe('PVDF');
 await click('Оставить текущую форму');
 expect(page.querySelector('[role="alertdialog"]')).toBeNull();
 expect(page.querySelector<HTMLInputElement>('[aria-label="Код партии материала"]')?.value).toBe('LOT-7');
 await vi.waitFor(async()=>{
  const row=await db.localFormDrafts.get(JSON.stringify(['warehouse','storage']));
  expect((row?.payload as {draft:{material:string}}).draft.material).toBe('PVDF');
 });
 expect(await db.journal.count()).toBe(0);
 await click('Новое поступление');
 await click('Сбросить незавершённую форму');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Материал"]')?.value).toBe(''));
 expect(page.querySelector('[role="alertdialog"]')).toBeNull();
 expect(await db.journal.count()).toBe(0);
});
it('does not discard an unfinished receipt when a different recorded lot is opened',async()=>{
 const page=await mount();
 const receipt:StorageReceipt={version:1,kind:'receipt',id:'storage:saved-lot',
  material:'Lithium carbonate',lotCode:'L-001',quantity:4,unit:'kg',location:'Shelf A',
  evidence:'Physical incoming receipt',actorId:'warehouse',actorRole:UserRole.WORKER,recordedAt:Date.now()};
 await saveStorageEvent(receipt,'warehouse');
 await vi.waitFor(()=>expect(page.textContent).toContain('Lithium carbonate'));
 await fill('Материал','PVDF');
 await fill('Код партии материала','UNSAVED-2');
 await click('История и место');
 expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain('Открыть другую партию');
 expect(page.querySelector<HTMLInputElement>('[aria-label="Материал"]')?.value).toBe('PVDF');
 expect(page.textContent).not.toContain('История партии L-001');
 await click('Оставить текущую форму');
 expect(page.querySelector<HTMLInputElement>('[aria-label="Код партии материала"]')?.value).toBe('UNSAVED-2');
 await click('История и место');
 await click('Сбросить незавершённую форму');
 await vi.waitFor(()=>expect(page.textContent).toContain('История партии L-001'));
 expect((await db.journal.toArray())).toHaveLength(1);
 expect((await db.journal.get('storage:saved-lot'))?.stage).toBe(StageId.STORAGE);
});

it('protects unfinished location fields on Back and Refresh without editing saved history',async()=>{
 const page=await mount();
 const receipt:StorageReceipt={version:1,kind:'receipt',id:'storage:location-lot',
   material:'NMC powder',lotCode:'L-002',quantity:6,unit:'kg',location:'A-01',
   evidence:'Received and counted',actorId:'warehouse',actorRole:UserRole.WORKER,recordedAt:Date.now()};
 await saveStorageEvent(receipt,'warehouse');
 await vi.waitFor(()=>expect(page.textContent).toContain('NMC powder'));
 await click('История и место');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Новое место"]')).toBeTruthy());
 await fill('Новое место','A-02');
 await fill('Основание смены места','Observed by operator');
 await click('К поступлениям');
 expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain('Вернуться к поступлениям');
 expect(page.querySelector<HTMLInputElement>('[aria-label="Новое место"]')?.value).toBe('A-02');
 await click('Оставить текущую форму');
 await click('Обновить историю явно');
 expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain('Обновить историю партии');
 expect(page.querySelector<HTMLInputElement>('[aria-label="Основание смены места"]')?.value).toBe('Observed by operator');
 await click('Оставить текущую форму');
 expect(await db.journal.count()).toBe(1);
 await click('Обновить историю явно');
 await click('Сбросить незавершённую форму');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Новое место"]')?.value).toBe(''));
 expect(page.textContent).toContain('Последнее место: A-01');
 expect(await db.journal.count()).toBe(1);
});
