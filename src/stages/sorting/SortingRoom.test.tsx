import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {SortingModule} from './SortingRoom';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:({packet}:{packet:{payload:unknown}})=> <div data-testid="packet">{JSON.stringify(packet.payload)}</div>}));
let root:Root|undefined,node:HTMLDivElement|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;node?.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();});
async function mount(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 useAuthStore.setState({currentUser:{id:'operator',login:'operator',fullName:'Operator',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
 await db.cuttingRuns.add({id:'cut',incomingId:'roll',electrodeType:'strip',goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1});
 await db.sortSpecs.add({id:'spec',batchName:'roll',cutRunId:'cut',electrodeType:'strip',parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1});
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await act(async()=>{root!.render(<SortingModule/>);});
 await vi.waitFor(()=>expect(node!.textContent).toContain('roll'));
 await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Сортировать'))!.click();});
 await vi.waitFor(()=>expect(node!.querySelector('select')?.textContent).toContain('roll'));
 const select=node!.querySelector('select')!;
 await act(async()=>{select.value='cut';select.dispatchEvent(new Event('change',{bubbles:true}));});
 return node!;
}
function edit(index:number,value:string){const input=node!.querySelectorAll<HTMLInputElement>('input[type="number"]')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}
it('rejects fractional partitions even when the displayed arithmetic total equals the input',async()=>{
 const page=await mount();await act(async()=>{edit(0,'1.5');edit(3,'8.5');});
 const save=[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал'))!;
 await act(async()=>{save.click();});
 expect(await db.sortRuns.count()).toBe(0);expect(page.querySelector('[data-testid="packet"]')).toBeNull();
});

it('retains a failed partition, exports only after commit and blocks another allocation',async()=>{
 const page=await mount();await act(async()=>{edit(0,'8');edit(3,'2');});
 const save=[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал'))!;
 const fail=()=>{throw new Error('Sorting storage unavailable');};db.sortRuns.hook('creating',fail);
 try{await act(async()=>{save.click();});await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable'));}
 finally{db.sortRuns.hook('creating').unsubscribe(fail);}
 expect(await db.sortRuns.count()).toBe(0);expect(page.querySelector('[data-testid="packet"]')).toBeNull();
 expect(page.querySelector<HTMLInputElement>('[aria-label="Количество категории A"]')!.value).toBe('8');
 await act(async()=>{save.click();save.click();});
 await vi.waitFor(async()=>expect(await db.sortRuns.count()).toBe(1));
 const [saved]=await db.sortRuns.toArray();expect(saved).toMatchObject({cutRunId:'cut',goodCount:10,rejected:2,buckets:[{categoryName:'A',count:8}]});
 await vi.waitFor(()=>expect(page.querySelector('[data-testid="packet"]')?.textContent).toContain(saved.id));
 const select=page.querySelector<HTMLSelectElement>('[aria-label="Партия для сортировки"]')!;
 await act(async()=>{select.value='cut';select.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>{edit(0,'8');edit(3,'2');});
 await act(async()=>{[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал'))!.click();});
 await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('уже распределена'));
 expect(await db.sortRuns.count()).toBe(1);
});


async function referenceRoom(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 await db.open();
 await db.users.add({id:'chief',login:'chief',fullName:'Chief Tester',password:'hashed-test',role:UserRole.CHIEF,isActive:true,createdAt:new Date()});
 useAuthStore.setState({currentUser:(await db.users.get('chief'))!});
 await db.cuttingRuns.add({id:'TEST-cut',incomingId:'TEST-roll',electrodeType:'strip',goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1});
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await act(async()=>{root!.render(<SortingModule/>);});
 await vi.waitFor(()=>expect(node!.textContent).toContain('TEST-roll'));
 return node!;
}
async function clickText(text:string){
 const button=[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes(text));
 expect(button, 'Expected button containing '+text).toBeTruthy();
 await act(async()=>{button!.click();});
}
function enterText(input:HTMLInputElement,value:string){
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
 input.dispatchEvent(new Event('input',{bubbles:true}));
}

it('retains spec editor on failed write and saves locally without forbidden packet',async()=>{
 const page=await referenceRoom();
 await clickText('Спецификации КД');
 await clickText('Новая спецификация');
 const fail=()=>{throw new Error('TEST-spec-write-failed');};
 db.sortSpecs.hook('creating',fail);
 try{
  await clickText('Сохранить локально');
  await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('TEST-spec-write-failed'));
 }finally{db.sortSpecs.hook('creating').unsubscribe(fail);}
 expect(page.textContent).toContain('Новая спецификация сортировки');
 expect(page.querySelector('[data-testid="packet"]')).toBeNull();
 expect(await db.sortSpecs.count()).toBe(0);
 await clickText('Сохранить локально');
 await vi.waitFor(async()=>expect(await db.sortSpecs.count()).toBe(1));
 await vi.waitFor(()=>expect(page.textContent).toContain('Сохранена локально'));
 expect(page.querySelector('[data-testid="packet"]')).toBeNull();
 expect(page.textContent).not.toContain('Принудительно');
});

it('does not close defect editor or offer transfer when its write fails',async()=>{
 const page=await referenceRoom();
 await clickText('Реестр дефектов');
 await clickText('Добавить дефект');
 const title=page.querySelector<HTMLInputElement>('input')!;
 await act(async()=>enterText(title,'TEST-edge-delamination'));
 const fail=()=>{throw new Error('TEST-defect-write-failed');};
 db.defectRegistry.hook('creating',fail);
 try{
  await clickText('Сохранить локально');
  await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('TEST-defect-write-failed'));
 }finally{db.defectRegistry.hook('creating').unsubscribe(fail);}
 expect((page.querySelector('input') as HTMLInputElement).value).toBe('TEST-edge-delamination');
 expect(await db.defectRegistry.count()).toBe(0);
 expect(page.querySelector('[data-testid="packet"]')).toBeNull();
 await clickText('Сохранить локально');
 await vi.waitFor(async()=>expect(await db.defectRegistry.count()).toBe(1));
 await vi.waitFor(()=>expect(page.textContent).toContain('Сохранено локально'));
 expect(page.querySelector('[data-testid="packet"]')).toBeNull();
});

it('refuses stale local specification edits without replacing the newer record',async()=>{
 const page=await referenceRoom();
 await db.sortSpecs.add({id:'TEST-spec',batchName:'TEST-roll',cutRunId:'TEST-cut',electrodeType:'strip',parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Approved'}],authorId:'chief',createdAt:1,updatedAt:42});
 await clickText('Спецификации КД');
 await vi.waitFor(()=>expect(page.textContent).toContain('Thickness'));
 await clickText('Изменить');
 await db.sortSpecs.update('TEST-spec',{parameterName:'Newer spec',updatedAt:43});
 await clickText('Сохранить локально');
 await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toMatch(/изменен|изменена|обновлен|обновлена/i));
 expect((await db.sortSpecs.get('TEST-spec'))?.parameterName).toBe('Newer spec');
});
