import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type User,type MixRecipe,type MixComponent} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {SLURRY_BASIS} from '../../core/manufacturing/slurryMath';
import {GrammageCalculator} from './GrammageCalculator';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved slurry packet</p>}));
it('keeps missing weights unknown, retains a failed draft/ID and exports only one committed measured snapshot',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const worker:User={id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};await db.users.add(worker);useAuthStore.setState({currentUser:worker});
 const materials:MixComponent[]=[{id:'powder',name:'Powder',kind:'active',solidsMassFraction:1,updatedAt:1},{id:'liquid',name:'Liquid',kind:'solvent',solidsMassFraction:0,updatedAt:1}];await db.mixComponents.bulkAdd(materials);
 const recipe:MixRecipe={id:'recipe',name:'Selected recipe',basis:SLURRY_BASIS,dryMassKg:1,lines:[{componentId:'powder',pct:100},{componentId:'liquid',pct:100}],mode:[],updatedBy:'master',updatedAt:1};await db.mixRecipes.add(recipe);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
 const click=async(text:string)=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!.click();});
 const fill=async(label:string,value:string)=>act(async()=>{const input=node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 try{
  await act(async()=>root.render(<GrammageCalculator presetRecipe={recipe}/>));await wait(()=>expect(node.textContent).toContain('Selected recipe'));
  await fill('Код партии замеса','SL-001');await fill('Основание навесок и состава','Weighed grams; declared material composition');await click('Записать измеренный замес');await wait(()=>expect(node.textContent).toContain('пустое значение неизвестно'));
  expect(await db.mixBatches.count()).toBe(0);await fill('Фактическая масса 1, г','1000');await fill('Фактическая масса 2, г','0');await wait(()=>expect(node.textContent).toContain('СВ по навескам и составу: 100'));
  let failedId='';const fail=(_key:unknown,row:{id:string})=>{failedId=row.id;throw Error('Slurry journal failed');};db.journal.hook('creating',fail);
  try{await click('Записать измеренный замес');await wait(()=>expect(node.textContent).toContain('Slurry journal failed'));expect(await db.mixBatches.count()).toBe(0);expect(node.textContent).not.toContain('Saved slurry packet');}finally{db.journal.hook('creating').unsubscribe(fail);}
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Фактическая масса 2, г"]')!.value).toBe('0');
  await act(async()=>{const b=[...node.querySelectorAll('button')].find(b=>b.textContent?.includes('Записать измеренный замес'))!;b.click();b.click();});await wait(()=>expect(node.textContent).toContain('Saved slurry packet'));
  const saved=(await db.mixBatches.toArray())[0];expect(saved.id).toBe(failedId);expect(await db.mixBatches.count()).toBe(1);expect(saved.massBalance?.totalActualG).toBe(1000);expect(saved.modeActual).toBeUndefined();expect(saved.pasteCalc).toBeUndefined();expect(await db.journal.get(saved.id)).toBeDefined();
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
