import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, getServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { QuantityFlowPanel } from './QuantityFlowPanel';

const connection: ServerConnection = {
  session: { serverUrl:'https://mes.example.org',accessToken:'memory-only-chief' },
  serverUrl:'https://mes.example.org', organizationId:'org-1',
  serverRole:'chief', serverActorId:'chief-1',
  selectedDeviceId:'', enrolledDeviceId:'', myDevices:[],
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QuantityFlowPanel connection={connection} batchId="batch-1" />);
    await Promise.resolve();
  });
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  clearServerConnection();
  vi.unstubAllGlobals();
});

describe('M2 online quantity flow', () => {
  it('ignores a manual refresh response after selecting a different batch',async () => {
    const response=(batchId:string,name:string) => ({ok:true,json:async () => ({batchId,steps:[{
      number:1,name,workshopId:'cut',nextStep:null,output:null,handoff:null,difference:null,
    }]})});
    let finish:(body:ReturnType<typeof response>)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn()
      .mockResolvedValueOnce(response('batch-1','INITIAL'))
      .mockImplementationOnce(()=>new Promise<ReturnType<typeof response>>(resolve=>{finish=resolve;}))
      .mockResolvedValueOnce(response('batch-2','CURRENT BATCH')));
    setServerConnection(connection);
    const screen=await mount();
    await act(async () => {screen.querySelector('button')!.click();});
    await act(async () => {root!.render(<QuantityFlowPanel connection={connection} batchId="batch-2" />);});
    expect(screen.textContent).toContain('CURRENT BATCH');
    await act(async () => {finish(response('batch-1','OBSOLETE BATCH'));});
    expect(screen.textContent).toContain('CURRENT BATCH');
    expect(screen.textContent).not.toContain('OBSOLETE BATCH');
  });

  it('does not clear a newer server login when an old manual refresh returns 401',async () => {
    let finish:(body:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn()
      .mockResolvedValueOnce({ok:true,json:async()=>({batchId:'batch-1',steps:[]})})
      .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
      .mockResolvedValueOnce({ok:true,json:async()=>({batchId:'batch-2',steps:[]})}));
    setServerConnection(connection);
    const screen=await mount();
    await act(async () => {screen.querySelector('button')!.click();});
    const next={...connection,session:{...connection.session,accessToken:'new-actor-token'}};
    await act(async () => {
      setServerConnection(next);
      root!.render(<QuantityFlowPanel connection={next} batchId="batch-2" />);
    });
    await act(async () => {finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-actor-token');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a traceable local reference and exact difference without declaring reconciliation or QA acceptance',async () => {
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async () => ({batchId:'batch-1',steps:[{
      number:1,name:'Calendering',workshopId:'calender',nextStep:null,
      output:{quantity:'999999999999.999998',unit:'m'},handoff:null,difference:null,
      sourceComparison:{status:'compared',sourceCount:1,difference:'-0.000001',source:{
        linkId:'link-1',sourceEntryId:'local-1',summary:'Каландрирование: рулон 42',
        measure:{kind:'calendered_length_m',value:'999999999999.999999'},
      }},
    }]})});
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Каландрирование: рулон 42');
    expect(screen.textContent).toContain('999999999999.999999');
    expect(screen.textContent).toContain('Заявленный выход минус локальная запись: -0.000001 m');
    expect(screen.textContent).toContain('local-1');
    expect(screen.textContent).toContain('не подтверждает качество');
    expect(fetchMock.mock.calls.every(call => call[1].method==='GET')).toBe(true);
  });

  it.each([
    ['reference_only',1,'Входной или частичный показатель'],
    ['output_missing',1,'Заявленный выход операции ещё не записан'],
    ['unit_mismatch',1,'Единицы измерения различаются'],
    ['multiple_sources',2,'Несколько локальных величин'],
    ['no_source',0,'Нет привязанной локальной величины'],
  ])('explains %s without calculating a material balance',async (status,sourceCount,message) => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async () => ({batchId:'batch-1',steps:[{
      number:1,name:'Sorting',workshopId:'sort',nextStep:null,
      output:status==='output_missing' ? null : {quantity:'100.000000',unit:status==='unit_mismatch'?'kg':'pieces'},
      handoff:null,difference:null,
      sourceComparison:{status,sourceCount,source:sourceCount===1 ? {
        linkId:'link-1',sourceEntryId:'local-1',summary:'Local snapshot',
        measure:{kind:status==='reference_only'?'sort_input_good_pieces':'cut_good_pieces',value:'100.000000'},
      }:null,difference:null},
    }]})}));
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain(message);
    expect(screen.textContent).not.toContain('Заявленный выход минус локальная запись:');
  });

  it('shows exact quantities and warns that an unmatched value is not measured waste', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok:true,
      json:async () => ({batchId:'batch-1',steps:[
        {number:1,name:'Cathode coating',workshopId:'coating',nextStep:2,
          output:{quantity:'70.250001',unit:'kg'},
          handoff:{id:'handoff-1',quantity:'65.125999',unit:'kg',received:false},
          difference:'5.124002'},
        {number:2,name:'Cathode cutting',workshopId:'cutting',nextStep:null,
          output:{quantity:'60.000000',unit:'kg'},handoff:null,difference:null},
      ]}),
    });
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen = await mount();
    expect(screen.textContent).toContain('Сверка количеств по маршруту');
    expect(screen.textContent).toContain('70.250001 kg');
    expect(screen.textContent).toContain('65.125999 kg');
    expect(screen.textContent).toContain('5.124002 kg');
    expect(screen.textContent).toContain('Приёмка ожидается');
    expect(screen.textContent).toContain('причина не установлена');
    expect(screen.textContent).toContain('Финальный этап');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/batches/batch-1/quantity-flow',
      expect.objectContaining({
        method:'GET',redirect:'error',credentials:'omit',
        headers:expect.objectContaining({Authorization:'Bearer memory-only-chief'}),
      }),
    );
    const refresh = [...screen.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Обновить сверку'));
    expect(refresh).toBeTruthy();
    await act(async () => {
      refresh!.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });

  it('does not present a transfer as a loss when no handover exists', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({
      ok:true,json:async () => ({batchId:'batch-1',steps:[
        {number:1,name:'Coating',workshopId:'coating',nextStep:2,
          output:{quantity:'20.000000',unit:'kg'},handoff:null,difference:null},
      ]}),
    }));
    setServerConnection(connection);
    const screen = await mount();
    expect(screen.textContent).toContain('Передача на этап 2 не зарегистрирована');
    expect(screen.textContent).not.toContain('Выход минус передача:');
  });
});
