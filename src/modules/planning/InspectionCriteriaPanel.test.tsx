import React from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { clearServerConnection,setServerConnection,type ServerConnection }
  from '../../core/sync/serverConnection';
import type { Route,RouteStep } from '../../core/planning/planningClient';
import { RouteInspectionCriteriaPanel,BatchInspectionCriteriaPanel }
  from './InspectionCriteriaPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'memory-only-chief'},
  serverUrl:'https://mes.example.org',organizationId:'org',
  serverRole:'chief',serverActorId:'chief',selectedDeviceId:'',
  enrolledDeviceId:'',myDevices:[],
};
const route:Route={id:'route-1',code:'LFP',name:'LFP process',
  version:1,state:'approved',stepCount:2};
const steps:RouteStep[]=[
  {name:'Coating',stage:'coating',workshopId:'coating',electrodeLine:'cathode'},
  {name:'Assembly',stage:'assembly',workshopId:'assembly',electrodeLine:'common'},
];
let root:Root|undefined,node:HTMLDivElement|undefined;
async function mount(element:React.ReactNode) {
  node=document.createElement('div');document.body.appendChild(node);
  root=createRoot(node);
  await act(async()=>{root!.render(element);await Promise.resolve();});
  return node;
}
function edit(element:HTMLInputElement,value:string){
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
  if(!setter)throw new Error('native value setter unavailable');
  setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));
}
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;node?.remove();node=undefined;
  clearServerConnection();vi.unstubAllGlobals();
});
describe('M2 route reference criteria on mobile Planning',()=>{
  it('requires explicit input to save a criterion and never calls a QA approval endpoint',async()=>{
    const requests:Array<{url:string;options:RequestInit}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      requests.push({url,options});
      return {ok:true,json:async()=>options.method==='GET'?
        {routeId:'route-1',version:1,state:'approved',frozen:false,criteria:[]}:
        {id:'saved',alreadyRecorded:false}};
    }));
    setServerConnection(connection);
    const page=await mount(<RouteInspectionCriteriaPanel
      connection={connection} route={route} steps={steps}/>);
    expect(page.textContent).toContain('Контрольные показатели');
    expect(page.textContent).toContain('не автоматическая');
    const button=page.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const name=page.querySelector('input[aria-label="Название критерия"]') as HTMLInputElement;
    const lower=page.querySelector('input[aria-label="Нижняя граница"]') as HTMLInputElement;
    const upper=page.querySelector('input[aria-label="Верхняя граница"]') as HTMLInputElement;
    await act(async()=>{edit(name,'Coating thickness');});
    expect(button.disabled).toBe(true);
    await act(async()=>{edit(lower,'75.000000');edit(upper,'100.250000');});
    expect(button.disabled).toBe(false);
    await act(async()=>{
      button.closest('form')!.dispatchEvent(new Event('submit',{
        bubbles:true,cancelable:true,
      }));
      await Promise.resolve();
    });
    const sends=requests.filter(x=>x.options.method==='POST');
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe(
      'https://mes.example.org/planning/routes/route-1/versions/1/steps/1/inspection-criteria');
    expect(JSON.parse(String(sends[0].options.body))).toMatchObject({
      characteristic:'Coating thickness',unit:'um',
      lowerLimit:'75.000000',upperLimit:'100.250000',
    });
    expect(requests.every(x=>(x.options.headers as Record<string,string>)
      .Authorization==='Bearer memory-only-chief')).toBe(true);
    expect(page.textContent).toContain('Контрольный показатель сохранён');
  });

  it('shows frozen criteria without any write controls',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({
      ok:true,json:async()=>({
        state:'approved',frozen:true,criteria:[{
          id:'criterion-1',stepNumber:2,characteristic:'Cell voltage',
          unit:'V',lowerLimit:null,upperLimit:'4.300000',note:'Reference only',
        }],
      }),
    })));
    setServerConnection(connection);
    const page=await mount(<RouteInspectionCriteriaPanel
      connection={connection} route={route} steps={steps}/>);
    expect(page.textContent).toContain('Cell voltage');
    expect(page.textContent).toContain('4.300000');
    expect(page.textContent).toContain('Перечень закрыт');
    expect(page.querySelector('button[type="submit"]')).toBeNull();
  });

  it('shows batch-specific criteria in a read-only panel',async()=>{
    const requests:Array<{url:string;options:RequestInit}>=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      requests.push({url,options});
      return {ok:true,json:async()=>({batchId:'batch-1',criteria:[{
        id:'criterion-1',stepNumber:1,characteristic:'Coating thickness',
        unit:'um',lowerLimit:'75.000000',upperLimit:'100.250000',note:null,
      }]})};
    }));
    setServerConnection(connection);
    const page=await mount(<BatchInspectionCriteriaPanel
      connection={connection} batchId="batch-1"/>);
    expect(page.textContent).toContain('Coating thickness');
    expect(page.textContent).toContain('не определяет соответствие');
    expect(page.querySelector('form')).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      'https://mes.example.org/planning/batches/batch-1/inspection-criteria');
    expect(requests[0].options.method).toBe('GET');
  });
});