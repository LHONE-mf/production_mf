import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CoatingModule } from './CoatingRoom';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved coating packet</p>}));

let root:Root|undefined,node:HTMLDivElement|undefined;
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  node?.remove();root=undefined;node=undefined;
  useAuthStore.setState({currentUser:null});
  db.close();await db.delete();vi.unstubAllGlobals();
});
it('does not save an empty coating run or invented machine defaults',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'test-operator',login:'operator',fullName:'Test operator',
    password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});
  await vi.waitFor(()=>expect(node!.querySelector('[aria-label="Фольга"]')).not.toBeNull());
  const save=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал нанесения'))!;
  await act(async()=>{save.click();});
  expect(await db.coatRuns.count()).toBe(0);
  expect(await db.journal.count()).toBe(0);
  expect(node.querySelectorAll('input[inputmode="decimal"]').length).toBeGreaterThan(0);
  expect([...node.querySelectorAll('input[inputmode="decimal"]')].every(input=>(input as HTMLInputElement).value==='')).toBe(true);
});


it('retains the form on storage failure, prevents duplicate clicks and reopens the recorded result',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  const operator={id:'test-operator',login:'operator',fullName:'Test operator',password:'test-only',
    role:UserRole.WORKER,isActive:true,createdAt:new Date()};
  await db.users.add(operator);useAuthStore.setState({currentUser:operator});
  await db.coatIncomingMixes.add({mixBatchId:'measured',recipeName:'Measured slurry',
    pasteDensity:2,solidsPctMass:50,createdAt:1});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Measured slurry'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});
  await vi.waitFor(()=>expect(node!.querySelector('[aria-label="Фольга"]')).not.toBeNull());
  await act(async()=>{const select=node!.querySelector<HTMLSelectElement>('[aria-label="Замес для нанесения"]')!;select.value='measured';select.dispatchEvent(new Event('change',{bubbles:true}));[...node!.querySelectorAll('button')].find(b=>b.textContent==='Сплошное')!.click();});
  const edit=(label:string,value:string)=>{
    const input=node!.querySelector<HTMLInputElement>('[aria-label="'+label+'"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  };
  await act(async()=>{
    edit('Фольга','Measured Al');edit('Сухая поверхностная плотность, мг/см²','20,');
    edit('Ширина полосы, см','50');edit('Скорость фольги, м/мин','8');
    edit('Калиброванная подача, см³/об','25');edit('Заданный зазор, мкм','180');edit('Длина участка 1, м','10,125');
    edit('Измеренная толщина сухого электрода, мкм','100');edit('Длина стороны B, м','0');
  });
  expect(node.textContent).toContain('200');
  let failedId='';const fail=(_key:unknown,row:{id:string})=>{failedId=row.id;throw new Error('Storage temporarily unavailable');};
  db.journal.hook('creating',fail);
  const save=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал нанесения'))!;
  try{
    await act(async()=>{save.click();});
    await vi.waitFor(()=>expect(node!.querySelector('[role="alert"]')?.textContent).toContain('Storage temporarily unavailable'));
  }finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(await db.coatRuns.count()).toBe(0);expect(await db.journal.count()).toBe(0);
  expect(node.querySelector<HTMLInputElement>('[aria-label="Длина участка 1, м"]')!.value).toBe('10,125');
  await act(async()=>root!.unmount());db.close();await db.open();root=createRoot(node);await act(async()=>root!.render(<CoatingModule/>));await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});
  await vi.waitFor(()=>expect(node!.querySelector<HTMLInputElement>('[aria-label="Сухая поверхностная плотность, мг/см²"]')?.value).toBe('20,'));
  const retry=[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал нанесения'))!;await vi.waitFor(()=>expect(retry.disabled).toBe(false));
  await act(async()=>{retry.click();retry.click();});
  await vi.waitFor(async()=>expect(await db.coatRuns.count()).toBe(1));
  expect(await db.journal.count()).toBe(1);expect((await db.coatRuns.toArray())[0].id).toBe(failedId);
  expect((await db.coatRuns.toArray())[0].measuredDryThicknessUm).toBe(100);
  expect((await db.journal.toArray())[0].params).toMatchObject({'Измеренная сухая толщина с фольгой, мкм':100});
  await act(async()=>{root!.unmount();});
  db.close();await db.open();
  root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Журнал нанесения'))!.click();});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Measured Al'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Measured Al'))!.click();});
  expect(node.textContent).toContain('B 0 м');
  expect(node.textContent).toContain('Калиброванная подача');
  expect(node.textContent).toContain('25 см³/об');
  expect(node.textContent).toContain('0.8 л/мин');
  expect(node.textContent).toContain('не указаны');
  const original=(await db.coatRuns.toArray())[0];const noWrite=()=>{throw Error('Export attempted a write');};db.coatRuns.hook('updating',noWrite);
  try{await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Отправить master'))!.click();});await vi.waitFor(()=>expect(node!.textContent).toContain('Saved coating packet'));expect(await db.coatRuns.get(original.id)).toEqual(original);}finally{db.coatRuns.hook('updating').unsubscribe(noWrite);}
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});await vi.waitFor(()=>expect(node!.textContent).toContain('Сохранена запись нанесения'));expect(await db.coatRuns.count()).toBe(1);
  const draft=(await db.localFormDrafts.toArray()).find(row=>row.scope==='coating')!;const corrupted={...draft.payload as Record<string,unknown>,attempt:undefined};await act(async()=>root!.unmount());await db.localFormDrafts.update(draft.key,{payload:corrupted});root=createRoot(node);await act(async()=>root!.render(<CoatingModule/>));await vi.waitFor(()=>expect(node!.querySelector('[role="alert"]')).not.toBeNull());expect(node.querySelector('[aria-label="Фольга"]')).toBeNull();expect((await db.localFormDrafts.get(draft.key))?.payload).toEqual(corrupted);expect(await db.coatRuns.count()).toBe(1);
});

