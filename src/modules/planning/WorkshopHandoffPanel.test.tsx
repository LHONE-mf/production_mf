import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, getServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { WorkshopHandoffPanel } from './WorkshopHandoffPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'workshop-master'},
  serverUrl:'https://mes.example.org',organizationId:'org',serverRole:'master',
  serverActorId:'master',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[],
};
let root:Root|undefined;let container:HTMLDivElement|undefined;
async function mount(){
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  await act(async()=>{root!.render(<WorkshopHandoffPanel connection={connection} batchId="batch-1"/>);await Promise.resolve();});
  return container;
}
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;container?.remove();container=undefined;clearServerConnection();vi.unstubAllGlobals();
});
const option={batchId:'batch-1',candidate:{
  fromStep:2,toStep:3,fromName:'Cutting',toName:'Sorting',quantityUnit:'kg',
}};
describe('Workshop transfer declaration',()=>{
  it('uses a scoped server candidate and validates the immutable handoff acknowledgement',async()=>{
    const posts:Record<string,unknown>[]=[];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        const payload=JSON.parse(String(options.body)) as Record<string,unknown>;
        posts.push(payload);
        return {ok:true,json:async()=>({id:payload.handoffId,status:'sent'})};
      }
      return {ok:true,json:async()=>posts.length?{batchId:'batch-1',candidate:null}:option};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Cutting');
    const input=screen.querySelector('input[aria-label="Количество передачи цеха"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'12.5');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const button=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Отправить передачу')!;
    await act(async()=>{button.click();await Promise.resolve();});
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({fromStep:2,toStep:3,quantity:'12.5',quantityUnit:'kg'});
    expect(screen.textContent).toContain('Другой сотрудник');
    expect(screen.textContent).toContain('Нет доступной передачи');
    expect(fetchMock.mock.calls.some(call=>String(call[0]).includes('/planning/orders'))).toBe(false);
  });
  it('keeps the stable request ID after a lost reply for safe retry',async()=>{
    const ids:string[]=[];let attempts=0;
    vi.stubGlobal('fetch',vi.fn(async(_url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        const payload=JSON.parse(String(options.body));
        ids.push(payload.handoffId);attempts++;
        if(attempts===1)return {ok:false,status:503,json:async()=>({error:'network_lost'})};
        return {ok:true,json:async()=>({id:payload.handoffId,status:'already_sent'})};
      }
      return {ok:true,json:async()=>option};
    }));
    setServerConnection(connection);
    const screen=await mount();
    const input=screen.querySelector('input[aria-label="Количество передачи цеха"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'5');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const send=()=>[...screen.querySelectorAll('button')].find(b=>b.textContent==='Отправить передачу')!;
    await act(async()=>{send().click();await Promise.resolve();});
    expect(screen.querySelector('[role="alert"]')).toBeTruthy();
    await act(async()=>{send().click();await Promise.resolve();});
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(screen.textContent).toContain('Другой сотрудник');
  });
  it('ignores an obsolete unauthorized option response when the login changes',async()=>{
    let resolve:(v:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=r;})));
    setServerConnection(connection);const screen=await mount();
    setServerConnection({...connection,session:{...connection.session,accessToken:'replacement'}});
    await act(async()=>{resolve({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('replacement');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });
});
