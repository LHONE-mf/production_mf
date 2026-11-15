import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, getServerConnection, setServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import type { Batch, Route, RouteStep } from '../../core/planning/planningClient';
import { BatchGenealogyPanel } from './BatchGenealogyPanel';
import { InspectionObservationPanel } from './InspectionObservationPanel';
import { BatchInspectionCriteriaPanel, RouteInspectionCriteriaPanel } from './InspectionCriteriaPanel';
import { PlanningModule } from './PlanningModule';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'old-chief-token'},
  serverUrl:'https://mes.example.org',organizationId:'org',serverRole:'chief',
  serverActorId:'chief',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[],
};
const batch:Batch={id:'batch',batchCode:'B-1',materialLine:'cathode',status:'in_progress',
  plannedQuantity:'100',quantityUnit:'kg'};
const route:Route={id:'route',code:'R-1',name:'Route',version:1,state:'approved',stepCount:1};
const steps:RouteStep[]=[{name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'}];
const panels=[
  ['genealogy',<BatchGenealogyPanel connection={connection} batch={batch}/>],
  ['observations',<InspectionObservationPanel connection={connection} batch={batch}/>],
  ['batch criteria',<BatchInspectionCriteriaPanel connection={connection} batchId={batch.id}/>],
  ['route criteria',<RouteInspectionCriteriaPanel connection={connection} route={route} steps={steps}/>],
] as const;
let root:Root|undefined,node:HTMLDivElement|undefined;
async function mount(element:React.ReactNode){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(element);});
  return node;
}
function newerLogin(){
  setServerConnection({...connection,session:{...connection.session,accessToken:'new-chief-token'}});
}
const unauthorized={ok:false,status:401,json:async()=>({error:'unauthorized'})};
function edit(label:string,value:string){
  const element=node!.querySelector<HTMLInputElement|HTMLTextAreaElement>('[aria-label="'+label+'"]')!;
  const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(element,value);
  element.dispatchEvent(new Event('input',{bubbles:true}));
}
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;node?.remove();node=undefined;
  clearServerConnection();vi.unstubAllGlobals();
});

describe('Planning requests belong to the session that sent them',()=>{
  it.each(panels)('ignores an obsolete %s read failure',async(_name,element)=>{
    let finish:(response:unknown)=>void=()=>{};
    const pending=new Promise(resolve=>{finish=resolve;});
    vi.stubGlobal('fetch',vi.fn(()=>pending));setServerConnection(connection);
    const page=await mount(element);
    newerLogin();
    await act(async()=>{finish(unauthorized);});
    expect(getServerConnection()?.session.accessToken).toBe('new-chief-token');
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(panels)('still signs out the current session on a %s read denial',async(_name,element)=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(unauthorized));
    setServerConnection(connection);
    const page=await mount(element);
    expect(getServerConnection()).toBeNull();
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each(['observation','review','criterion'] as const)('ignores an obsolete %s write failure',async(kind)=>{
    let finish:(response:unknown)=>void=()=>{};
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(options.method==='POST')return new Promise(resolve=>{finish=resolve;});
      const data=url.endsWith('/steps')?{steps:[{number:1,...steps[0],evidence:null}]}:
        url.endsWith('/inspections')?{observations:kind==='review'?[{
          id:'obs',stepNumber:1,kind:'visual',characteristic:'Surface',note:'Scratch',
          observedValue:null,observedUnit:null,attentionRequired:true,
          recordedBy:'chief',recordedAt:'2026-11-11T00:00:00Z',reviews:[],
        }]:[]}:{criteria:[],frozen:false};
      return {ok:true,json:async()=>data};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const page=await mount(kind==='criterion'?panels[3][1]:panels[1][1]);
    await act(async()=>{
      if(kind==='criterion'){edit('Название критерия','Thickness');edit('Нижняя граница','1');}
      else if(kind==='observation'){edit('Параметр инспекции','Thickness');edit('Значение инспекции','1');}
      else edit('Обоснование проверки','Inspect again');
    });
    const form=kind==='review'?page.querySelector('textarea[aria-label="Обоснование проверки"]')!.closest('form')!:
      kind==='observation'?page.querySelector('input[aria-label="Значение инспекции"]')!.closest('form')!:page.querySelector('form')!;
    await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(fetchMock.mock.calls.filter(call=>call[1].method==='POST')).toHaveLength(1);
    newerLogin();await act(async()=>{finish(unauthorized);});
    expect(getServerConnection()?.session.accessToken).toBe('new-chief-token');
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores an obsolete Planning refresh failure after its workspace unmounts',async()=>{
    let pending=false,finish:(response:unknown)=>void=()=>{};
    const delayed=new Promise(resolve=>{finish=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      if(pending && String(new Headers(options.headers).get('Authorization')).includes('old-chief-token'))return delayed;
      return {ok:true,json:async()=>url.endsWith('/workshops')?{workshops:[]}:
        url.endsWith('/routes')?{routes:[]}:url.endsWith('/inbox')?{handoffs:[]}:{orders:[]}};
    }));
    setServerConnection(connection);const page=await mount(<PlanningModule onOpenSync={()=>{}}/>);
    pending=true;
    await act(async()=>{[...page.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Обновить')!.click();});
    await act(async()=>{newerLogin();});
    await act(async()=>{finish(unauthorized);});
    expect(getServerConnection()?.session.accessToken).toBe('new-chief-token');
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});
