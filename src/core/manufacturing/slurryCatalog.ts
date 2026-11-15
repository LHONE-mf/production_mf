import {db} from '../db';
import type {MixComponent,MixRecipe,UserRole} from '../types';
import {CELL_OUTPUT_ROLES} from './assemblyCellOutput';
import {validateSlurryComponent,calculateSlurryPlan,SLURRY_BASIS} from './slurryMath';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function permitted(role?:UserRole){if(!role||!CELL_OUTPUT_ROLES.includes(role))throw new Error('Изменение справочника требует локальной роли технолога, мастера или начальника');}
export async function receiveSlurryComponent(component:MixComponent,role?:UserRole):Promise<MixComponent>{
 return db.transaction('rw',db.mixComponents,async()=>{
  const old=await db.mixComponents.get(component?.id);if(old&&same(old,component))return old;
  permitted(role);validateSlurryComponent(component);
  if(old&&component.updatedAt<=old.updatedAt)throw new Error('Известная или более старая версия материала не заменяется другим содержимым');
  await db.mixComponents.put(component);return component;
 });
}
export async function receiveSlurryRecipe(recipe:MixRecipe,role?:UserRole):Promise<MixRecipe>{
 return db.transaction('rw',db.mixRecipes,db.mixComponents,async()=>{
  const old=await db.mixRecipes.get(recipe?.id);if(old&&same(old,recipe))return old;
  permitted(role);
  if(!recipe||typeof recipe.id!=='string'||!recipe.id.trim()||typeof recipe.name!=='string'||!recipe.name.trim()||!Number.isFinite(recipe.dryMassKg)||recipe.dryMassKg<=0||!Number.isFinite(recipe.updatedAt)||recipe.updatedAt<=0||!Array.isArray(recipe.lines)||!Array.isArray(recipe.mode)||new Set(recipe.lines.map(line=>line.componentId)).size!==recipe.lines.length||recipe.lines.some(line=>!line||typeof line.componentId!=='string'||!line.componentId.trim()||!Number.isFinite(line.pct)||line.pct<0)||recipe.basis!==undefined&&recipe.basis!==SLURRY_BASIS)throw new Error('Рецепт имеет неверную базу, массу, состав или версию');
  if(old&&recipe.updatedAt<=old.updatedAt)throw new Error('Известная или более старая версия рецепта не заменяется другим содержимым');
  if(recipe.basis===SLURRY_BASIS){const components=await db.mixComponents.bulkGet(recipe.lines.map(line=>line.componentId));if(components.every(component=>component?.solidsMassFraction!==undefined))calculateSlurryPlan(recipe.lines,components as MixComponent[],recipe.dryMassKg,recipe.basis);}
  await db.mixRecipes.put(recipe);return recipe;
 });
}
