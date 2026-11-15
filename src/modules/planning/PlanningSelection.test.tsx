import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection } from '../../core/sync/serverConnection';
import { PlanningModule } from './PlanningModule';

let root: Root | undefined;
let screen: HTMLDivElement;
const order = (id: string) => ({id,orderCode:id,productCode:'TEST',routeId:'route-1',
  routeVersion:1,status:'released',plannedQuantity:'100',quantityUnit:'cells'});
const batch = (id: string) => ({id,batchCode:id,materialLine:'cell',status:'in_progress',
  plannedQuantity:'100',quantityUnit:'cells'});
const step = (name: string) => ({number:1,name,stage:'assembly',workshopId:'assembly',electrodeLine:'common'});
const events = (reason: string) => ({events:[{number:1,fromStatus:'created',toStatus:'hold',
  reason,actorId:'chief',occurredAt:'2026-11-10T10:00:00Z'}]});
function deferred() {
  let resolve: (body: object) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<object>((done,fail) => { resolve=done;reject=fail; });
  return {promise,resolve,reject};
}
async function mount(overrides: Map<string,object|Promise<object>>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('fetch',vi.fn(async (url: string,options:RequestInit) => ({ok:true,json:async () => {
    const path=new URL(url).pathname;
    const request=options.method+' '+path;
    if (overrides.has(request)) return overrides.get(request);
    if (overrides.has(path)) return overrides.get(path);
    if (path.endsWith('/workshops')) return {workshops:[]};
    if (path.endsWith('/routes')) return {routes:['route-1','route-2'].map(id => ({
      id,code:id,name:id,version:1,state:'approved',stepCount:1,
    }))};
    if (path.endsWith('/orders')) return {orders:[order('order-1'),order('order-2')]};
    if (path.endsWith('/batches')) return {batches:[batch('batch-1'),batch('batch-2')]};
    if (path.endsWith('/events')) return events('CURRENT HISTORY');
    if (path.endsWith('/links')) return {batchId:path.split('/')[3],links:[],hasMore:false,nextAfter:null};
    if (path.endsWith('/steps')) return {steps:[step('CURRENT ROUTE STEP')]};
    return {steps:[],handoffs:[],links:[],criteria:[],observations:[]};
  }})));
  setServerConnection({session:{serverUrl:'https://mes.example.org',accessToken:'chief-token'},
    serverUrl:'https://mes.example.org',organizationId:'org',serverRole:'chief',
    serverActorId:'chief',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[]});
  screen=document.createElement('div');document.body.appendChild(screen);
  root=createRoot(screen);
  await act(async () => {root!.render(<PlanningModule onOpenSync={() => {}} />);});
}
async function click(name: string,index=0) {
  const button=[...screen.querySelectorAll('button')].filter(b => b.textContent===name)[index];
  expect(button,name).toBeTruthy();
  await act(async () => {button.click();});
}
afterEach(async () => {
  if(root) await act(async () => root!.unmount());
  root=undefined;screen?.remove();clearServerConnection();vi.unstubAllGlobals();
});

describe('M2 planning selection request ordering', () => {
  it('keeps the current order batch list when the previous order finishes loading late', async () => {
    const late=deferred();
    await mount(new Map<string,object|Promise<object>>([
      ['/planning/orders/order-1/batches',late.promise],
      ['/planning/orders/order-2/batches',{batches:[batch('CURRENT-BATCH')]}],
    ]));
    await click('Открыть партии',0);
    await click('Открыть партии',0);
    expect(screen.textContent).toContain('CURRENT-BATCH');
    await act(async () => {late.resolve({batches:[batch('OBSOLETE-BATCH')]});});
    expect(screen.textContent).toContain('CURRENT-BATCH');
    expect(screen.textContent).not.toContain('OBSOLETE-BATCH');
  });

  it('keeps the current batch history when the previous batch response arrives late', async () => {
    const late=deferred();
    await mount(new Map([['/planning/batches/batch-1/events',late.promise]]));
    await click('Открыть партии');
    await click('История и статус',0);
    await click('История и статус',1);
    expect(screen.textContent).toContain('batch-2 · История');
    expect(screen.textContent).toContain('CURRENT HISTORY');
    await act(async () => {late.resolve(events('OBSOLETE HISTORY'));});
    expect(screen.textContent).toContain('CURRENT HISTORY');
    expect(screen.textContent).not.toContain('OBSOLETE HISTORY');
  });

  it('keeps the selected route steps when the previous route response arrives late', async () => {
    const late=deferred();
    await mount(new Map([['/planning/routes/route-1/versions/1/steps',late.promise]]));
    await click('Маршруты');
    await click('Открыть',0);
    await click('Открыть',1);
    expect(screen.textContent).toContain('route-2, версия 1');
    expect(screen.textContent).toContain('CURRENT ROUTE STEP');
    await act(async () => {late.resolve({steps:[step('OBSOLETE ROUTE STEP')]});});
    expect(screen.textContent).toContain('CURRENT ROUTE STEP');
    expect(screen.textContent).not.toContain('OBSOLETE ROUTE STEP');
  });

  it('ignores an obsolete read failure after another order has loaded', async () => {
    const late=deferred();
    await mount(new Map([['/planning/orders/order-1/batches',late.promise]]));
    await click('Открыть партии');
    await click('Открыть партии');
    await act(async () => {late.reject(new Error('OBSOLETE NETWORK ERROR'));});
    expect(screen.textContent).toContain('Партии заказа order-2');
    expect(screen.textContent).not.toContain('OBSOLETE NETWORK ERROR');
  });

  it('does not reopen a previous order when a save completes after navigation', async () => {
    const save=deferred();
    await mount(new Map([['POST /planning/workshops',save.promise]]));
    await click('Открыть партии');
    await click('Маршруты');
    const submit=[...screen.querySelectorAll('button')]
      .find(button => button.textContent==='Создать цех')!;
    await act(async () => {
      submit.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
    await click('Заказы и партии');
    await click('Открыть партии');
    expect(screen.textContent).toContain('Партии заказа order-2');
    await act(async () => {save.resolve({id:'saved-workshop'});});
    expect(screen.textContent).toContain('Партии заказа order-2');
    expect(screen.textContent).not.toContain('Партии заказа order-1');
  });
});
