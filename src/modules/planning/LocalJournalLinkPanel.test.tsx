import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection,setServerConnection,type ServerConnection } from '../../core/sync/serverConnection';
import type { Batch } from '../../core/planning/planningClient';

const journal = vi.hoisted(() => ({
  entries: [] as Array<Record<string,unknown>>,
  reads: 0,
}));
vi.mock('../../core/db', () => ({
  db:{journal:{orderBy:() => ({reverse:() => ({
    limit:() => ({toArray:async () => {journal.reads++;return journal.entries;}}),
  })})}},
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
  journal.entries=[];journal.reads=0;
  clearServerConnection();vi.unstubAllGlobals();
});

describe('M2 manual link of existing local journal',()=>{
  it('never sends demo records automatically and requires confirmation',async()=>{
    const validId='7cf31394-36cb-4aa0-a9f1-949a70863621';
    journal.entries=[
      {id:'jr-001',stage:'coating',summary:'DEMO',createdAt:new Date('2026-11-10')},
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
      select.value=validId;
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
    expect(journal.entries).toHaveLength(3);
    expect(screen.textContent).toContain('Исходный локальный журнал не изменён');
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
