import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, initializeDatabase } from '../../core/db';
import { exportLocalBackup } from '../../core/db/localBackup';
import { useAuthStore } from '../../core/store/authStore';
import { AuthService } from '../auth/services/AuthService';
import { UsersModule } from './UsersModule';

let root:Root|undefined;
let container:HTMLDivElement|undefined;
async function mount(){
  container=document.createElement('div');
  document.body.appendChild(container);
  root=createRoot(container);
  await act(async()=>{
    root!.render(<UsersModule/>);
    await Promise.resolve();
  });
  return container;
}
function setInput(element:HTMLInputElement,value:string){
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);
  element.dispatchEvent(new Event('input',{bubbles:true}));
}
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;container?.remove();container=undefined;
  useAuthStore.getState().logout();
  db.close();await db.delete();
  vi.restoreAllMocks();
});

describe('real local employee management',()=>{
  it('renders real profiles rather than default demo staff and saves an employee',async()=>{
    await initializeDatabase();
    const chief=await AuthService.createFirstLocalAdmin({
      fullName:'Production Admin',login:'chief.actual',password:'secret-password-2026',
    });
    useAuthStore.getState().login(chief);
    const screen=await mount();
    await vi.waitFor(()=>expect(screen.textContent).toContain('Production Admin'));
    expect(screen.textContent).not.toContain('Козлов Д.С.');
    await act(async()=>{
      [...screen.querySelectorAll('button')].find(x=>x.textContent?.includes('Добавить сотрудника'))!.click();
    });
    const form=screen.querySelector('form')!;
    const inputs=[...form.querySelectorAll('input')];
    await act(async()=>{
      setInput(inputs[0],'Worker Real');
      setInput(inputs[1],'worker.real');
      setInput(inputs[2],'worker-secret-2026');
    });
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
    });
    await vi.waitFor(async()=>expect(await db.users.count()).toBe(2));
    expect((await AuthService.login('WORKER.REAL','worker-secret-2026'))?.fullName).toBe('Worker Real');
    await vi.waitFor(()=>expect(screen.textContent).toContain('Worker Real'));
    expect(screen.textContent).not.toContain('Козлов Д.С.');
  });
  it('checks an archived file without overwriting local work',async()=>{
    await initializeDatabase();
    const chief=await AuthService.createFirstLocalAdmin({
      fullName:'Local Tester',login:'local.test',password:'test-password-2026',
    });
    await db.table('journal').put({id:'test-entry',stage:'storage',workerId:chief.id});
    const archive=await exportLocalBackup();
    useAuthStore.getState().login(chief);
    const screen=await mount();
    const picker=screen.querySelector('#verify-local-backup') as HTMLInputElement;
    expect(picker).toBeTruthy();
    const transfer=new DataTransfer();
    transfer.items.add(new File([archive],'backup.json',{type:'application/json'}));
    picker.files=transfer.files;
    await act(async()=>{
      picker.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
    });
    await vi.waitFor(()=>expect(screen.textContent).toContain('Файл прошёл проверку'));
    expect(screen.textContent).toContain('записей: 2');
    expect(await db.table('journal').get('test-entry')).toBeDefined();
  });

});
