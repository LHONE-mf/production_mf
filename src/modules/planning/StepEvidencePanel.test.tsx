import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, getServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import type { Batch } from '../../core/planning/planningClient';
import { StepEvidencePanel } from './StepEvidencePanel';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const connection: ServerConnection = {
  session: { serverUrl: 'https://mes.example.org', accessToken: 'memory-only-chief' },
  serverUrl: 'https://mes.example.org', organizationId: 'org-1',
  serverRole: 'chief', serverActorId: 'chief-1',
  selectedDeviceId: '', enrolledDeviceId: '', myDevices: [],
};
const batch: Batch = {
  id: 'cathode-batch-1', batchCode: 'CATH-001',
  materialLine: 'cathode', status: 'in_progress',
  plannedQuantity: '100.000000', quantityUnit: 'kg',
};
async function mount(input: Batch, onCompleted?: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StepEvidencePanel connection={connection} batch={input} onCompleted={onCompleted} />);
    await Promise.resolve();
  });
  return container;
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container?.remove(); container = undefined;
  clearServerConnection();
  vi.unstubAllGlobals();
});

describe('M2 route step evidence panel', () => {
  it('ignores an obsolete initial read failure after a newer login', async () => {
    let finish:(response:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
    setServerConnection(connection);
    const screen=await mount(batch);
    setServerConnection({...connection,session:{...connection.session,accessToken:'new-chief-session'}});
    await act(async()=>{finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-chief-session');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not let an old evidence write clear a newer login after unmount', async () => {
    let finish:(response:unknown)=>void=()=>{};
    const fetchMock=vi.fn(async(_url:string,options:RequestInit)=>{
      if(options.method==='POST')return new Promise(resolve=>{finish=resolve;});
      return {ok:true,json:async()=>({batchId:batch.id,steps:[
        {number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null},
      ]})};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount(batch);
    await act(async()=>{screen.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(fetchMock.mock.calls.filter(call=>call[1].method==='POST')).toHaveLength(1);
    await act(async()=>{root!.unmount();});root=undefined;
    setServerConnection({...connection,session:{...connection.session,accessToken:'new-chief-session'}});
    await act(async()=>{finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-chief-session');
  });

  it('clears the current login when its evidence read is unauthorized', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:401,json:async()=>({error:'unauthorized'})}));
    setServerConnection(connection);
    await mount(batch);
    expect(getServerConnection()).toBeNull();
  });

  it('shows versioned step evidence from the server and offers only possible follow-up events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ batchId: batch.id, steps: [
        { number: 1, name: 'Cathode coating', stage: 'coating', workshopId: 'coating',
          evidence: { id: 'event-1',kind: 'started',actorId: 'chief-1',
            quantity: null,quantityUnit: null,equipmentCode: 'LINE-01',
            note: null,recordedAt: '2026-11-10T10:00:00Z' } },
        { number: 2, name: 'Cathode cutting', stage: 'cutting', workshopId: 'cutting',
          evidence: null },
      ] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection(connection);
    const screen = await mount(batch);
    expect(screen.textContent).toContain('Журнал выполнения операций маршрута');
    expect(screen.textContent).toContain('Cathode coating');
    expect(screen.textContent).toContain('Cathode cutting');
    expect(screen.textContent).toContain('LINE-01');
    expect(screen.textContent).toContain('Начало операции');
    const eventChoice = screen.querySelector('select[aria-label="Тип записи операции"]');
    expect(eventChoice?.textContent).toContain('Завершение операции');
    expect(eventChoice?.textContent).toContain('Отклонение');
    expect(eventChoice?.textContent).not.toContain('Начало операции');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/batches/cathode-batch-1/steps',
      expect.objectContaining({ method: 'GET', cache: 'no-store',
        headers: expect.objectContaining({ Authorization: 'Bearer memory-only-chief' }) }),
    );
  });

  it('notifies the parent only after a confirmed completion, even if journal reload fails', async () => {
    const completed=vi.fn();
    let saved=false;
    const fetchMock=vi.fn(async(_url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        saved=true;
        return {ok:true,json:async()=>({
          id:'event-2',batchId:batch.id,stepNumber:1,kind:'completed',alreadyRecorded:false,
        })};
      }
      if(saved)return {ok:false,status:503,json:async()=>({error:'reload_unavailable'})};
      return {ok:true,json:async()=>({batchId:batch.id,steps:[{
        number:1,name:'Coating',stage:'coating',workshopId:'coating',
        evidence:{
          id:'event-1',kind:'started',actorId:'chief-1',
          quantity:null,quantityUnit:null,equipmentCode:null,
          note:null,recordedAt:'2026-11-11T05:00:00Z',
        },
      }]})};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount(batch,completed);
    expect(screen.textContent).toContain('Завершение операции');
    expect(completed).not.toHaveBeenCalled();
    const quantity=screen.querySelector('input[aria-label="Зафиксированное количество"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(quantity,'20');
      quantity.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{
      screen.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(screen.textContent).toContain('Запись сохранена, но обновление журнала не удалось');
  });

  it('does not report completion on a started event or failed completion', async () => {
    const completed=vi.fn();
    let initialStarted=false;
    const fetchMock=vi.fn(async(_url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        return {ok:false,status:503,json:async()=>({error:'write_failed'})};
      }
      return {ok:true,json:async()=>({batchId:batch.id,steps:[{
        number:1,name:'Coating',stage:'coating',workshopId:'coating',
        evidence:initialStarted?{
          id:'event-1',kind:'started',actorId:'chief-1',quantity:null,quantityUnit:null,
          equipmentCode:null,note:null,recordedAt:'2026-11-11T05:00:00Z',
        }:null,
      }]})};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount(batch,completed);
    await act(async()=>{
      screen.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    expect(completed).not.toHaveBeenCalled();
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
  });

  it('shows read-only records when a batch is held, without offering an evidence write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ batchId:batch.id, steps:[
        {number:1,name:'Cathode coating',stage:'coating',workshopId:'coating',evidence:null},
      ] }),
    }));
    setServerConnection(connection);
    const screen = await mount({ ...batch, status:'hold' });
    expect(screen.textContent).toContain('Cathode coating');
    expect(screen.querySelector('button[type="submit"]')).toBeNull();
  });
});
