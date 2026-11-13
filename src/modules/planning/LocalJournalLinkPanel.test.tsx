import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection,getServerConnection,setServerConnection,type ServerConnection } from '../../core/sync/serverConnection';
import type { Batch } from '../../core/planning/planningClient';

const journal = vi.hoisted(() => ({
  entries: [] as Array<Record<string,unknown>>,
  mixes: [] as Array<Record<string,unknown>>,
  coatings: [] as Array<Record<string,unknown>>,
  calenders: [] as Array<Record<string,unknown>>,
  cuts: [] as Array<Record<string,unknown>>,
  sorts: [] as Array<Record<string,unknown>>,
  assemblies: [] as Array<Record<string,unknown>>,
  reads: 0,
}));
vi.mock('../../core/db', () => ({
  db:{
    journal:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => {journal.reads++;return journal.entries;}}),
    })})},
    mixBatches:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.mixes}),
    })})},
    coatRuns:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.coatings}),
    })})},
    calenderRuns:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.calenders}),
    })})},
    cuttingRuns:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.cuts}),
    })})},
    sortRuns:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.sorts}),
    })})},
    assemblyRuns:{orderBy:() => ({reverse:() => ({
      limit:() => ({toArray:async () => journal.assemblies}),
    })})},
  },
}));
import { LocalJournalLinkPanel } from './LocalJournalLinkPanel';

const connection:ServerConnection={
  session:{serverUrl:'https://mes.example.org',accessToken:'memory-only-chief'},
  serverUrl:'https://mes.example.org',organizationId:'test-org',
  serverRole:'chief',serverActorId:'chief',selectedDeviceId:'',
  enrolledDeviceId:'',myDevices:[],
};
const batch:Batch={
  id:'batch-1',batchCode:'CATH-01',materialLine:'cathode',
  status:'in_progress',plannedQuantity:'40',quantityUnit:'kg',
};
let root:Root|undefined,container:HTMLDivElement|undefined;
async function mount(status:Batch['status']='in_progress') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  container=document.createElement('div');
  document.body.appendChild(container);
  root=createRoot(container);
  await act(async()=>{
    root!.render(<LocalJournalLinkPanel connection={connection}
      batch={{...batch,status}} />);
    await Promise.resolve();
  });
  return container;
}
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;container?.remove();container=undefined;
  journal.entries=[];journal.mixes=[];journal.coatings=[];
  journal.calenders=[];journal.cuts=[];journal.sorts=[];journal.assemblies=[];
  journal.reads=0;
  clearServerConnection();vi.unstubAllGlobals();
});

