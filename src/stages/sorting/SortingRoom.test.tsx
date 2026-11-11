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
