import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../core/db';
import { UserRole, type CuttingIncoming } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CuttingModule } from './CuttingRoom';

vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:({packet}:{packet:{payload:unknown}})=>
  <div data-testid="outgoing-packet">{JSON.stringify(packet.payload)}</div>}));
const incoming:CuttingIncoming={id:'incoming',electrodeType:'strip',electrodeLengthMm:100,
  roll:{id:'roll',mixName:'Measured double-sided roll',sideALengthM:10,sideBLengthM:10,segLengthsM:[10],createdAt:1},createdAt:1};
let root:Root|undefined,node:HTMLDivElement|undefined;
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
  useAuthStore.setState({currentUser:{id:'operator',login:'operator',fullName:'Operator',password:'test-only',
    role:UserRole.WORKER,isActive:true,createdAt:new Date()}});
  await db.cuttingRolls.add(incoming);
});
afterEach(async()=>{
  if(root)await act(async()=>root!.unmount());
  root=undefined;node?.remove();node=undefined;
  useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();
});
async function mount(){
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  await act(async()=>{root!.render(<CuttingModule/>);});
  await vi.waitFor(()=>expect(node!.textContent).toContain(incoming.roll.mixName));
  await act(async()=>{[...node!.querySelectorAll('button')].find(b=>b.textContent==='✂️ Резать')!.click();});
  return node;
}
function edit(label:string,value:string){
  const field=[...node!.querySelectorAll('label')].find(l=>l.textContent?.includes(label))!;
  const input=(field.querySelector('input')??field.nextElementSibling) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
}
it('does not infer a physical cutting length from summed A+B coverage',async()=>{
  const page=await mount();
  expect(page.textContent).not.toContain('Ожидаемо электродов:');
  expect(page.textContent).toContain('измеренную длину');
});
it('rejects fractional actual piece counts without saving or exporting',async()=>{
  const page=await mount();
  await act(async()=>{edit('Годных электродов','1.5');edit('С дефектами','0');});
  await act(async()=>{[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Сохранить и отправить'))!.click();});
  expect(await db.cuttingRuns.count()).toBe(0);
  expect(page.querySelector('[data-testid="outgoing-packet"]')).toBeNull();
  expect(page.querySelector('[role="alert"]')).not.toBeNull();
});

it('saves measured geometry once, retains inputs after failure and reopens the same result',async()=>{
  const page=await mount();
  await act(async()=>{edit('Измеренная длина полотна','10');edit('Ширина ножа','0');
    edit('Годных электродов','90');edit('С дефектами','10');});
  expect(page.textContent).toContain('100 шт');
  const fail=()=>{throw new Error('Test write failure');};
  db.cuttingRuns.hook('creating',fail);
  const save=[...page.querySelectorAll('button')].find(b=>b.textContent?.includes('Сохранить и отправить'))!;
  try{
    await act(async()=>{save.click();});
    await vi.waitFor(()=>expect(page.querySelector('[role="alert"]')?.textContent).toContain('Test write failure'));
  }finally{db.cuttingRuns.hook('creating').unsubscribe(fail);}
  expect(await db.cuttingRuns.count()).toBe(0);
  expect(page.querySelector('[data-testid="outgoing-packet"]')).toBeNull();
  expect(page.querySelector<HTMLInputElement>('[aria-label="Измеренная длина полотна, м"]')!.value).toBe('10');
  await act(async()=>{save.click();save.click();});
  await vi.waitFor(async()=>expect(await db.cuttingRuns.count()).toBe(1));
  const [run]=await db.cuttingRuns.toArray();
  expect(run).toMatchObject({incomingId:'incoming',goodCount:90,defectCount:10,
    yieldCalculation:{physicalLengthM:10,kerfMm:0,expected:100}});
  await vi.waitFor(()=>expect(page.querySelector('[data-testid="outgoing-packet"]')?.textContent).toContain(run.id));
  await act(async()=>{root!.unmount();});node!.remove();root=undefined;
  db.close();await db.open();
  expect(await db.cuttingRuns.get(run.id)).toEqual(run);
  const reopened=await mount();
  await act(async()=>{[...reopened.querySelectorAll('button')].find(b=>b.textContent?.includes('Журнал нарезки'))!.click();});
  await vi.waitFor(()=>expect(reopened.textContent).toContain('Оценка раскроя: 100 шт'));
  expect(reopened.textContent).toContain('Измеренная длина полотна: 10 м');
});

it('resets the draft when selecting another source roll',async()=>{
  const page=await mount();
  await act(async()=>{edit('Измеренная длина полотна','10');edit('Ширина ножа','0');edit('Годных электродов','90');});
  await act(async()=>{await db.cuttingRolls.add({...incoming,id:'other',createdAt:2,roll:{...incoming.roll,id:'other-roll',mixName:'Another roll'}});});
  const select=page.querySelector<HTMLSelectElement>('[aria-label="Рулон для нарезки"]')!;
  await vi.waitFor(()=>expect(select.options.length).toBe(2));
  await act(async()=>{select.value='other';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(page.querySelector<HTMLInputElement>('[aria-label="Измеренная длина полотна, м"]')!.value).toBe('');
  expect(page.querySelector<HTMLInputElement>('[aria-label="Годных электродов"]')!.value).toBe('');
  expect(page.textContent).not.toContain('Ожидаемо электродов:');
});
