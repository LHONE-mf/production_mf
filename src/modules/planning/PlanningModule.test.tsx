import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection } from '../../core/sync/serverConnection';
import { PlanningModule } from './PlanningModule';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderPlanning() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PlanningModule onOpenSync={() => {}} />);
    await Promise.resolve();
  });
  return container;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container?.remove();
  container = undefined;
  clearServerConnection();
  vi.unstubAllGlobals();
});

describe('M2 online planning screen', () => {
  it('does not reveal server planning records without a verified server login', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = await renderPlanning();
    expect(app.textContent).toContain('Для просмотра производственных заказов');
    expect(app.textContent).toContain('Локальный демонстрационный вход');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('presents chief-only order controls after reading tenant-scoped server data', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/planning/workshops') ? { workshops: [] }
        : url.endsWith('/planning/routes') ? { routes: [] }
        : url.endsWith('/planning/handoffs/inbox') ? { handoffs: [] }
        : { orders: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'chief-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'chief', serverActorId: 'chief', selectedDeviceId: '',
      enrolledDeviceId: '', myDevices: [],
    });
    const app = await renderPlanning();
    expect(app.textContent).toContain('Новый производственный заказ');
    expect(app.textContent).toContain('Утверждённый маршрут');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/orders',
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer chief-token',
      }) }),
    );
    const button = Array.from(app.querySelectorAll('button'))
      .find(element => element.textContent === 'Маршруты');
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(app.textContent).toContain('Новый технологический маршрут');
  });

  it('shows source-to-target genealogy only inside a chief server batch detail', async () => {
    let withdrawal:{id:string;reason:string;withdrawnBy:string;withdrawnAt:string}|null=null;
    const link = {
      id: 'link-1', sourceBatchId: 'cathode-1', targetBatchId: 'cell-1',
      sourceCode: 'CATHODE-LOT', targetCode: 'CELL-LOT',
      kind: 'assembly', sourceQuantity: '12.500000', sourceUnit: 'kg',
      targetQuantity: '100.000000', targetUnit: 'cells',
      actorId: 'chief', note: 'Electrode batch trace',
      occurredAt: '2026-11-10T10:00:00Z',
    };
    const fetchMock = vi.fn().mockImplementation(async (url: string, options:RequestInit) => ({
      ok: true, json: async () => {
        if(url.endsWith('/journal-links/local-link/withdraw')){
          const data=JSON.parse(String(options.body));
          withdrawal={id:data.withdrawalId,reason:data.reason,withdrawnBy:'chief',withdrawnAt:'2026-11-11T03:00:00Z'};
          return {id:data.withdrawalId,batchId:'cell-1',linkId:'local-link',alreadyRecorded:false};
        }
        if(url.endsWith('/planning/batches/cell-1/journal-links'))return {batchId:'cell-1',links:[{
          id:'local-link',stepNumber:1,sourceStage:'assembly',sourceKind:'journal',sourceEntryId:'local-1',
          sourceMeasure:null,summary:'Original local reference',sourceCreatedAt:'2026-11-10T10:00:00Z',
          linkedBy:'chief',linkedAt:'2026-11-10T11:00:00Z',defects:null,withdrawal,
        }]};
        if(url.endsWith('/planning/batches/cell-1/steps'))return {steps:[]};
        if (url.endsWith('/planning/workshops')) return { workshops: [] };
        if (url.endsWith('/planning/routes')) return { routes: [] };
        if (url.endsWith('/planning/orders')) return { orders: [{
          id: 'order-1', orderCode: 'PO-001', productCode: '18650-NMC',
          routeId: 'route-1', routeVersion: 1, status: 'released',
          plannedQuantity: '1000', quantityUnit: 'cells',
        }] };
        if (url.endsWith('/planning/handoffs/inbox')) return { handoffs: [] };
        if (url.endsWith('/planning/orders/order-1/batches')) return { batches: [
          { id: 'cathode-1', batchCode: 'CATHODE-LOT', materialLine: 'cathode',
            status: 'completed', plannedQuantity: '20.000000', quantityUnit: 'kg' },
          { id: 'cell-1', batchCode: 'CELL-LOT', materialLine: 'cell',
            status: 'in_progress', plannedQuantity: '100.000000', quantityUnit: 'cells' },
        ] };
        if (url.endsWith('/planning/batches/cell-1/links'))
          return {batchId:'cell-1',links:[link],hasMore:false,nextAfter:null};
        if (url.endsWith('/planning/batches/cathode-1/links'))
          return {batchId:'cathode-1',links:[link],hasMore:false,nextAfter:null};
        if (url.endsWith('/planning/batches/cell-1/events')) return { events: [] };
        if (url.endsWith('/planning/batches/cell-1/handoffs')) return { handoffs: [] };
        if (url.endsWith('/planning/routes/route-1/versions/1/steps'))
          return { steps: [] };
        return {};
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'chief-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'chief', serverActorId: 'chief',
      selectedDeviceId: '', enrolledDeviceId: '', myDevices: [],
    });
    const screen = await renderPlanning();
    const openOrder = Array.from(screen.querySelectorAll('button'))
      .find(button => button.textContent === 'Открыть партии');
    expect(openOrder).toBeTruthy();
    await act(async () => { openOrder!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const openBatch = Array.from(screen.querySelectorAll('button'))
      .find(button => button.textContent === 'История и статус' &&
        button.closest('div.rounded-lg')?.textContent?.includes('CELL-LOT'));
    // Use last matching batch button (cathode is listed first, cell second).
    const detailButton = openBatch ?? Array.from(screen.querySelectorAll('button'))
      .filter(button => button.textContent === 'История и статус').slice(-1)[0];
    expect(detailButton).toBeTruthy();
    await act(async () => { detailButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(screen.textContent).toContain('Происхождение партии');
    expect(screen.textContent).toContain('Перед завершением партии');
    expect(screen.textContent).toContain('CATHODE-LOT → CELL-LOT');
    expect(screen.textContent).toContain('12.500000 kg');
    expect(screen.textContent).toContain('Добавить связь происхождения');
    const available = screen.querySelector('select[aria-label="Исходная партия"]');
    expect(available?.textContent).toContain('CATHODE-LOT');
    expect(available?.textContent).not.toContain('CELL-LOT');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/batches/cell-1/links',
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer chief-token',
      }) }),
    );
    const genealogy = screen.querySelector('section[aria-label="Просмотр происхождения партии"]');
    const sourceButton = [...genealogy!.querySelectorAll('button')]
      .find(button => button.textContent === 'CATHODE-LOT');
    expect(sourceButton).toBeTruthy();
    await act(async () => { sourceButton!.click(); });
    expect(genealogy?.textContent).toContain('Просматривается: CATHODE-LOT');
    expect(screen.textContent).toContain('CELL-LOT · История');
    // The target and units for a new declaration remain those of the cell batch.
    expect(screen.querySelector('select[aria-label="Исходная партия"]')?.textContent)
      .toContain('CATHODE-LOT');
    expect(screen.textContent).toContain('Количество результата (cells)');
    await vi.waitFor(async()=>{
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
      expect(screen.textContent).toContain('Original local reference');
    });
    const withdraw=[...screen.querySelectorAll('button')].find(button=>button.textContent==='Отозвать ссылку');
    expect(withdraw).toBeTruthy();
    await act(async()=>{withdraw!.click();});
    const reason=screen.querySelector('textarea[aria-label="Причина отзыва ссылки"]') as HTMLTextAreaElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(reason,'Wrong journal record');
      reason.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const submit=[...screen.querySelectorAll('button')].find(button=>button.textContent==='Записать отзыв')!;
    await act(async()=>{submit.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(screen.textContent).toContain('Ссылка отозвана. Исходная запись и история сохранены.');
    expect(screen.textContent).toContain('Wrong journal record');
    expect(fetchMock.mock.calls.filter(call=>call[0].endsWith('/quantity-flow')).length).toBeGreaterThanOrEqual(2);
  });

  it('shows only workshop-scoped pending handovers for a server master', async () => {
    const ticket = {
      id: 'transfer-1', batchId: 'batch-1', batchCode: 'CATH-001',
      fromStep: 1, toStep: 2, fromWorkshopId: 'coating',
      toWorkshopId: 'cutting', quantity: '12.000000', quantityUnit: 'kg',
      sentBy: 'chief-other', sentAt: '2026-11-10T10:00:00Z',
      note: null,
    };
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/planning/workshops') ? { workshops: [] }
        : url.endsWith('/planning/routes') ? { routes: [] }
        : url.endsWith('/planning/workshop-batches') ? {
          batches: [{id:'batch-1',batchCode:'CATH-001',status:'in_progress',quantityUnit:'kg'}],
          hasMore:false,
        } : url.endsWith('/planning/handoffs/inbox') ? { handoffs: [ticket] }
        : { steps:[] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'master-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'master', serverActorId: 'master-actor',
      selectedDeviceId: '', enrolledDeviceId: '', myDevices: [],
    });
    const app = await renderPlanning();
    const tab = Array.from(app.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Приёмка передач'));
    expect(tab).toBeTruthy();
    await act(async () => { tab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(app.textContent).toContain('CATH-001');
    expect(app.textContent).toContain('Подтвердить приёмку');
    expect(app.textContent).not.toContain('Новый производственный заказ');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(app.textContent).toContain('Операции цеха');
    expect(app.textContent).not.toContain('Открыть журнал');
    const operations = [...app.querySelectorAll('button')]
      .find(button => button.textContent === 'Операции цеха')!;
    await act(async () => { operations.click(); await Promise.resolve(); });
    expect(app.textContent).toContain('Открыть журнал');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/workshop-batches',
      expect.objectContaining({headers:expect.objectContaining({
        Authorization:'Bearer master-token',
      })}),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/handoffs/inbox',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer master-token' }),
      }),
    );
  });

  it('never exposes order creation for a technologist server role', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/planning/workshops') ? { workshops: [] }
        : { routes: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'technologist-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'technologist', serverActorId: 'technologist',
      selectedDeviceId: '', enrolledDeviceId: '', myDevices: [],
    });
    const app = await renderPlanning();
    expect(app.textContent).toContain('только начальнику производства');
    expect(app.textContent).not.toContain('Новый производственный заказ');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
