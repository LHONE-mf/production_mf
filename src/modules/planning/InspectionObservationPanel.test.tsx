import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection, type ServerConnection }
  from '../../core/sync/serverConnection';
import type { Batch } from '../../core/planning/planningClient';
import { InspectionObservationPanel } from './InspectionObservationPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'memory-only-chief'},
  serverUrl:'https://mes.example.org',organizationId:'test-org',
  serverRole:'chief',serverActorId:'chief',selectedDeviceId:'',
  enrolledDeviceId:'',myDevices:[],
};
const batch:Batch={
  id:'batch-1',batchCode:'CATH-01',materialLine:'cathode',status:'in_progress',
  plannedQuantity:'100',quantityUnit:'kg',
};
let root:Root|undefined;
let node:HTMLDivElement|undefined;
async function mount(status:Batch['status']='in_progress'){
  node=document.createElement('div');
  document.body.appendChild(node);
  root=createRoot(node);
  await act(async()=>{
    root!.render(<InspectionObservationPanel connection={connection}
      batch={{...batch,status}}/>);
    await Promise.resolve();
  });
  return node;
}
function setText(element:HTMLInputElement|HTMLTextAreaElement,value:string) {
  const prototype=element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;
  if(!setter)throw new Error('No native value setter');
  setter.call(element,value);
  element.dispatchEvent(new Event('input',{bubbles:true}));
}
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;node?.remove();node=undefined;
  clearServerConnection();vi.unstubAllGlobals();
});

