import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {UserRole,StageId,type MixComponent,type MixRecipe,type MixBatch} from '../types';
import {SLURRY_BASIS,calculateSlurryPlan,slurryMassBalance} from './slurryMath';
import {saveSlurryBatch,receiveSlurryBatch,prepareSlurryHandover,receiveSlurryHandover,SLURRY_UNITS} from './slurryBatch';
import {applyPacket} from '../../transfer/apply';
vi.mock('../security',()=>({verifyPacketSig:vi.fn(async()=>true)}));
let components:MixComponent[],recipe:MixRecipe,batch:MixBatch;
beforeEach(async()=>{
 await db.open();await db.users.bulkAdd([{id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()},{id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()}]);
 components=[{id:'powder',name:'Declared powder',kind:'active',solidsMassFraction:1,updatedAt:1},{id:'binder',name:'Declared binder solution',kind:'binder',solidsMassFraction:.5,updatedAt:1},{id:'liquid',name:'Declared liquid',kind:'solvent',solidsMassFraction:0,updatedAt:1}];
 recipe={id:'recipe',name:'Recorded recipe',basis:SLURRY_BASIS,dryMassKg:1,lines:[{componentId:'powder',pct:90},{componentId:'binder',pct:10},{componentId:'liquid',pct:100}],mode:[],updatedBy:'master',updatedAt:1};await db.mixComponents.bulkAdd(components);await db.mixRecipes.add(recipe);
 const plan=calculateSlurryPlan(recipe.lines,components,1,SLURRY_BASIS);const weighings=plan.rows.map(row=>({componentId:row.componentId,plannedG:row.grams,actualG:row.grams}));const now=Date.now();
 batch={id:'batch',measurementVersion:1,batchCode:'SL-001',recipeId:recipe.id,recipeName:recipe.name,recipeSnapshot:recipe,componentSnapshots:components,recipePlan:{basis:SLURRY_BASIS,lines:recipe.lines},batchKg:1,weighings,massBalance:slurryMassBalance(weighings,components),measurementUnits:SLURRY_UNITS,measurementNote:'Weighed grams; component fractions from declared material data',workerId:'worker',recordedRole:UserRole.WORKER,createdAt:now,updatedAt:now};
});
afterEach(async()=>{db.close();await db.delete();});
it('saves immutable planned/actual mass and catalog snapshots with one attributed journal across retry/reopen',async()=>{
 const [a,b]=await Promise.all([saveSlurryBatch(batch,'worker'),saveSlurryBatch(batch,'worker')]);expect(a).toEqual(b);expect(await db.mixBatches.count()).toBe(1);expect((await db.journal.get(batch.id))?.params?.['Снимок замеса']).toBe(JSON.stringify(batch));
 await db.mixComponents.update('powder',{name:'New catalog name',updatedAt:2});await db.mixRecipes.update('recipe',{name:'New recipe',updatedAt:2});db.close();await db.open();
 expect(await saveSlurryBatch(batch,'worker')).toEqual(batch);expect((await db.mixBatches.get(batch.id))?.componentSnapshots?.[0].name).toBe('Declared powder');
 await expect(saveSlurryBatch({...batch,notes:'Changed intent'},'worker')).rejects.toThrow();
});
it('rejects missing/negative masses, invalid basis/units, fabricated actual mode/predictions and stale source versions/actors',async()=>{
 for(const patch of [{weighings:[{...batch.weighings[0],actualG:undefined},...batch.weighings.slice(1)]},{weighings:[{...batch.weighings[0],actualG:-1},...batch.weighings.slice(1)]},{measurementUnits:{...SLURRY_UNITS,mass:'kg'}},{massBalance:{...batch.massBalance,totalActualG:1}},{recipePlan:{...batch.recipePlan,basis:'wet-percent'}},{modeActual:[{id:'copied-plan',name:'Planned mode',vacuumOn:false,minutes:1}]},{pasteCalc:{solidsPctMass:99,solidsPctVol:50,pasteDensity:3,etaModel:'invented',etaPredictedCp:1}}])await expect(saveSlurryBatch({...batch,...patch} as MixBatch,'worker')).rejects.toThrow();
 await db.mixComponents.update('powder',{updatedAt:2});await expect(saveSlurryBatch(batch,'worker')).rejects.toThrow();await db.mixComponents.put(components[0]);
 await db.mixRecipes.update('recipe',{updatedAt:2});await expect(saveSlurryBatch(batch,'worker')).rejects.toThrow();await db.mixRecipes.put(recipe);
 await db.users.update('worker',{isActive:false});await expect(saveSlurryBatch(batch,'worker')).rejects.toThrow();expect(await db.mixBatches.count()).toBe(0);
});
it('rolls batch/journal back together and serializes different IDs claiming the same batch identity',async()=>{
 const fail=()=>{throw Error('Slurry journal failed');};db.journal.hook('creating',fail);
 try{await expect(saveSlurryBatch(batch,'worker')).rejects.toThrow('Slurry journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.mixBatches.count()).toBe(0);expect(await db.journal.get(batch.id)).toBeUndefined();
 const results=await Promise.allSettled([saveSlurryBatch(batch,'worker'),saveSlurryBatch({...batch,id:'another',batchCode:' sl-001 '},'worker')]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(await db.mixBatches.count()).toBe(1);
});
it('exports a durable stable coating handover from actual masses and entered density only, without changing the source',async()=>{
 await saveSlurryBatch(batch,'worker');const first=await prepareSlurryHandover(batch,'worker');expect(first.sourceBatch).toEqual(batch);expect(first.solidsPctMass).toBeCloseTo(1000/2100*100);expect(first.pasteDensity).toBeUndefined();expect(first.solidsPctVol).toBeUndefined();expect(first.viscosity).toBeUndefined();expect(first.batchKg).toBe(1);
 expect(await prepareSlurryHandover(batch,'worker')).toEqual(first);expect(await db.mixBatches.get(batch.id)).toEqual(batch);
 await expect(prepareSlurryHandover({...batch,measuredDensity:2},'worker')).rejects.toThrow();
 db.close();await db.open();expect(await db.coatIncomingMixes.get(batch.id)).toEqual(first);
});
it('rolls coating preparation back on journal failure and prevents typed/generic forced packet source stripping',async()=>{
 await saveSlurryBatch(batch,'worker');const fail=()=>{throw Error('Handover journal failed');};db.journal.hook('creating',fail);
 try{await expect(prepareSlurryHandover(batch,'worker')).rejects.toThrow('Handover journal failed');}finally{db.journal.hook('creating').unsubscribe(fail);}
 expect(await db.coatIncomingMixes.count()).toBe(0);const snap=await prepareSlurryHandover(batch,'worker');
 const packet=(type:'mix-batch'|'coating-mix'|'forced-push',payload:unknown,stage=StageId.SLURRY)=>({v:1 as const,type,payload,stage,from:'master',role:UserRole.MASTER,forced:type==='forced-push',ts:Date.now()});
 for(const type of ['mix-batch','forced-push'] as const)for(const payload of [{...batch,notes:'Altered'},{...batch,measurementVersion:undefined,componentSnapshots:undefined,recipeSnapshot:undefined,recipePlan:undefined,massBalance:undefined,measurementUnits:undefined}])expect((await applyPacket(packet(type,payload))).ok).toBe(false);
 for(const payload of [{...snap,pasteDensity:5},{mixBatchId:batch.id,recipeName:batch.recipeName,createdAt:Date.now()}])expect((await applyPacket(packet('coating-mix',payload,StageId.COATING))).ok).toBe(false);
 expect(await receiveSlurryHandover(snap,StageId.COATING,UserRole.MASTER,'master')).toEqual(snap);
});
it('preserves legacy history and imports historical measured snapshots without replacing current catalogs',async()=>{
 const legacy={id:'legacy',recipeName:'Historical record',batchKg:1,weighings:[],workerId:'old',createdAt:1,updatedAt:1};await db.mixBatches.add(legacy);
 await expect(receiveSlurryBatch({...legacy,updatedAt:2},StageId.SLURRY,UserRole.MASTER,'master')).rejects.toThrow();expect(await db.mixBatches.get(legacy.id)).toEqual(legacy);
 await expect(receiveSlurryBatch({...batch,componentSnapshots:[{...components[0],name:'Altered same-version source'},...components.slice(1)]},StageId.SLURRY,UserRole.MASTER,'master')).rejects.toThrow();
 await db.mixComponents.update('powder',{name:'Later catalog',updatedAt:2});await db.mixRecipes.update('recipe',{name:'Later recipe',updatedAt:2});
 expect(await receiveSlurryBatch(batch,StageId.SLURRY,UserRole.WORKER,'worker')).toEqual(batch);expect((await db.mixComponents.get('powder'))?.name).toBe('Later catalog');
});
it('rolls first handover import and its newly imported source journal back together on failure',async()=>{
 await saveSlurryBatch(batch,'worker');const snap=await prepareSlurryHandover(batch,'worker');
 await db.coatIncomingMixes.clear();await db.mixBatches.delete(batch.id);await db.journal.delete(batch.id);
 const fail=()=>{throw Error('Incoming handover write failed');};db.coatIncomingMixes.hook('creating',fail);
 try{await expect(receiveSlurryHandover(snap,StageId.COATING,UserRole.MASTER,'master')).rejects.toThrow('Incoming handover write failed');}finally{db.coatIncomingMixes.hook('creating').unsubscribe(fail);}
 expect(await db.mixBatches.get(batch.id)).toBeUndefined();expect(await db.journal.get(batch.id)).toBeUndefined();expect(await db.coatIncomingMixes.count()).toBe(0);
 expect(await receiveSlurryHandover(snap,StageId.COATING,UserRole.MASTER,'master')).toEqual(snap);expect(await db.mixBatches.get(batch.id)).toEqual(batch);
});
it('does not let typed or forced catalog packets replace a known version or grant workers catalog edits',async()=>{
 const packet=(type:'mix-component'|'mix-recipe'|'forced-push',payload:unknown,role=UserRole.MASTER)=>({v:1 as const,type,stage:StageId.SLURRY,payload,from:'master',role,forced:type==='forced-push',ts:Date.now()});
 for(const type of ['mix-component','forced-push'] as const)expect((await applyPacket(packet(type,{...components[0],name:'Changed same version'}))).ok).toBe(false);
 expect((await applyPacket(packet('mix-component',{...components[0],updatedAt:2},UserRole.WORKER))).ok).toBe(false);
 for(const type of ['mix-recipe','forced-push'] as const)expect((await applyPacket(packet(type,{...recipe,name:'Changed same version'}))).ok).toBe(false);
 expect(await db.mixComponents.get('powder')).toEqual(components[0]);expect(await db.mixRecipes.get(recipe.id)).toEqual(recipe);
});
