import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
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
