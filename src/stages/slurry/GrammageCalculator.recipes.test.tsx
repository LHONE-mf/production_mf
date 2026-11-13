import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type MixRecipe,type MixBatch} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {SLURRY_BASIS} from '../../core/manufacturing/slurryMath';
import * as slurry from '../../core/manufacturing/slurryBatch';
import {GrammageCalculator} from './GrammageCalculator';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved slurry packet</p>}));
let node:HTMLDivElement,root:Root,recipe:MixRecipe,nextRecipe:MixRecipe;
let release:(()=>void)|undefined,pendingSave:Promise<MixBatch>|undefined;
const consumed=vi.fn(),confirmReplacement=vi.fn<(message:string)=>boolean>(()=>false);
const field=(label:string)=>node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
const fill=async(label:string,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field(label),value);field(label).dispatchEvent(new Event('input',{bubbles:true}));});
const click=async(label:string)=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent===label)!.click();});
const render=async(preset:MixRecipe)=>act(async()=>root.render(<GrammageCalculator presetRecipe={preset} onPresetConsumed={consumed}/>));
const checkpointed=()=>wait(()=>expect(node.textContent).toContain('Черновик формы сохранён на устройстве'));
beforeEach(async()=>{
 consumed.mockClear();confirmReplacement.mockReset().mockReturnValue(false);release=undefined;pendingSave=undefined;
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('confirm',confirmReplacement);await db.open();
 const worker={id:'worker',login:'worker',fullName:'TEST worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};await db.users.add(worker);useAuthStore.setState({currentUser:worker});
 await db.mixComponents.add({id:'powder',name:'TEST powder',kind:'active',solidsMassFraction:1,updatedAt:1});
 recipe={id:'first',name:'TEST first recipe',basis:SLURRY_BASIS,dryMassKg:1,lines:[{componentId:'powder',pct:100}],mode:[],updatedBy:'master',updatedAt:1};nextRecipe={...recipe,id:'next',name:'TEST next recipe',dryMassKg:2};await db.mixRecipes.bulkAdd([recipe,nextRecipe]);
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
 await render(recipe);await wait(()=>expect(consumed).toHaveBeenCalledTimes(1));await checkpointed();
});
afterEach(async()=>{
 await act(async()=>{release?.();await pendingSave?.catch(()=>{});});await act(async()=>root.unmount());node.remove();
 useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.restoreAllMocks();vi.unstubAllGlobals();
});
it('keeps entered and stored values when recipe replacement is cancelled, and replaces them only after explicit confirmation',async()=>{
 expect(confirmReplacement).not.toHaveBeenCalled();
 await fill('Код партии замеса','TEST-retain');await fill('Фактическая масса 1, г','1000,0');await fill('Основание навесок и состава','TEST existing weighing record');await checkpointed();
 const before=await db.localFormDrafts.toArray();
 await render(nextRecipe);await wait(()=>expect(consumed).toHaveBeenCalledTimes(2));
 expect(confirmReplacement).not.toHaveBeenCalled();expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain('TEST next recipe');
 expect(field('Название состава').value).toBe(recipe.name);expect(field('Код партии замеса').value).toBe('TEST-retain');expect(field('Фактическая масса 1, г').value).toBe('1000,0');expect(field('Основание навесок и состава').value).toBe('TEST existing weighing record');
 expect(await db.localFormDrafts.toArray()).toEqual(before);
 await click('Оставить текущий черновик');expect(node.querySelector('[role="alertdialog"]')).toBeNull();
 await render({...nextRecipe});await wait(()=>expect(node.querySelector('[role="alertdialog"]')).not.toBeNull());
 await click('Заменить черновик рецептом');await wait(()=>expect(field('Название состава').value).toBe(nextRecipe.name));await checkpointed();
 expect(field('План СВ, кг').value).toBe('2');expect(field('Код партии замеса').value).toBe('');expect(field('Фактическая масса 1, г').value).toBe('');
 const payload=(await db.localFormDrafts.toArray())[0].payload as {source:MixRecipe};expect(payload.source).toEqual(nextRecipe);
 expect(await db.mixBatches.count()).toBe(0);expect(await db.journal.count()).toBe(0);
});
it('blocks a recipe change during a pending production save and keeps that save bound to its original recipe and weights',async()=>{
 await fill('Код партии замеса','TEST-pending');await fill('Фактическая масса 1, г','1000');await fill('Основание навесок и состава','TEST supplied basis');await checkpointed();
 const gate=new Promise<void>(resolve=>{release=resolve;}),original=slurry.saveSlurryBatch;
 const save=vi.spyOn(slurry,'saveSlurryBatch').mockImplementation((...args)=>{
  pendingSave=(async()=>{await gate;return original(...args);})();return pendingSave;
 });
 await click('Записать измеренный замес');await wait(()=>expect(save).toHaveBeenCalledTimes(1));
 await render(nextRecipe);await wait(()=>expect(consumed).toHaveBeenCalledTimes(2));
 expect(node.textContent).toContain('Завершите текущую запись');expect(confirmReplacement).not.toHaveBeenCalled();
 expect(field('Название состава').value).toBe(recipe.name);expect(field('Фактическая масса 1, г').value).toBe('1000');
 await act(async()=>{release!();await pendingSave;});await wait(()=>expect(node.textContent).toContain('Сохранён измеренный замес TEST-pending'));
 const saved=(await db.mixBatches.toArray())[0];expect(saved.recipeSnapshot).toEqual(recipe);expect(saved.weighings[0].actualG).toBe(1000);expect(await db.mixBatches.count()).toBe(1);expect(await db.journal.count()).toBe(1);
 expect(field('Название состава').value).toBe(recipe.name);expect(confirmReplacement).not.toHaveBeenCalled();
});
it('retains uncheckpointed input when draft persistence fails rather than replacing it with a selected recipe',async()=>{
 const before=await db.localFormDrafts.toArray(),fail=()=>{throw Error('TEST draft checkpoint failed');};db.localFormDrafts.hook('updating',fail);
 try{await fill('Фактическая масса 1, г','987,5');await wait(()=>expect(node.textContent).toContain('TEST draft checkpoint failed'));}finally{db.localFormDrafts.hook('updating').unsubscribe(fail);}
 await render(nextRecipe);await wait(()=>expect(consumed).toHaveBeenCalledTimes(2));
 expect(confirmReplacement).not.toHaveBeenCalled();expect(field('Название состава').value).toBe(recipe.name);expect(field('Фактическая масса 1, г').value).toBe('987,5');expect(await db.localFormDrafts.toArray()).toEqual(before);
 await click('Повторить сохранение черновика');await checkpointed();await render({...nextRecipe});await wait(()=>expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain('TEST next recipe'));
 expect(confirmReplacement).not.toHaveBeenCalled();
 expect(field('Фактическая масса 1, г').value).toBe('987,5');expect(await db.mixBatches.count()).toBe(0);
});
