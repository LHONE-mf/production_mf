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
