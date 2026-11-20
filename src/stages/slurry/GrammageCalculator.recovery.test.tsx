import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type MixBatch,type MixRecipe,type User} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {SLURRY_BASIS} from '../../core/manufacturing/slurryMath';
import * as slurry from '../../core/manufacturing/slurryBatch';
import {GrammageCalculator} from './GrammageCalculator';

vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Packet preview</p>}));

const worker=(id:string):User=>({id,login:id,fullName:id,password:'test-only',
 role:UserRole.WORKER,isActive:true,createdAt:new Date()});
let node:HTMLDivElement,root:Root,first:User,second:User,recipe:MixRecipe;
const input=(label:string)=>node.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]');
const wait=(check:()=>void|Promise<void>)=>vi.waitFor(async()=>{await act(async()=>{});await check();});
const fill=async(label:string,value:string)=>act(async()=>{
 const element=input(label);expect(element, 'Missing input '+label).not.toBeNull();
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);
 element!.dispatchEvent(new Event('input',{bubbles:true}));
});
const click=async(label:string)=>act(async()=>{
 const element=[...node.querySelectorAll('button')].find(button=>button.textContent===label);
 expect(element,'Missing action '+label).toBeDefined();
 element!.click();
});
const draftFor=async(id:string)=>db.localFormDrafts.get(JSON.stringify([id,'slurry']));
const restart=async()=>{
 await act(async()=>root.unmount());db.close();await db.open();
 root=createRoot(node);await act(async()=>root.render(<GrammageCalculator/>));
};
const switchTo=async(user:User)=>{
 await act(async()=>{useAuthStore.getState().login(user);});
 await wait(()=>expect(node.textContent).toContain('План и измеренные навески'));
};

beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 await db.open();
 first=worker('slurry-operator-a');second=worker('slurry-operator-b');
 await db.users.bulkAdd([first,second]);
 await db.mixComponents.add({id:'powder',name:'Powder',kind:'active',solidsMassFraction:1,updatedAt:1});
 recipe={id:'powder-recipe',name:'Formula A',basis:SLURRY_BASIS,dryMassKg:1,
  lines:[{componentId:'powder',pct:100}],mode:[],updatedBy:first.id,updatedAt:1};
 await db.mixRecipes.add(recipe);
 useAuthStore.getState().login(first);
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await act(async()=>root.render(<GrammageCalculator presetRecipe={recipe}/>));
 await wait(()=>expect(input('Название состава')?.value).toBe('Formula A'));
});
afterEach(async()=>{
 await act(async()=>root.unmount());node.remove();
 useAuthStore.getState().logout();db.close();await db.delete();
 vi.restoreAllMocks();vi.unstubAllGlobals();
});

it('recovers raw measured values and recipe snapshot after restart without showing them to another local user',async()=>{
 await fill('Код партии замеса','A-LOT-12');
 await fill('Фактическая масса 1, г','1000,25');
 await fill('Основание навесок и состава','Physical scale log 12');
 await wait(async()=>expect((await draftFor(first.id))?.payload).toMatchObject({
  source:recipe,draft:{batchCode:'A-LOT-12',
   lines:[{componentId:'powder',actual:'1000,25'}],note:'Physical scale log 12'},
 }));
 const durableA=(await draftFor(first.id))!;
 await act(async()=>root.unmount());db.close();await db.open();
 useAuthStore.getState().login(second);
 root=createRoot(node);await act(async()=>root.render(<GrammageCalculator/>));
 await wait(()=>expect(input('Код партии замеса')?.value).toBe(''));
 expect(node.textContent).not.toContain('A-LOT-12');
 expect(node.textContent).not.toContain('Physical scale log 12');
 await fill('Код партии замеса','B-LOT-77');
 await wait(async()=>expect((await draftFor(second.id))?.payload).toMatchObject({
  draft:{batchCode:'B-LOT-77'},
 }));
 await switchTo(first);
 await wait(()=>expect(input('Код партии замеса')?.value).toBe('A-LOT-12'));
 expect(input('Фактическая масса 1, г')?.value).toBe('1000,25');
 expect(input('Основание навесок и состава')?.value).toBe('Physical scale log 12');
 expect((await draftFor(first.id))?.payload).toEqual(durableA.payload);
 expect(await db.mixBatches.count()).toBe(0);
 expect(await db.journal.count()).toBe(0);
 await switchTo(second);
 await wait(()=>expect(input('Код партии замеса')?.value).toBe('B-LOT-77'));
 expect(node.textContent).not.toContain('A-LOT-12');
});

