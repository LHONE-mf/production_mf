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
        hasMore:false,nextAfter:null,
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
        hasMore:false,nextAfter:null,
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

  it('appends older pages without duplicate rows or order-wide access',async()=>{
    const ids=Array.from({length:102},(_,i)=>
      '00000000-0000-4000-8000-'+String(i).padStart(12,'0'));
    const first=ids.slice(0,100).map((id,i)=>({
      id,batchCode:'BATCH-'+i,status:'created',quantityUnit:'kg',
    }));
    const later=[first[99],...ids.slice(100).map((id,i)=>({
      id,batchCode:'OLDER-'+i,status:'completed',quantityUnit:'kg',
    }))];
    const fetchMock=vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith('/workshop-batches')
      ? {batches:first,hasMore:true,nextAfter:ids[99]}
      : {batches:later,hasMore:false,nextAfter:null},
    }));
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('BATCH-0');
    expect(screen.textContent).not.toContain('OLDER-0');
    const load=[...screen.querySelectorAll('button')]
      .find(b=>b.textContent==='Загрузить предыдущие партии')!;
    await act(async()=>{load.click();await Promise.resolve();});
    expect(screen.textContent).toContain('OLDER-0');
    expect([...screen.querySelectorAll('button')].filter(b=>b.textContent==='Открыть журнал'))
      .toHaveLength(102);
    expect(screen.textContent).not.toContain('Загрузить предыдущие партии');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/workshop-batches?after='+ids[99],
      expect.objectContaining({headers:expect.objectContaining({
        Authorization:'Bearer scoped-master',
      })}),
    );
    expect(fetchMock.mock.calls.every(call=>!String(call[0]).includes('/planning/orders'))).toBe(true);
  });

  it('preserves loaded batches if a later page fails and allows retry',async()=>{
    const cursor='11111111-1111-4111-8111-111111111111';
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/workshop-batches')
      ? {ok:true,json:async()=>({
          batches:[{id:cursor,batchCode:'START',status:'in_progress',quantityUnit:'kg'}],
          hasMore:true,nextAfter:cursor,
        })}
      : {ok:false,status:503,json:async()=>({error:'temporarily_unavailable'})}));
    setServerConnection(connection);
    const screen=await mount();
    const load=[...screen.querySelectorAll('button')]
      .find(b=>b.textContent==='Загрузить предыдущие партии')!;
    await act(async()=>{load.click();await Promise.resolve();});
    expect(screen.textContent).toContain('START');
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
    expect(screen.textContent).toContain('Загрузить предыдущие партии');
  });

  it('rejects malformed server batch lists before rendering untrusted data',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      batches:[{id:'batch-1',batchCode:'CATH-001',status:'invalid',quantityUnit:'kg'}],
      hasMore:false,nextAfter:null,
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).not.toContain('CATH-001');
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('неверный список');
  });
});
