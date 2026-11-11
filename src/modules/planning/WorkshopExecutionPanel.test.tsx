import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setServerConnection, clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { WorkshopExecutionPanel } from './WorkshopExecutionPanel';

const connection: ServerConnection = {
  session:{serverUrl:'https://mes.example.org',accessToken:'scoped-master'},
  serverUrl:'https://mes.example.org',organizationId:'tenant',serverRole:'master',
  serverActorId:'master-1',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[],
};
let root: Root|undefined;
let container: HTMLDivElement|undefined;
async function mount(){
  container=document.createElement('div');document.body.appendChild(container);
  root=createRoot(container);
  await act(async()=>{root!.render(<WorkshopExecutionPanel connection={connection}/>);await Promise.resolve();});
  return container;
}
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;container?.remove();container=undefined;
  clearServerConnection();vi.unstubAllGlobals();
});
describe('Workshop execution list',()=>{
  it('opens only a returned workshop batch and does not request order-wide records',async()=>{
    const fetchMock=vi.fn(async(url:string)=>{
      if(url.endsWith('/workshop-batches'))return {ok:true,json:async()=>({
        batches:[{id:'batch-1',batchCode:'CATH-001',status:'in_progress',quantityUnit:'kg'}],
        hasMore:false,
      })};
      if(url.endsWith('/handoff-candidate'))return {ok:true,json:async()=>({
        batchId:'batch-1',candidate:null,
      })};
      return {ok:true,json:async()=>({batchId:'batch-1',steps:[
        {number:2,name:'Cutting',stage:'cutting',workshopId:'cutting',evidence:null},
      ]})};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('CATH-001');
    expect(screen.textContent).not.toContain('Новый производственный заказ');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const open=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Открыть журнал')!;
    await act(async()=>{open.click();await Promise.resolve();});
    expect(screen.textContent).toContain('Cutting');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(call=>!String(call[0]).endsWith('/planning/orders'))).toBe(true);
  });

  it('removes revoked batches and their evidence panels after refresh',async()=>{
    let canSee=true;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(url.endsWith('/workshop-batches'))return {ok:true,json:async()=>({
        batches:canSee?[{id:'batch-1',batchCode:'CATH-001',status:'in_progress',quantityUnit:'kg'}]:[],
        hasMore:false,
      })};
      return {ok:true,json:async()=>({batchId:'batch-1',steps:[]})};
    }));
    setServerConnection(connection);
    const screen=await mount();
    const open=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Открыть журнал')!;
    await act(async()=>{open.click();await Promise.resolve();});
    expect(screen.textContent).toContain('CATH-001');
    canSee=false;
    const refresh=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Обновить партии')!;
    await act(async()=>{refresh.click();await Promise.resolve();});
    expect(screen.textContent).not.toContain('CATH-001');
    expect(screen.textContent).toContain('Нет партий');
  });

  it('ignores obsolete authentication failures after a newer login',async()=>{
    let release:(v:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{release=resolve;})));
    setServerConnection(connection);
    const screen=await mount();
    setServerConnection({...connection,session:{...connection.session,accessToken:'newer-master'}});
    await act(async()=>{release({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('newer-master');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });

  it('rejects malformed server batch lists before rendering untrusted data',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      batches:[{id:'batch-1',batchCode:'CATH-001',status:'invalid',quantityUnit:'kg'}],
      hasMore:false,
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).not.toContain('CATH-001');
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('неверный список');
  });
});
