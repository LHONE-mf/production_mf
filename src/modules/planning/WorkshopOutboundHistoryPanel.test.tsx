import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, getServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { WorkshopOutboundHistoryPanel } from './WorkshopOutboundHistoryPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'master-outbound'},
  serverUrl:'https://mes.example.org',organizationId:'org',serverRole:'master',
  serverActorId:'master',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[],
};
let root:Root|undefined,container:HTMLDivElement|undefined;
async function mount(){
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  await act(async()=>{
    root!.render(<WorkshopOutboundHistoryPanel connection={connection} batchId="batch-1"/>);
    await Promise.resolve();
  });
  return container;
}
afterEach(async()=>{
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;container?.remove();container=undefined;
  clearServerConnection();vi.unstubAllGlobals();
});
const transfer={
  id:'transfer-1',fromStep:1,toStep:2,fromWorkshopId:'coating',toWorkshopId:'cutting',
  quantity:'20.000000',quantityUnit:'kg',sentBy:'master',sentAt:'2026-11-11T05:00:00Z',
  note:'Material labeled',receivedBy:null,receivedAt:null,receiptNote:null,
};
describe('Workshop outbound handoff history',()=>{
  it('shows an immutable send record and refreshes its independent receipt',async()=>{
    let received=false;
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({
      batchId:'batch-1',hasMore:false,handoffs:[received?{
        ...transfer,receivedBy:'different-master',receivedAt:'2026-11-11T05:30:00Z',
        receiptNote:'Count verified',
      }:transfer],
    })}));
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Передачи из моих цехов');
    expect(screen.textContent).toContain('20.000000 kg');
    expect(screen.textContent).toContain('Ожидает приёмки');
    received=true;
    const refresh=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Обновить историю')!;
    await act(async()=>{refresh.click();await Promise.resolve();});
    expect(screen.textContent).toContain('Получено');
    expect(screen.textContent).toContain('Count verified');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/workshop-batches/batch-1/outbound-handoffs',
      expect.objectContaining({headers:expect.objectContaining({
        Authorization:'Bearer master-outbound',
      })}),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not display malformed or truncated audit history as a complete record',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({
      batchId:'batch-1',hasMore:true,handoffs:[{...transfer,receivedBy:'other',receivedAt:null}],
    })}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).not.toContain('Material labeled');
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('неверный журнал');
  });
  it('ignores an obsolete unauthorized read after a newer login',async()=>{
    let finish:(value:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
    setServerConnection(connection);const screen=await mount();
    setServerConnection({...connection,session:{...connection.session,accessToken:'new-session'}});
    await act(async()=>{finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-session');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });
});