describe('M2 quality inspection observation panel',()=>{
  it('shows every previous review, not only the current nonblocking decision',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>({
      ok:true,json:async()=>url.endsWith('/steps')?{
        steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',
          evidence:null}],
      }:{
        batchId:'batch-1',observations:[{
          id:'obs-history',stepNumber:1,kind:'visual',
          characteristic:'Coating edge',observedValue:null,observedUnit:null,
          attentionRequired:true,note:'Check edge',recordedBy:'chief',
          recordedAt:'2026-11-10T11:00:00Z',
          latestReview:{number:2,outcome:'reviewed_no_block',
            reason:'Second inspection was acceptable',reviewedBy:'chief',
            reviewedAt:'2026-11-10T12:30:00Z'},
          reviewHistory:[
            {number:1,outcome:'follow_up_required',
              reason:'Initial finding required another check',
              reviewedBy:'chief',reviewedAt:'2026-11-10T12:00:00Z'},
            {number:2,outcome:'reviewed_no_block',
              reason:'Second inspection was acceptable',
              reviewedBy:'chief',reviewedAt:'2026-11-10T12:30:00Z'},
          ],
        }],
      },
    })));
    setServerConnection(connection);
    const page=await mount();
    const history=page.querySelector('details');
    expect(history).not.toBeNull();
    expect(history?.querySelector('summary')?.textContent)
      .toContain('История проверок (2)');
    expect(history?.textContent).toContain('Initial finding required another check');
    expect(history?.textContent).toContain('Second inspection was acceptable');
    expect(history?.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('displays recorded measurements and flagged visual findings without QA approval',async()=>{
    const calls:Array<{url:string;options:RequestInit}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      calls.push({url,options});
      return {ok:true,json:async()=>url.endsWith('/steps')?{
        steps:[{number:1,name:'Cathode coating',stage:'coating',
          workshopId:'coating',evidence:null}],
      }:{
        batchId:'batch-1',observations:[
          {id:'obs-1',stepNumber:1,kind:'measurement',
            characteristic:'Thickness',observedValue:'0.012345',
            observedUnit:'mm',attentionRequired:false,note:'Gauge checked',
            recordedBy:'chief',recordedAt:'2026-11-10T11:00:00Z'},
          {id:'obs-2',stepNumber:1,kind:'visual',
            characteristic:'Coating edge',observedValue:null,
            observedUnit:null,attentionRequired:true,note:'Visible edge crack',
            recordedBy:'chief',recordedAt:'2026-11-10T11:30:00Z'},
        ],
      }};
    }));
    setServerConnection(connection);
    const page=await mount();
    expect(page.textContent).toContain('Журнал контроля качества');
    expect(page.textContent).toContain('0.012345 mm');
    expect(page.textContent).toContain('Visible edge crack');
    expect(page.textContent).toContain('Требуется проверка');
    expect(page.textContent).toContain('не разрешение выпускать партию');
    expect(calls.map(c=>c.options.method)).toEqual(['GET','GET']);
    expect(calls.map(c=>c.url)).toEqual([
      'https://mes.example.org/planning/batches/batch-1/steps',
      'https://mes.example.org/planning/batches/batch-1/inspections',
    ]);
  });

  it('requires a written finding and confirmation flag before sending one visual observation',async()=>{
    const calls:Array<{url:string;options:RequestInit}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      calls.push({url,options});
      return {ok:true,json:async()=>url.endsWith('/steps')?{
        steps:[{number:1,name:'Cathode coating',stage:'coating',
          workshopId:'coating',evidence:null}],
      }:options.method==='GET'?{
        batchId:'batch-1',observations:[],
      }:{id:'ok',alreadyRecorded:false}};
    }));
    setServerConnection(connection);
    const page=await mount();
    const kind=page.querySelector('select[aria-label="Тип инспекции"]') as HTMLSelectElement;
    const characteristic=page.querySelector('input[aria-label="Параметр инспекции"]') as HTMLInputElement;
    const note=page.querySelector('textarea[aria-label="Примечание инспекции"]') as HTMLTextAreaElement;
    const checkbox=page.querySelector('input[aria-label="Требуется проверка"]') as HTMLInputElement;
    const button=page.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async()=>{
      kind.value='visual';
      kind.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await act(async()=>{ setText(characteristic,'Electrode burr'); });
    await act(async()=>{checkbox.click();});
    expect(button.disabled).toBe(true);
    await act(async()=>{setText(note,'Burr detected near cut edge');});
    expect(button.disabled).toBe(false);
    await act(async()=>{
      button.closest('form')!.dispatchEvent(new Event('submit',{
        bubbles:true,cancelable:true,
      }));
      await Promise.resolve();
    });
    const sends=calls.filter(call=>call.options.method==='POST');
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe(
      'https://mes.example.org/planning/batches/batch-1/steps/1/inspections');
    const input=JSON.parse(String(sends[0].options.body));
    expect(input).toMatchObject({
      kind:'visual',characteristic:'Electrode burr',
      attentionRequired:true,note:'Burr detected near cut edge',
    });
    expect(input.observationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(input).not.toHaveProperty('observedValue');
    expect(input).not.toHaveProperty('observedUnit');
    expect(calls.every(call=>(call.options.headers as Record<string,string>).Authorization===
      'Bearer memory-only-chief')).toBe(true);
    expect(page.textContent).toContain('Формальное решение о качестве не вынесено');
  });

  it('shows the latest review and writes a documented nonblocking decision once',async()=>{
    const requests:Array<{url:string;options:RequestInit}>=[];
    let lastReview:unknown=null;
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      requests.push({url,options});
      if(url.endsWith('/steps'))return {ok:true,json:async()=>({
        steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null}],
      })};
      if(options.method==='POST'){
        const input=JSON.parse(String(options.body));
        lastReview={number:1,outcome:input.outcome,reason:input.reason,
          reviewedBy:'chief',reviewedAt:'2026-11-10T12:00:00Z'};
        return {ok:true,json:async()=>({reviewNumber:1,alreadyRecorded:false})};
      }
      return {ok:true,json:async()=>({
        batchId:'batch-1',observations:[{
          id:'flagged-1',stepNumber:1,kind:'visual',characteristic:'Coating edge',
          observedValue:null,observedUnit:null,attentionRequired:true,
          note:'Edge irregularity',recordedBy:'chief',
          recordedAt:'2026-11-10T11:30:00Z',latestReview:lastReview,
        }],
      })};
    }));
    setServerConnection(connection);
    const page=await mount();
    expect(page.textContent).toContain('Требуется проверка перед завершением');
    expect(page.textContent).toContain('не независимая приёмка ОТК');
    const button=[...page.querySelectorAll('button[type="submit"]')]
      .find(b=>b.textContent?.includes('Сохранить проверку')) as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(true);
    const choice=page.querySelector('select[aria-label="Результат проверки"]') as HTMLSelectElement;
    await act(async()=>{
      choice.value='reviewed_no_block';
      choice.dispatchEvent(new Event('change',{bubbles:true}));
    });
    const reason=page.querySelector('textarea[aria-label="Обоснование проверки"]') as HTMLTextAreaElement;
    await act(async()=>{
      setText(reason,'Independent measurement checked and documented');
    });
    expect(button.disabled).toBe(false);
    await act(async()=>{
      button.closest('form')!.dispatchEvent(new Event('submit',{
        bubbles:true,cancelable:true,
      }));
      await Promise.resolve();
    });
    const posts=requests.filter(r=>r.options.method==='POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(
      'https://mes.example.org/planning/batches/batch-1/inspections/flagged-1/reviews');
    expect(JSON.parse(String(posts[0].options.body))).toMatchObject({
      outcome:'reviewed_no_block',
      reason:'Independent measurement checked and documented',
    });
    expect(page.textContent).toContain('Проверено: не блокирует завершение');
    expect(page.textContent).toContain('официальная приёмка качества не выполнена');
  });

  it('keeps finished batches read-only and allows held batches to register observations',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>({
      ok:true,json:async()=>url.endsWith('/steps')?{
        steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null}],
      }:{observations:[]},
    })));
    setServerConnection(connection);
    const page=await mount('completed');
    expect(page.querySelector('button[type="submit"]')).toBeNull();
    await act(async()=>{
      root!.render(<InspectionObservationPanel connection={connection}
        batch={{...batch,status:'hold'}}/>);
      await Promise.resolve();
    });
    expect(page.querySelector('button[type="submit"]')).not.toBeNull();
  });
});
