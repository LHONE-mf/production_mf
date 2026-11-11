import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {CalendaringModule} from './CalendaringRoom';

let root:Root|undefined,node:HTMLDivElement|undefined;
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;node?.remove();node=undefined;useAuthStore.setState({currentUser:null});
  db.close();await db.delete();localStorage.removeItem('lip_calender_params_v1');vi.unstubAllGlobals();
});
it('does not treat an unmarked legacy thickness as a dry-electrode measurement',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'technologist',login:'tech',fullName:'Technologist',password:'test-only',
    role:UserRole.TECHNOLOGIST,isActive:true,createdAt:new Date()}});
  await db.rollSpecs.add({id:'legacy',mixName:'Unmarked legacy roll',thicknessBeforeUm:200,segLengthsM:[10],createdAt:1});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CalendaringModule/>);});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Unmarked legacy roll'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Параметры прокатки'))!.click();});
  const target=node.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(target,'100');
    target.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(node.textContent).not.toContain('Обжатие:');
  expect(node.textContent).not.toContain('Изменение полной толщины:');
  expect((await db.rollSpecs.get('legacy'))?.thicknessBeforeUm).toBe(200);
});

it('starts with no sample machine settings and compares only the attributed dry measurement',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'technologist',login:'tech',fullName:'Technologist',password:'test-only',
    role:UserRole.TECHNOLOGIST,isActive:true,createdAt:new Date()}});
  await db.rollSpecs.add({id:'measured',mixName:'Measured dry roll',thicknessBeforeUm:100,
    thicknessBeforeMeasurement:{basis:'dry-electrode-including-foil',recordedBy:'operator',recordedAt:1},segLengthsM:[10],createdAt:1});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CalendaringModule/>);});
  await vi.waitFor(()=>expect(node!.textContent).toContain('Measured dry roll'));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent?.includes('Параметры прокатки'))!.click();});
  expect([...node.querySelectorAll<HTMLInputElement>('input[type="number"]')].every(input=>input.value==='')).toBe(true);
  const target=node.querySelector<HTMLInputElement>('[aria-label="Целевая полная толщина, мкм"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(target,'80');target.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(node.textContent).toContain('Плановое уменьшение полной толщины: ~20%');
  expect(node.textContent).toContain('не фактическое обжатие');
  const save=[...node.querySelectorAll('button')].find(button=>button.textContent?.includes('Назначить и отправить'))!;
  expect(save.disabled).toBe(true);
  const heating=node.querySelector<HTMLSelectElement>('[aria-label="Назначение нагрева валков"]')!;
  await act(async()=>{heating.value='no';heating.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(save.disabled).toBe(false);
  await act(async()=>{save.click();});
  await vi.waitFor(async()=>expect(await db.calenderRuns.count()).toBe(1));
  expect((await db.calenderRuns.get('measured'))?.params).toMatchObject({
    targetThicknessUm:80,targetThicknessBasis:'dry-electrode-including-foil',heating:false,
  });
  expect((await db.calenderRuns.get('measured'))?.params?.pressureTons).toBeUndefined();
});
