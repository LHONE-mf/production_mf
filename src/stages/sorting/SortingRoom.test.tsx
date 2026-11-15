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
 const operator={id:'operator',login:'operator',fullName:'Operator',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};
 await db.users.add(operator);
 useAuthStore.setState({currentUser:operator});
 await db.cuttingRuns.add({id:'cut',incomingId:'roll',electrodeType:'strip',goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1});
 await db.sortSpecs.add({id:'spec',batchName:'roll',cutRunId:'cut',electrodeType:'strip',parameterName:'Sorting KD',unit:'g',categories:[
  {name:'A',criteria:'Mass grade A',minMass:1,maxMass:1.5,minUm:70,maxUm:80},
  {name:'B',criteria:'Mass grade B',minMass:1.5,maxMass:2,minUm:70,maxUm:80},
 ],authorId:'tech',createdAt:1,updatedAt:1});
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await act(async()=>{root!.render(<SortingModule/>);});
 await vi.waitFor(()=>expect(node!.textContent).toContain('roll'));
 await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Сортировать'))!.click();});
 await vi.waitFor(()=>expect(node!.querySelector<HTMLSelectElement>('[aria-label="Партия для сортировки"]')?.value).toBe('cut'));
 return node!;
}
async function clickRoomButton(text:string){
 let button:HTMLButtonElement|undefined;
 // The live query can expose the next station before draft cleanup releases busy.
 // A click on its disabled control is ignored; wait for an actionable button.
 await vi.waitFor(()=>{
  button=[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes(text));
  expect(button,'Expected button containing '+text).toBeTruthy();
  expect(button!.disabled).toBe(false);
 });
 await act(async()=>{button!.click();});
}
async function typeCount(label:string,value:string){
 const input=node!.querySelector<HTMLInputElement>('[aria-label="'+label+'"]');
 expect(input,'Missing input '+label).toBeTruthy();
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input!.dispatchEvent(new Event('input',{bubbles:true}));
 });
}
it('rejects invalid counts and a failed station write without losing operator input',async()=>{
 const page=await mount();
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(async()=>expect(await db.sortingWorkflows.count()).toBe(1));
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 await typeCount('Прошло контроль','1.5');await typeCount('Отбраковано на станции','8.5');
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(0);
 expect([...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Сохранить 1.'))?.disabled).toBe(true);
 await typeCount('Прошло контроль','8');await typeCount('Отбраковано на станции','2');
 const fail=()=>{throw new Error('TEST-sorting-write-failed');};db.sortingWorkflows.hook('updating',fail);
 try{
  await clickRoomButton('Сохранить 1.');
  await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('TEST-sorting-write-failed'));
 }finally{db.sortingWorkflows.hook('updating').unsubscribe(fail);}
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(0);
 expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')?.value).toBe('8');
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(async()=>expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(1));
 expect(page.textContent).toContain('2. Контроль толщины');
 await clickRoomButton('Партии с нарезки');
 await vi.waitFor(()=>expect(page.textContent).toContain('следующая станция: Контроль толщины'));
 expect(page.textContent).toContain('Завершено станций: 1/3');
 await clickRoomButton('Продолжить сортировку');
 expect(page.textContent).toContain('2. Контроль толщины');
});
it('offers a station handoff packet only after saving inspection decisions',async()=>{
 const page=await mount();
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 expect(page.textContent).not.toContain('Передать станции (1/3)');
 await typeCount('Прошло контроль','9');
 await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(()=>expect(page.textContent).toContain('Передать станции (1/3)'));
 expect(await db.sortRuns.count()).toBe(0);
 await clickRoomButton('Передать станции (1/3)');
 const displayed=page.querySelector('[data-testid="packet"]');
 expect(displayed?.textContent).toContain('"station":"visual"');
 expect(displayed?.textContent).not.toContain('"station":"thickness"');
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(1);
});
it('completes visual-thickness-mass in pass/fail mode, excluding failures and emitting saved packet',async()=>{
 const page=await mount();
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(async()=>expect(await db.sortingWorkflows.count()).toBe(1));
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 await typeCount('Прошло контроль','9');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(()=>expect([...page.querySelectorAll('button')].some(b=>b.textContent?.includes('Сохранить 2.'))).toBe(true));
 await typeCount('Прошло контроль','8');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 2.');
 await vi.waitFor(()=>expect([...page.querySelectorAll('button')].some(b=>b.textContent?.includes('Сохранить 3.'))).toBe(true));
 await typeCount('Прошло контроль','7');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 3.');
 await vi.waitFor(()=>expect(page.textContent).toContain('Итоги сортировки'));
 expect(await db.sortRuns.count()).toBe(0);
 await clickRoomButton('Партии с нарезки');
 await vi.waitFor(()=>expect(page.textContent).toContain('Все три станции завершены'));
 expect(page.textContent).not.toContain('следующая станция: undefined');
 await clickRoomButton('Завершить сортировку');
 expect(page.textContent).toContain('Итоги сортировки');
 await clickRoomButton('Завершить сортировку и записать в журнал');
 await vi.waitFor(async()=>expect(await db.sortRuns.count()).toBe(1));
 const [saved]=await db.sortRuns.toArray();
 expect(saved).toMatchObject({cutRunId:'cut',goodCount:10,rejected:3,buckets:[{categoryName:'PASS',count:7}],
  sortingWorkflow:{mode:'pass-fail',stages:[
   {station:'visual',inputCount:10,passedCount:9,rejectedCount:1},
   {station:'thickness',inputCount:9,passedCount:8,rejectedCount:1},
   {station:'mass',inputCount:8,passedCount:7,rejectedCount:1},
  ]}});
 await vi.waitFor(()=>expect(page.querySelector('[data-testid="packet"]')?.textContent).toContain(saved.id));
 await clickRoomButton('Партии с нарезки');
 await vi.waitFor(()=>expect(page.textContent).toContain('Сортировка завершена'));
 await clickRoomButton('Смотреть журнал');
 expect(page.textContent).toContain('Этапы контроля: визуальный');
 expect(page.textContent).toContain('1. Визуальный контроль');
 expect(page.textContent).toContain('3. Контроль массы');
});
it('grades only by mass after passing thickness, keeping grade totals separate',async()=>{
 const page=await mount();
 const grading=page.querySelector<HTMLInputElement>('input[name="sort-mode"][value="grading"]')!;
 await act(async()=>{grading.click();});
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(async()=>expect(await db.sortingWorkflows.count()).toBe(1));
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 await typeCount('Прошло контроль','9');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(()=>expect([...page.querySelectorAll('button')].some(b=>b.textContent?.includes('Сохранить 2.'))).toBe(true));
 await typeCount('Прошло контроль','8');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 2.');
 await vi.waitFor(()=>expect(page.querySelector('[aria-label="Количество сорта A"]')).toBeTruthy());
 expect(page.querySelector('[aria-label="Прошло контроль"]')).toBeNull();
 await typeCount('Количество сорта A','5');await typeCount('Количество сорта B','2');
 await typeCount('Отбраковано на станции','1');await clickRoomButton('Сохранить 3.');
 await vi.waitFor(()=>expect(page.textContent).toContain('Итоги сортировки'));
 await clickRoomButton('Завершить сортировку');
 await vi.waitFor(async()=>expect(await db.sortRuns.count()).toBe(1));
 const saved=(await db.sortRuns.toArray())[0];
 expect(saved).toMatchObject({goodCount:10,rejected:3,buckets:[{categoryName:'A',count:5},{categoryName:'B',count:2}]});
 expect(saved.sortingWorkflow?.stages.map(s=>s.station)).toEqual(['visual','thickness','mass']);
});

it('requires an explicit tap for count shortcuts and shows the previous operator at handoff',async()=>{
 const page=await mount();
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 const passed=()=>page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]');
 const failed=()=>page.querySelector<HTMLInputElement>('[aria-label="Отбраковано на станции"]');
 const complement=()=>[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Подставить годные = вход'));
 expect(passed()?.value).toBe('');
 expect(failed()?.value).toBe('');
 expect(complement()?.disabled).toBe(true);
 await clickRoomButton('Указать брак = 0');
 expect(failed()?.value).toBe('0');
 expect(passed()?.value).toBe(''); // no automatic quality classification
 expect(complement()?.disabled).toBe(false);
 await clickRoomButton('Подставить годные = вход');
 expect(passed()?.value).toBe('10');
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(0);
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(()=>expect([...page.querySelectorAll('button')].some(b=>b.textContent?.includes('Сохранить 2.'))).toBe(true));
 expect(page.textContent).toContain('По журналу 1. Визуальный контроль: прошло 10 шт');
 expect(page.textContent).toContain('оператор operator');
 expect(page.textContent).toContain('не подтверждение физической передачи');
 expect(passed()?.value).toBe(''); // a new station never inherits an operator decision
 await typeCount('Отбраковано на станции','2');
 await clickRoomButton('Подставить годные = вход');
 expect(passed()?.value).toBe('8');
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(1);
});

it('fills only explicitly empty mass grades with zero without overwriting chosen grade counts',async()=>{
 const page=await mount();
 const grading=page.querySelector<HTMLInputElement>('input[name="sort-mode"][value="grading"]')!;
 await act(async()=>{grading.click();});
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 await typeCount('Прошло контроль','9');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 1.');
 await vi.waitFor(()=>expect([...page.querySelectorAll('button')].some(b=>b.textContent?.includes('Сохранить 2.'))).toBe(true));
 await typeCount('Прошло контроль','8');await typeCount('Отбраковано на станции','1');
 await clickRoomButton('Сохранить 2.');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Количество сорта A"]')).toBeTruthy());
 const a=()=>page.querySelector<HTMLInputElement>('[aria-label="Количество сорта A"]');
 const b=()=>page.querySelector<HTMLInputElement>('[aria-label="Количество сорта B"]');
 expect(a()?.value).toBe('');expect(b()?.value).toBe('');
 await typeCount('Количество сорта A','7');
 await typeCount('Отбраковано на станции','1');
 expect(b()?.value).toBe(''); // no mass grade assigned automatically
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(2);
 await clickRoomButton('Пустые сорта = 0');
 expect(a()?.value).toBe('7');expect(b()?.value).toBe('0');
 await clickRoomButton('Сохранить 3.');
 await vi.waitFor(async()=>expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(3));
 expect((await db.sortingWorkflows.get('cut'))?.stages[2].grades).toEqual([
  {categoryName:'A',count:7},{categoryName:'B',count:0},
 ]);
 expect(await db.sortRuns.count()).toBe(0); // no implicit finalization
});

it('restores unfinished station counts after closing and reopening the Sorting room',async()=>{
 const page=await mount();
 await clickRoomButton('Начать сортировку');
 await vi.waitFor(()=>expect(page.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')).toBeTruthy());
 await vi.waitFor(()=>expect(page.textContent).toContain('Автосохранение формы'));
 await typeCount('Прошло контроль','7');
 await typeCount('Отбраковано на станции','3');
 await vi.waitFor(async()=>{
  const raw=(await db.localFormDrafts.get(JSON.stringify(['operator','sorting'])))?.payload as
   {entries?:Record<string,{passed?:string;rejected?:string}>}|undefined;
  const entry=raw?.entries?.[JSON.stringify(['cut',0])];
  expect(entry).toMatchObject({passed:'7',rejected:'3'});
 });
 await act(async()=>{root!.unmount();});node?.remove();root=undefined;
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await act(async()=>{root!.render(<SortingModule/>);});
 await vi.waitFor(()=>expect(node!.textContent).toContain('roll'));
 await vi.waitFor(()=>expect(node!.textContent).toContain('Продолжить сортировку'));
 await clickRoomButton('Продолжить сортировку');
 await vi.waitFor(()=>expect(node!.querySelector<HTMLInputElement>('[aria-label="Прошло контроль"]')?.value).toBe('7'));
 expect(node!.querySelector<HTMLInputElement>('[aria-label="Отбраковано на станции"]')?.value).toBe('3');
 expect((await db.sortingWorkflows.get('cut'))?.stages).toHaveLength(0);
 expect(await db.sortRuns.count()).toBe(0);
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
