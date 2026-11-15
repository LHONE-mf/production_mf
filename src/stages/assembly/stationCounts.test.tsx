import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import type {AssemblyRun} from '../../core/types';
import {LiElectrodesStation} from './LiElectrodesStation';
import {ZStackingStation} from './ZStackingStation';
import {WindingStation} from './WindingStation';
import {CrimpCylStation} from './CrimpCylStation';
import {UsPrismaticStation} from './UsPrismaticStation';
import {LaserPrismaticStation} from './LaserPrismaticStation';
async function chooseUnits(node:HTMLElement){
 await act(async()=>{const select=node.querySelector<HTMLSelectElement>('select[aria-label="Источник операции"]')!;select.value='declared';select.dispatchEvent(new Event('change',{bubbles:true}));});
 for(const [label,value] of [['Идентификатор внешнего источника','station-fixture-source'],['Основание разных единиц','Entered observed counts, no calculated rate']])await act(async()=>{
  const input=node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
 });
 for(const [i,value] of ['parts','electrodes','parts'].entries())await act(async()=>{
  const select=node.querySelectorAll<HTMLSelectElement>('select[aria-label^="Единица"]')[i];select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));
 });
}
const run:AssemblyRun={id:'legacy',batchName:'Existing recorded batch',cellType:'cylindrical',ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId:'worker',createdAt:'2026-11-11',updatedAt:'2026-11-11'};
it.each([LiElectrodesStation,ZStackingStation,WindingStation,CrimpCylStation,UsPrismaticStation,LaserPrismaticStation])('%s rejects invalid counts without truncation or clearing the form',async Station=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);const save=vi.fn();
 const fill=async(values:string[])=>{for(const [i,value] of values.entries())await act(async()=>{
  const input=node.querySelectorAll<HTMLInputElement>('input[type="number"]')[i];
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });};
 const click=()=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Зафиксировать операцию'))!.click();});
 try{
  await act(async()=>root.render(<Station run={run} workerId="worker" onAddOp={save}/>));
  await chooseUnits(node);
  for(const values of [['1.5','1','0'],['10','1.5','0'],['10','1','0.5'],['-1','0','0'],['0','0','0'],['10','-1','0'],['10','1','-1'],['10','1',''],['','1','0'],['10','','0'],['9007199254740992','1','0']]){
   await fill(values);await click();expect(save).not.toHaveBeenCalled();expect(node.querySelector('[role="alert"]')).not.toBeNull();
   expect([...node.querySelectorAll<HTMLInputElement>('input[type="number"]')].slice(0,3).map(input=>input.value)).toEqual(values);
  }
  await fill(['10','0','10']);await click();expect(save).toHaveBeenCalledWith(expect.objectContaining({qtyIn:10,qtyOut:0,qtyScrap:10}));
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});

it.each([LiElectrodesStation,ZStackingStation,WindingStation,CrimpCylStation,UsPrismaticStation,LaserPrismaticStation])('%s waits for durable save before clearing and blocks a second submit',async Station=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});const save=vi.fn(()=>pending);
 try{
  await act(async()=>root.render(<Station run={run} workerId="worker" onAddOp={save}/>));
  await chooseUnits(node);
  for(const [i,value] of ['10','0','10'].entries())await act(async()=>{
   const input=node.querySelectorAll<HTMLInputElement>('input[type="number"]')[i];
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Зафиксировать операцию'))!.click();});
  expect(node.querySelectorAll<HTMLInputElement>('input[type="number"]')[0].value).toBe('10');
  await act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Зафиксировать операцию'))!.click();});
  expect(save).toHaveBeenCalledTimes(1);
  await act(async()=>{finish();await pending;});
  expect(node.querySelectorAll<HTMLInputElement>('input[type="number"]')[0].value).toBe('');
 }finally{finish();await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});
it.each([LiElectrodesStation,ZStackingStation,WindingStation,CrimpCylStation,UsPrismaticStation,LaserPrismaticStation])('%s retains a rejected draft and retries the exact operation identity',async Station=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const attempts:unknown[]=[];const save=vi.fn(async(op:unknown)=>{attempts.push(structuredClone(op));if(attempts.length===1)throw Error('Disk unavailable');});
 try{
  await act(async()=>root.render(<Station run={run} workerId="worker" onAddOp={save}/>));await chooseUnits(node);
  for(const [i,value] of ['10','8','2'].entries())await act(async()=>{
   const input=node.querySelectorAll<HTMLInputElement>('input[type="number"]')[i];
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  const click=()=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Зафиксировать операцию'))!.click();});
  await click();expect(node.textContent).toContain('Disk unavailable');
  expect(node.querySelectorAll<HTMLInputElement>('input[type="number"]')[0].value).toBe('10');
  await click();expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  expect(node.querySelectorAll<HTMLInputElement>('input[type="number"]')[0].value).toBe('');
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});
