import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CoatingModule } from './CoatingRoom';

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
  const save=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал нанесения'))!;
  await act(async()=>{save.click();});
  expect(await db.coatRuns.count()).toBe(0);
  expect(await db.journal.count()).toBe(0);
  expect([...node.querySelectorAll('input[type="number"]')].every(input=>(input as HTMLInputElement).value==='')).toBe(true);
});


it('retains the form on storage failure, prevents duplicate clicks and reopens the recorded result',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  const operator={id:'test-operator',login:'operator',fullName:'Test operator',password:'test-only',
    role:UserRole.WORKER,isActive:true,createdAt:new Date()};
  useAuthStore.setState({currentUser:operator});
  await db.coatIncomingMixes.add({mixBatchId:'measured',recipeName:'Measured slurry',
    pasteDensity:2,solidsPctMass:50,createdAt:1});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Measured slurry'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Подстройка линии'))!.click();});
  const edit=(label:string,value:string)=>{
    const input=node!.querySelector<HTMLInputElement>('[aria-label="'+label+'"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  };
  await act(async()=>{
    edit('Фольга','Measured Al');edit('Сухая поверхностная плотность, мг/см²','20');
    edit('Ширина полосы, см','50');edit('Скорость фольги, м/мин','8');
    edit('Калиброванная подача, см³/об','25');edit('Заданный зазор, мкм','180');edit('Длина участка 1, м','10');
  });
  expect(node.textContent).toContain('200');
  const fail=()=>{throw new Error('Storage temporarily unavailable');};
  db.journal.hook('creating',fail);
  const save=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать в журнал нанесения'))!;
  try{
    await act(async()=>{save.click();});
    await vi.waitFor(()=>expect(node!.querySelector('[role="alert"]')?.textContent).toContain('Storage temporarily unavailable'));
  }finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(await db.coatRuns.count()).toBe(0);expect(await db.journal.count()).toBe(0);
  expect(node.querySelector<HTMLInputElement>('[aria-label="Длина участка 1, м"]')!.value).toBe('10');
  await act(async()=>{save.click();save.click();});
  await vi.waitFor(async()=>expect(await db.coatRuns.count()).toBe(1));
  expect(await db.journal.count()).toBe(1);
  await act(async()=>{root!.unmount();});
  db.close();await db.open();
  root=createRoot(node);
  await act(async()=>{root!.render(<CoatingModule/>);});
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Журнал нанесения'))!.click();});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Measured Al'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Measured Al'))!.click();});
  expect(node.textContent).toContain('Калиброванная подача');
  expect(node.textContent).toContain('25 см³/об');
  expect(node.textContent).toContain('0.8 л/мин');
  expect(node.textContent).toContain('не указаны');
});
