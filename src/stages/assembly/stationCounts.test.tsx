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
  for(const values of [['1.5','1','0'],['10','1.5','0'],['10','1','0.5'],['-1','0','0'],['0','0','0'],['10','-1','0'],['10','1','-1'],['10','1',''],['','1','0'],['10','','0'],['9007199254740992','1','0']]){
   await fill(values);await click();expect(save).not.toHaveBeenCalled();expect(node.querySelector('[role="alert"]')).not.toBeNull();
   expect([...node.querySelectorAll<HTMLInputElement>('input[type="number"]')].slice(0,3).map(input=>input.value)).toEqual(values);
  }
  await fill(['10','0','10']);await click();expect(save).toHaveBeenCalledWith(expect.objectContaining({qtyIn:10,qtyOut:0,qtyScrap:10}));
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});
