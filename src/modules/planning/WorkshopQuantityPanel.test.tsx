import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setServerConnection, getServerConnection, clearServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { WorkshopQuantityPanel } from './WorkshopQuantityPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'master-quantity'},
  serverUrl:'https://mes.example.org',organizationId:'org',
  serverRole:'master',serverActorId:'master',selectedDeviceId:'',
  enrolledDeviceId:'',myDevices:[],
};
let root:Root|undefined,container:HTMLDivElement|undefined;
async function mount(){
  container=document.createElement('div');document.body.appendChild(container);
  root=createRoot(container);
  await act(async()=>{
    root!.render(<WorkshopQuantityPanel connection={connection} batchId="batch-1"/>);
    await Promise.resolve();
  });
  return container;
}
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;container?.remove();container=undefined;clearServerConnection();
  vi.unstubAllGlobals();
});
const comparison={batchId:'batch-1',hasMore:false,steps:[{
  number:2,name:'Cutting',workshopId:'cutting',nextStep:3,
  output:{quantity:'70.250001',unit:'kg'},
  handoff:{id:'transfer-1',quantity:'65.125999',unit:'kg',received:true},
  difference:'5.124002',
  input:{id:'incoming-1',quantity:'75.375000',unit:'kg',received:true},
  inputDifference:'5.124999',
}]};
describe('Workshop quantity declaration comparison',()=>{
  it('shows exact decimal difference only for the assigned stage',async()=>{
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>comparison});
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Cutting');
    expect(screen.textContent).toContain('70.250001 kg');
    expect(screen.textContent).toContain('65.125999 kg');
    expect(screen.textContent).toContain('5.124002 kg');
    expect(screen.textContent).toContain('75.375000 kg');
    expect(screen.textContent).toContain('5.124999 kg');
    expect(screen.textContent).toContain('Входящая приёмка подтверждена');
    expect(screen.textContent).toContain('не доказывают потери');
    expect(screen.textContent).not.toContain('Coating');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/workshop-batches/batch-1/quantity-comparison',
      expect.objectContaining({headers:expect.objectContaining({
        Authorization:'Bearer master-quantity',
      })}),
    );
  });
  it('refuses an inconsistent server difference without rounding it',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      ...comparison,steps:[{...comparison.steps[0],difference:'5.124003'}],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('неверное сравнение');
    expect(screen.textContent).not.toContain('5.124003');
  });
  it('distinguishes an unrecorded transfer from a zero discrepancy',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      ...comparison,steps:[{...comparison.steps[0],handoff:null,difference:null}],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Передача ещё не записана');
    expect(screen.textContent).not.toContain('Разность деклараций:');
  });
  it('displays a sent but unreceived incoming quantity without treating it as accepted output',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      ...comparison,steps:[{
        ...comparison.steps[0],
        input:{...comparison.steps[0].input,received:false},
        inputDifference:null,
      }],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('75.375000 kg');
    expect(screen.textContent).toContain('Входящая приёмка ожидается');
    expect(screen.textContent).not.toContain('Разность принятого входа и выхода:');
  });
  it('rejects invented input-to-output differences and premature comparisons',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      ...comparison,steps:[{
        ...comparison.steps[0],
        input:{...comparison.steps[0].input,received:false},
        inputDifference:'5.124999',
      }],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('неверное сравнение');
    expect(screen.textContent).not.toContain('5.124999 kg');
  });
  it('shows a missing inbound declaration without inventing a difference',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      ...comparison,steps:[{...comparison.steps[0],input:null,inputDifference:null}],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Входящая передача: Не зарегистрирована');
    expect(screen.textContent).not.toContain('Разность принятого входа и выхода:');
  });
  it('ignores an obsolete 401 after login replacement',async()=>{
    let finish:(data:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
    setServerConnection(connection);const screen=await mount();
    setServerConnection({...connection,session:{...connection.session,accessToken:'new-login'}});
    await act(async()=>{finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-login');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });
});
