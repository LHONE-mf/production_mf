import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection } from '../../core/sync/serverConnection';
import { PlanningModule } from './PlanningModule';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root=undefined; container?.remove(); container=undefined;
  clearServerConnection(); vi.unstubAllGlobals();
});

describe('Chief interstage handoff identity', () => {
  it('retries an unchanged handoff using its first UUID after a lost reply', async () => {
    const sent:string[]=[];
    const fetchMock=vi.fn(async (url:string, options:RequestInit) => {
      if (url.endsWith('/planning/batches/batch-1/handoffs') && options.method==='POST') {
        const body=JSON.parse(String(options.body));
        sent.push(body.handoffId);
        return sent.length===1
          ? {ok:false,status:503,json:async()=>({error:'reply_lost'})}
          : {ok:true,json:async()=>({id:body.handoffId,batchId:'batch-1',status:'already_sent'})};
      }
      const data=url.endsWith('/planning/workshops') ? {workshops:[]}
        : url.endsWith('/planning/routes') ? {routes:[]}
        : url.endsWith('/planning/orders') ? {orders:[{
          id:'order-1',orderCode:'PO-1',productCode:'CATH',
          routeId:'route-1',routeVersion:1,status:'released',
          plannedQuantity:'100',quantityUnit:'kg',
        }]}
        : url.endsWith('/planning/handoffs/inbox') ? {handoffs:[]}
        : url.endsWith('/planning/orders/order-1/batches') ? {batches:[{
          id:'batch-1',batchCode:'CATH-1',materialLine:'cathode',
          status:'in_progress',plannedQuantity:'100',quantityUnit:'kg',
        }]}
        : url.endsWith('/planning/batches/batch-1/events') ? {events:[]}
        : url.endsWith('/planning/batches/batch-1/handoffs') ? {handoffs:[]}
        : url.endsWith('/planning/routes/route-1/versions/1/steps') ? {steps:[
          {number:1,name:'Coating',stage:'coating',electrodeLine:'cathode',workshopId:'coating'},
          {number:2,name:'Cutting',stage:'cutting',electrodeLine:'cathode',workshopId:'cutting'},
        ]}
        : url.endsWith('/planning/batches/batch-1/links') ? {
          batchId:'batch-1',links:[],hasMore:false,nextAfter:null,
        } : {batchId:'batch-1',steps:[],links:[],handoffs:[],
          criteria:[],observations:[],hasMore:false,nextAfter:null};
      return {ok:true,json:async()=>data};
    });
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection({
      session:{serverUrl:'https://mes.example.org',accessToken:'chief-handoff'},
      serverUrl:'https://mes.example.org',organizationId:'org',
      serverRole:'chief',serverActorId:'chief',selectedDeviceId:'',
      enrolledDeviceId:'',myDevices:[],
    });
    container=document.createElement('div');document.body.appendChild(container);
    root=createRoot(container);
    await act(async()=>{
      root!.render(<PlanningModule onOpenSync={()=>{}}/>);
      await Promise.resolve();
    });
    const button=(title:string)=>[...container!.querySelectorAll('button')]
      .find(b=>b.textContent===title)!;
    await act(async()=>{button('Открыть партии').click(); await Promise.resolve();});
    await act(async()=>{button('История и статус').click(); await Promise.resolve();});
    expect(container.textContent).toContain('Следующая передача');
    const label=[...container.querySelectorAll('label')]
      .find(element=>element.textContent?.includes('Передаваемое количество'))!;
    const input=label.querySelector('input')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'10');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const send=()=>button('Передать на следующий этап').closest('form')!;
    await act(async()=>{send().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(sent).toHaveLength(1);
    expect(container.textContent).toContain('HTTP 503');
    await act(async()=>{send().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(container.textContent).toContain('Передача отправлена');
  });
});