describe('M2 manual link of existing local journal',()=>{
  it('requires a replacement reason, retries the same intent and retains the withdrawn original',async()=>{
    const id='19623234-3cc9-40ca-832e-12e579efda14';
    journal.entries=[{id,stage:'coating',summary:'Correct saved journal',createdAt:new Date('2026-11-11T03:00:00Z')}];
    const old={id:'old-link',stepNumber:1,sourceKind:'journal',sourceStage:'coating',sourceEntryId:'old-source',
      summary:'Withdrawn original',sourceCreatedAt:'2026-11-10T03:00:00Z',sourceMeasure:null,
      linkedBy:'chief',linkedAt:'2026-11-10T04:00:00Z',defects:null,
      withdrawal:{id:'withdrawal',reason:'Wrong saved source',withdrawnBy:'chief',withdrawnAt:'2026-11-11T02:00:00Z'},replacedBy:null as string|null};
    const sent:string[]=[];let replacement:Record<string,unknown>|undefined;
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        sent.push(String(options.body));const body=JSON.parse(String(options.body));
        if(sent.length===1)throw Error('Reply lost');
        old.replacedBy=body.linkId;replacement={...old,id:body.linkId,summary:body.summary,withdrawal:null,replacedBy:null,
          sourceEntryId:id,replacementOf:{linkId:'old-link',reason:body.replacementReason,recordedBy:'chief',recordedAt:'2026-11-11T03:00:00Z'}};
        return {ok:true,json:async()=>({id:body.linkId,batchId:'batch-1',stepNumber:1,alreadyLinked:true})};
      }
      return {ok:true,json:async()=>url.endsWith('/steps')?{steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null}]}:
        {links:replacement?[old,replacement]:[old]}};
    }));
    setServerConnection(connection);const screen=await mount();
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    await act(async()=>{select.value='journal:'+id;select.dispatchEvent(new Event('change',{bubbles:true}));});
    const original=screen.querySelector('select[aria-label="Отозванная ссылка для замены"]') as HTMLSelectElement;
    expect(original).toBeTruthy();
    await act(async()=>{original.value='old-link';original.dispatchEvent(new Event('change',{bubbles:true}));});
    const submit=[...screen.querySelectorAll('button')].find(b=>b.textContent==='Привязать запись') as HTMLButtonElement;
    await act(async()=>{(screen.querySelector('input[type="checkbox"]') as HTMLInputElement).click();});
    expect(submit.disabled).toBe(true);
    const reason=screen.querySelector('textarea[aria-label="Причина замены ссылки"]') as HTMLTextAreaElement;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(reason,'Choose the correct saved run');reason.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>{submit.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(screen.textContent).toContain('Reply lost');
    await act(async()=>{submit.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1]);
    expect(JSON.parse(sent[1])).toMatchObject({replacesLinkId:'old-link',replacementReason:'Choose the correct saved run',sourceEntryId:id});
    expect(JSON.parse(sent[1]).sourceMeasure).toBeUndefined();
    expect(screen.textContent).toContain('Withdrawn original');
    expect(screen.textContent).toContain('Correct saved journal');
    expect(screen.textContent).toContain('Заменяет ссылку: old-link');
    expect(journal.entries).toHaveLength(1);
  });

  it('does not let an old attachment failure clear a newer server login',async()=>{
    const id='417a31d1-9f8c-4939-8c2a-08303344abc1';
    journal.entries=[{id,stage:'coating',summary:'User record',createdAt:new Date('2026-11-10T10:00:00Z')}];
    let finish:(response:unknown)=>void=()=>{};
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(options.method==='POST')return new Promise(resolve=>{finish=resolve;});
      return {ok:true,json:async()=>url.endsWith('/steps')?{
        steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null}],
      }:{links:[]}};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount();
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    await act(async()=>{select.value='journal:'+id;select.dispatchEvent(new Event('change',{bubbles:true}));});
    await act(async()=>{(screen.querySelector('input[type="checkbox"]') as HTMLInputElement).click();});
    const submit=[...screen.querySelectorAll('button')].find(button=>button.textContent==='Привязать запись')!;
    await act(async()=>{submit.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(fetchMock.mock.calls.filter(call=>call[1].method==='POST')).toHaveLength(1);
    setServerConnection({...connection,session:{...connection.session,accessToken:'new-owner-token'}});
    await act(async()=>{finish({ok:false,status:401,json:async()=>({error:'unauthorized'})});});
    expect(getServerConnection()?.session.accessToken).toBe('new-owner-token');
    expect(screen.querySelector('[role="alert"]')).toBeNull();
  });

  it('withdraws with a reason, safely retries a lost reply and keeps the original completed-batch history',async()=>{
    let withdrawal:Record<string,unknown>|null=null;
    const sent:string[]=[];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>{
      if(options.method==='POST'){
        sent.push(String(options.body));
        const data=JSON.parse(String(options.body));
        withdrawal={id:data.withdrawalId,reason:data.reason,withdrawnBy:'chief',withdrawnAt:'2026-11-11T03:00:00Z'};
        if(sent.length===1)throw new Error('Reply lost');
        return {ok:true,json:async()=>({id:data.withdrawalId,batchId:'batch-1',linkId:'link-1',alreadyRecorded:true})};
      }
      return {ok:true,json:async()=>url.endsWith('/steps')?{steps:[]}:{batchId:'batch-1',links:[{
        id:'link-1',stepNumber:1,sourceStage:'coating',sourceEntryId:'local-1',sourceKind:'journal',
        sourceMeasure:null,sourceCreatedAt:'2026-11-10T10:00:00Z',summary:'Original retained record',
        defects:null,linkedBy:'chief',linkedAt:'2026-11-10T11:00:00Z',withdrawal,
      }]}};
    });
    vi.stubGlobal('fetch',fetchMock);setServerConnection(connection);
    const screen=await mount('completed');
    const find=(label:string)=>[...screen.querySelectorAll('button')].find(b=>b.textContent===label)!;
    await act(async()=>{find('Отозвать ссылку').click();});
    expect((find('Записать отзыв') as HTMLButtonElement).disabled).toBe(true);
    const reason=screen.querySelector('textarea[aria-label="Причина отзыва ссылки"]') as HTMLTextAreaElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(reason,'Wrong source selected');
      reason.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{find('Записать отзыв').closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(screen.textContent).toContain('Reply lost');
    expect(reason.value).toBe('Wrong source selected');
    await act(async()=>{find('Записать отзыв').closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1]);
    expect(screen.textContent).toContain('Original retained record');
    expect(screen.textContent).toContain('Ссылка отозвана');
    expect(screen.textContent).toContain('Wrong source selected');
    expect(find('Отозвать ссылку')).toBeUndefined();
  });

  it('never sends demo records automatically and requires confirmation',async()=>{
    const validId='7cf31394-36cb-4aa0-a9f1-949a70863621';
    journal.entries=[
      {id:'jr-001',stage:'coating',summary:'DEMO',createdAt:new Date('2026-11-10')},
      {id:'10b5328d-f30e-4df4-96e0-d823c7691462',stage:'coating',
        createdAt:new Date('2026-11-10')}, // Older row without a summary
      {id:'7a6b5e0c-d6f7-4e39-9dc2-d305ad4de777',stage:'coating',
        summary:'Malformed defects',defects:42,createdAt:new Date('2026-11-10')},
      {id:validId,stage:'coating',summary:'Cathode coating run',
        defects:'Pinholes',createdAt:new Date('2026-11-10T10:15:00.000Z')},
      {id:'b94476e6-80b1-4429-9d4b-f59680c59f50',stage:'assembly',
        summary:'Other stage',createdAt:new Date('2026-11-10T10:15:00.000Z')},
    ];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>({
      ok:true,json:async()=>{
        if(url.endsWith('/steps'))return {steps:[{
          number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null,
        }]};
        if(url.endsWith('/journal-links') && options.method==='GET')return {links:[]};
        return {id:'attached',alreadyLinked:false};
      },
    }));
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen=await mount();
    expect(screen.textContent).toContain('Связи с локальным журналом');
    expect(screen.textContent).toContain('Демонстрационные записи не предлагаются');
    const options=[...screen.querySelectorAll('select[aria-label="Локальная запись"] option')];
    expect(options.map(option=>option.textContent).join(' ')).toContain('Cathode coating run');
    expect(options.map(option=>option.textContent).join(' ')).not.toContain('DEMO');
    expect(options.map(option=>option.textContent).join(' ')).not.toContain('Other stage');
    expect(fetchMock.mock.calls.every(call=>call[1].method==='GET')).toBe(true);
    const button=[...screen.querySelectorAll('button')]
      .find(item=>item.textContent?.includes('Привязать запись'))!;
    expect(button.disabled).toBe(true);
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    await act(async()=>{
      select.value='journal:'+validId;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    const checkbox=screen.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async()=>{
      checkbox.click();
    });
    expect(button.disabled).toBe(false);
    const form=button.closest('form')!;
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    const posts=fetchMock.mock.calls.filter(call=>call[1].method==='POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toMatchObject({
      sourceEntryId:validId,sourceStage:'coating',
      sourceCreatedAt:'2026-11-10T10:15:00.000Z',
      summary:'Cathode coating run',defects:'Pinholes',
    });
    expect(journal.entries).toHaveLength(5);
    expect(screen.textContent).toContain('Исходный локальный журнал не изменён');
  });

  it('attaches a slurry mix snapshot with its reported dry-solids metric, not automatic output',async()=>{
    const mixId='efeb45b8-bf18-4d21-8b54-ef7c91d8cb2f';
    journal.mixes=[{id:mixId,recipeName:'LFP-12',batchKg:12.125,
      createdAt:1794312000000}];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>({
      ok:true,json:async()=>url.endsWith('/steps')?
        {steps:[{number:1,name:'Slurry',stage:'slurry',workshopId:'slurry',evidence:null}]}:
        options.method==='GET'?{links:[]}:{id:'linked',alreadyLinked:false},
    }));
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen=await mount();
    expect(fetchMock.mock.calls.every(call=>call[1].method==='GET')).toBe(true);
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    expect(select.textContent).toContain('Журнал замесов');
    await act(async()=>{
      select.value='mix_batch:'+mixId;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    expect(screen.textContent).toContain('Заявленная масса сухих веществ');
    const checkbox=screen.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async()=>{ checkbox.click(); });
    const form=screen.querySelector('button[type="submit"]')!.closest('form')!;
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    const posted=fetchMock.mock.calls.filter(call=>call[1].method==='POST');
    expect(posted).toHaveLength(1);
    expect(JSON.parse(String(posted[0][1].body))).toMatchObject({
      sourceKind:'mix_batch',sourceStage:'slurry',sourceEntryId:mixId,
      sourceMeasure:{kind:'dry_solids_kg',value:'12.125000'},
    });
    expect(journal.mixes).toHaveLength(1);
  });

  it('manually attaches a cutting record with an integer count, not a confirmed yield',async()=>{
    const cutId='f89bd1dc-8d10-42a7-b17b-f96160beb55a';
    journal.cuts=[{id:cutId,goodCount:87,electrodeType:'strip',createdAt:1794312000000}];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>({
      ok:true,json:async()=>url.endsWith('/steps')?
        {steps:[{number:1,name:'Cutting',stage:'cutting',workshopId:'cutting',evidence:null}]}:
        options.method==='GET'?{links:[]}:{id:'linked',alreadyLinked:false},
    }));
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen=await mount();
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    expect(select.textContent).toContain('Журнал нарезки');
    await act(async()=>{
      select.value='cut_run:'+cutId;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    expect(screen.textContent).toContain('Заявлено годных после нарезки, шт');
    const checkbox=screen.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async()=>{ checkbox.click(); });
    const form=screen.querySelector('button[type="submit"]')!.closest('form')!;
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    const sent=fetchMock.mock.calls.filter(call=>call[1].method==='POST');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0][1].body))).toMatchObject({
      sourceKind:'cut_run',sourceStage:'cutting',sourceEntryId:cutId,
      sourceMeasure:{kind:'cut_good_pieces',value:'87.000000'},
    });
    expect(journal.cuts).toHaveLength(1);
  });

  it('shows sorting input counts and manually attests a matching source only',async()=>{
    const sortId='a0ab4ab3-13d4-457c-9fb0-0f9c4dfc0732';
    journal.sorts=[{
      id:sortId,batchName:'ROLL-17',goodCount:74,
      createdAt:1794312000000,defects:'Visible burr',
    }];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>({
      ok:true,json:async()=>url.endsWith('/steps')?
        {steps:[{number:5,name:'Sorting',stage:'sorting',workshopId:'sorting',evidence:null}]}:
        options.method==='GET'?{links:[]}:{id:'linked',alreadyLinked:false},
    }));
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen=await mount();
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    expect(select.textContent).toContain('Журнал сортировки');
    await act(async()=>{
      select.value='sort_run:'+sortId;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    expect(screen.textContent).toContain('Заявлено поступивших годных на сортировку, шт');
    const checkbox=screen.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async()=>{checkbox.click();});
    const form=screen.querySelector('button[type="submit"]')!.closest('form')!;
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    const posts=fetchMock.mock.calls.filter(call=>call[1].method==='POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toMatchObject({
      sourceKind:'sort_run',sourceStage:'sorting',sourceEntryId:sortId,
      sourceMeasure:{kind:'sort_input_good_pieces',value:'74.000000'},
      defects:'Visible burr',
    });
    expect(journal.sorts).toHaveLength(1);
  });

  it('shows assembly cells out without leaking operation equipment parameters',async()=>{
    const id='b1de324e-8c34-4fc7-8d7b-c5b61a4ab301';
    journal.assemblies=[{id,batchName:'CELL-Lot',cellsOut:40,
      createdAt:'2026-11-10T10:10:00.000Z',
      defects:['Rejected visual inspection'],ops:[{params:{'POWER':'test-only-secret'}}]}];
    const fetchMock=vi.fn(async(url:string,options:RequestInit)=>({
      ok:true,json:async()=>url.endsWith('/steps')?
        {steps:[{number:6,name:'Assembly',stage:'assembly',workshopId:'assembly',evidence:null}]}:
        options.method==='GET'?{links:[]}:{id:'linked',alreadyLinked:false},
    }));
    vi.stubGlobal('fetch',fetchMock);
    setServerConnection(connection);
    const screen=await mount();
    const select=screen.querySelector('select[aria-label="Локальная запись"]') as HTMLSelectElement;
    expect(select.textContent).toContain('Журнал сборки');
    await act(async()=>{
      select.value='assembly_run:'+id;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    expect(screen.textContent).toContain('Заявлено собранных ячеек, шт');
    const checkbox=screen.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async()=>{checkbox.click();});
    const form=screen.querySelector('button[type="submit"]')!.closest('form')!;
    await act(async()=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      await Promise.resolve();
    });
    const sent=fetchMock.mock.calls.filter(call=>call[1].method==='POST');
    expect(sent).toHaveLength(1);
    const posted=JSON.parse(String(sent[0][1].body));
    expect(posted).toMatchObject({
      sourceKind:'assembly_run',sourceStage:'assembly',sourceEntryId:id,
      sourceMeasure:{kind:'assembled_cells_out',value:'40.000000'},
      defects:'Rejected visual inspection',
    });
    expect(JSON.stringify(posted)).not.toContain('test-only-secret');
    expect(journal.assemblies).toHaveLength(1);
  });

  it('never offers link writes for held batches',async()=>{
    journal.entries=[{id:'7cf31394-36cb-4aa0-a9f1-949a70863621',
      stage:'coating',summary:'Offline record',createdAt:new Date('2026-11-10')}];
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>({
      ok:true,json:async()=>url.endsWith('/steps')?
        {steps:[{number:1,name:'Coating',stage:'coating',workshopId:'coating',evidence:null}]}:
        {links:[]},
    })));
    setServerConnection(connection);
    const screen=await mount('hold');
    expect(screen.querySelector('button[type="submit"]')).toBeNull();
  });
});
