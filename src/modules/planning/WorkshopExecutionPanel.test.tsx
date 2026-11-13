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
      if(url.endsWith('/outbound-handoffs'))return {ok:true,json:async()=>({
        batchId:'batch-1',handoffs:[],hasMore:false,
      })};
      if(url.endsWith('/quantity-comparison'))return {ok:true,json:async()=>({
        batchId:'batch-1',steps:[],hasMore:false,
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
    expect(fetchMock).toHaveBeenCalledTimes(5);
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

  it('discards a delayed old page after refreshing the workshop list',async()=>{
    const cursor='11111111-1111-4111-8111-111111111111';
    let completeOlder:(value:unknown)=>void=()=>{};
    let firstReads=0;
    const fetchMock=vi.fn((url:string)=>{
      if(url.endsWith('/workshop-batches')){
        firstReads++;
        const batchCode=firstReads===1?'OLD-FIRST':'FRESH-FIRST';
        return Promise.resolve({ok:true,json:async()=>({
          batches:[{id:cursor,batchCode,status:'created',quantityUnit:'kg'}],
          hasMore:firstReads===1,nextAfter:firstReads===1?cursor:null,
        })});
      }
      return new Promise(resolve=>{completeOlder=resolve;});
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    const load=[...screen.querySelectorAll('button')]
      .find(b=>b.textContent==='Загрузить предыдущие партии')!;
    await act(async()=>{load.click();await Promise.resolve();});
    const refresh=[...screen.querySelectorAll('button')]
      .find(b=>b.textContent==='Обновить партии')!;
    await act(async()=>{refresh.click();await Promise.resolve();});
    expect(screen.textContent).toContain('FRESH-FIRST');
    await act(async()=>{completeOlder({ok:true,json:async()=>({
      batches:[{id:'older-id',batchCode:'OBSOLETE',status:'created',quantityUnit:'kg'}],
      hasMore:false,nextAfter:null,
    })});await Promise.resolve();});
    expect(screen.textContent).not.toContain('OBSOLETE');
    expect(screen.textContent).not.toContain('OLD-FIRST');
    expect(screen.textContent).toContain('FRESH-FIRST');
  });

  it('does not clear a newer login when an old load-more fails with HTTP 401',async()=>{
    const cursor='11111111-1111-4111-8111-111111111111';
    let completeOlder:(value:unknown)=>void=()=>{};
    vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/workshop-batches')
      ? Promise.resolve({ok:true,json:async()=>({
          batches:[{id:cursor,batchCode:'START',status:'created',quantityUnit:'kg'}],
          hasMore:true,nextAfter:cursor,
        })})
      : new Promise(resolve=>{completeOlder=resolve;})));
    setServerConnection(connection);
    const screen=await mount();
    const load=[...screen.querySelectorAll('button')]
      .find(b=>b.textContent==='Загрузить предыдущие партии')!;
    await act(async()=>{load.click();await Promise.resolve();});
    setServerConnection({...connection,session:{...connection.session,accessToken:'newer-session'}});
    await act(async()=>{
      completeOlder({ok:false,status:401,json:async()=>({error:'unauthorized'})});
      await Promise.resolve();
    });
    expect(getServerConnection()?.session.accessToken).toBe('newer-session');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });

  it('refreshes transfer eligibility and quantity comparison after a confirmed step completion',async()=>{
    let completed=false;
    const started={
      id:'started-1',kind:'started',actorId:'master-1',recordedAt:'2026-11-11T06:00:00Z',
      quantity:null,quantityUnit:null,equipmentCode:null,note:null,
    };
    const finished={
      id:'finish-1',kind:'completed',actorId:'master-1',recordedAt:'2026-11-11T06:01:00Z',
      quantity:'20.000000',quantityUnit:'kg',equipmentCode:null,note:null,
    };
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(url.endsWith('/planning/workshop-batches'))return {ok:true,json:async()=>({
        batches:[{id:'batch-1',batchCode:'CATH-001',status:'in_progress',quantityUnit:'kg'}],
        hasMore:false,nextAfter:null,
      })};
      if(url.endsWith('/handoff-candidate'))return {ok:true,json:async()=>({
        batchId:'batch-1',candidate:completed?{
          fromStep:2,toStep:3,fromName:'Cutting',toName:'Sorting',quantityUnit:'kg',
        }:null,
      })};
      if(url.endsWith('/quantity-comparison'))return {ok:true,json:async()=>({
        batchId:'batch-1',hasMore:false,steps:[{
          number:2,name:'Cutting',workshopId:'cutting',nextStep:3,
          output:completed?{quantity:'20.000000',unit:'kg'}:null,
          handoff:null,difference:null,input:null,inputDifference:null,
        }],
      })};
      if(url.endsWith('/outbound-handoffs'))return {ok:true,json:async()=>({
        batchId:'batch-1',handoffs:[],hasMore:false,
      })};
      if(url.endsWith('/planning/batches/batch-1/steps/2/evidence') && options.method==='POST'){
        const body=JSON.parse(String(options.body));
        expect(body).toMatchObject({kind:'completed',quantity:'20',quantityUnit:'kg'});
        completed=true;
        return {ok:true,json:async()=>({
          id:body.eventId,batchId:'batch-1',stepNumber:2,kind:'completed',alreadyRecorded:false,
        })};
      }
      if(url.endsWith('/planning/batches/batch-1/steps'))return {ok:true,json:async()=>({
        batchId:'batch-1',steps:[
          {number:2,name:'Cutting',stage:'cutting',workshopId:'cutting',evidence:started},
          ...(completed?[{number:2,name:'Cutting',stage:'cutting',workshopId:'cutting',evidence:finished}]:[]),
        ],
      })};
      throw Error('Unexpected workshop request: '+url);
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    const open=[...screen.querySelectorAll('button')]
      .find(button=>button.textContent==='Открыть журнал')!;
    await act(async()=>{open.click();await Promise.resolve();});
    expect(screen.textContent).toContain('Нет доступной передачи');
    expect(screen.textContent).toContain('Нет записи о завершении');
    expect(screen.querySelector('input[aria-label="Количество передачи цеха"]')).toBeNull();
    const completionQuantity=screen.querySelector('input[aria-label="Зафиксированное количество"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
        .call(completionQuantity,'20');
      completionQuantity.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{
      const save=[...screen.querySelectorAll('button')]
        .find(button=>button.textContent==='Записать событие')!;
      save.click();
      await Promise.resolve();
    });
    expect(completed).toBe(true);
    expect(screen.textContent).toContain('Cutting');
    expect(screen.textContent).toContain('Sorting');
    expect(screen.querySelector('input[aria-label="Количество передачи цеха"]')).toBeTruthy();
    expect(screen.textContent).toContain('20.000000 kg');
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith('/handoff-candidate')))
      .toHaveLength(2);
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith('/quantity-comparison')))
      .toHaveLength(2);
    expect(fetchMock.mock.calls.some(call=>String(call[0]).endsWith('/planning/orders')))
      .toBe(false);
  });

  it('automatically refreshes outbound audit after a master sends a handoff',async()=>{
    let sent=false;
    const outbound={
      id:'transfer-1',fromStep:2,toStep:3,
      fromWorkshopId:'cutting',toWorkshopId:'sorting',
      quantity:'12.500000',quantityUnit:'kg',sentBy:'master-1',
      sentAt:'2026-11-11T05:00:00Z',note:null,
      receivedBy:null,receivedAt:null,receiptNote:null,
    };
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(url.endsWith('/planning/workshop-batches'))return {ok:true,json:async()=>({
        batches:[{id:'batch-1',batchCode:'CATH-001',status:'in_progress',quantityUnit:'kg'}],
        hasMore:false,nextAfter:null,
      })};
      if(url.endsWith('/handoff-candidate'))return {ok:true,json:async()=>({
        batchId:'batch-1',candidate:sent?null:{
          fromStep:2,toStep:3,fromName:'Cutting',toName:'Sorting',quantityUnit:'kg',
        },
      })};
      if(url.endsWith('/outbound-handoffs'))return {ok:true,json:async()=>({
        batchId:'batch-1',handoffs:sent?[outbound]:[],hasMore:false,
      })};
      if(url.endsWith('/quantity-comparison'))return {ok:true,json:async()=>({
        batchId:'batch-1',hasMore:false,steps:[{
          number:2,name:'Cutting',workshopId:'cutting',nextStep:3,
          output:{quantity:'20.000000',unit:'kg'},
          handoff:sent?{id:'transfer-1',quantity:'12.500000',unit:'kg',received:false}:null,
          difference:sent?'7.500000':null,
          input:null,inputDifference:null,
        }],
      })};
      if(url.endsWith('/planning/batches/batch-1/handoffs') && options.method==='POST'){
        sent=true;
        const body=JSON.parse(String(options.body));
        return {ok:true,json:async()=>({id:body.handoffId,status:'sent'})};
      }
      return {ok:true,json:async()=>({batchId:'batch-1',steps:[]})};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    const open=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Открыть журнал')!;
    await act(async()=>{open.click();await Promise.resolve();});
    expect(screen.textContent).toContain('Исходящих передач пока нет');
    const quantity=screen.querySelector('input[aria-label="Количество передачи цеха"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(quantity,'12.5');
      quantity.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const send=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Отправить передачу')!;
    await act(async()=>{send.click();await Promise.resolve();});
    expect(screen.textContent).toContain('Передача записана');
    expect(screen.textContent).toContain('Ожидает приёмки');
    expect(screen.textContent).toContain('12.500000 kg');
    expect(screen.textContent).toContain('7.500000 kg');
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith('/outbound-handoffs')))
      .toHaveLength(2);
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith('/quantity-comparison')))
      .toHaveLength(2);
    expect(fetchMock.mock.calls.some(call=>String(call[0]).endsWith('/planning/orders')))
      .toBe(false);
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