it('never promotes estimated wet thickness to a measured dry-roll handover',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'operator',login:'operator',fullName:'Operator',password:'test-only',
    role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
  await db.coatRuns.add({id:'legacy-wet-estimate',foilType:'Handover fixture',wetThicknessUm:200,
    mode:'continuous',segLengthsM:[10],sideALengthM:10,ovenTempsC:[],workerId:'operator',createdAt:1,updatedAt:1});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Журнал нанесения'))!.click();});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Handover fixture'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Handover fixture'))!.click();});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Рулон технологу'))!.click();});
  await vi.waitFor(async()=>expect(await db.rollSpecs.count()).toBe(1));
  expect((await db.rollSpecs.get('legacy-wet-estimate'))?.thicknessBeforeUm).toBeUndefined();
  expect((await db.coatRuns.get('legacy-wet-estimate'))?.wetThicknessUm).toBe(200);
});

it('separates actual observations from estimates and keeps theoretical values collapsed on a phone',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'test-operator',login:'operator',fullName:'Operator',
    password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});
  await vi.waitFor(()=>expect(node!.querySelector('[aria-label="Измеренные наблюдения"]')).not.toBeNull());
  const actual=node!.querySelector('[aria-label="Измеренные наблюдения"]')!;
  const planned=node!.querySelector('[aria-label="План и назначенные параметры"]')!;
  expect(actual.querySelector('[aria-label="Измеренная толщина сухого электрода, мкм"]')).not.toBeNull();
  expect(planned.querySelector('[aria-label="Измеренная толщина сухого электрода, мкм"]')).toBeNull();
  expect(planned.querySelector('[aria-label="Заданный зазор, мкм"]')).not.toBeNull();
  const theoretical=[...node!.querySelectorAll('details')].find(d=>d.textContent?.includes('Теоретические оценки'))!;
  expect(theoretical.open).toBe(false);
  expect(theoretical.textContent).toContain('Только расчёт');
  expect(node!.textContent).toContain('Проверка и сохранение локальной записи');
  expect(await db.coatRuns.count()).toBe(0);
});