it('retries the SAME frozen ID after restart and user switch if the first commit never completed',async()=>{
 await fill('Код партии замеса','A-RETRY');
 await fill('Фактическая масса 1, г','1000');
 await fill('Основание навесок и состава','Source: scale A');
 await wait(async()=>expect((await draftFor(first.id))?.payload).toMatchObject({
  draft:{batchCode:'A-RETRY'},
 }));
 const original=slurry.saveSlurryBatch;
 const spy=vi.spyOn(slurry,'saveSlurryBatch').mockRejectedValueOnce(Error('TEST before-commit failure'));
 await click('Записать измеренный замес');
 await wait(()=>expect(node.textContent).toContain('TEST before-commit failure'));
 expect(spy).toHaveBeenCalledTimes(1);
 const attempt=((await draftFor(first.id))?.payload as {attempt:MixBatch}).attempt;
 expect(attempt.id).toBeTruthy();
 expect(await db.mixBatches.count()).toBe(0);
 await restart();
 await wait(()=>expect(input('Фактическая масса 1, г')?.value).toBe('1000'));
 expect(input('Фактическая масса 1, г')?.closest('fieldset')?.disabled).toBe(true);
 await switchTo(second);
 await wait(()=>expect(input('Код партии замеса')?.value).toBe(''));
 expect(node.textContent).not.toContain('A-RETRY');
 await switchTo(first);
 await wait(()=>expect(input('Код партии замеса')?.value).toBe('A-RETRY'));
 expect(input('Фактическая масса 1, г')?.closest('fieldset')?.disabled).toBe(true);
 await click('Записать измеренный замес');
 await wait(()=>expect(node.textContent).toContain('Сохранён измеренный замес A-RETRY'));
 expect((await db.mixBatches.toArray()).map(batch=>batch.id)).toEqual([attempt.id]);
 expect(await db.journal.count()).toBe(1);
 expect(((await draftFor(first.id))?.payload as {attempt:MixBatch}).attempt.id).toBe(attempt.id);
});

it('recovers an already COMMITTED frozen attempt after lost confirmation without creating duplicate journal rows',async()=>{
 await fill('Код партии замеса','A-COMMITTED');
 await fill('Фактическая масса 1, г','1000');
 await fill('Основание навесок и состава','Scale result retained');
 await wait(async()=>expect((await draftFor(first.id))?.payload).toMatchObject({
  draft:{batchCode:'A-COMMITTED'},
 }));
 const original=slurry.saveSlurryBatch;
 const spy=vi.spyOn(slurry,'saveSlurryBatch').mockImplementationOnce(async(...args)=>{
  await original(...args);
  throw Error('TEST local response lost after commit');
 });
 await click('Записать измеренный замес');
 await wait(()=>expect(node.textContent).toContain('TEST local response lost after commit'));
 expect(spy).toHaveBeenCalledTimes(1);
 const frozen=((await draftFor(first.id))?.payload as {attempt:MixBatch}).attempt;
 expect((await db.mixBatches.get(frozen.id))?.weighings[0].actualG).toBe(1000);
 expect(await db.journal.count()).toBe(1);
 await act(async()=>root.unmount());db.close();await db.open();
 useAuthStore.getState().login(second);
 root=createRoot(node);await act(async()=>root.render(<GrammageCalculator/>));
 await wait(()=>expect(input('Код партии замеса')?.value).toBe(''));
 await switchTo(first);
 await wait(()=>expect(node.textContent).toContain('Сохранён измеренный замес A-COMMITTED'));
 expect(input('Фактическая масса 1, г')?.closest('fieldset')?.disabled).toBe(true);
 expect(node.textContent).not.toContain('Packet preview');
 expect(await db.mixBatches.count()).toBe(1);
 expect(await db.journal.count()).toBe(1);
 expect((await draftFor(first.id))?.payload).toMatchObject({attempt:frozen});
 expect([...node.querySelectorAll('button')].find(button=>
  button.textContent==='Записать измеренный замес')?.disabled).toBe(true);
});
