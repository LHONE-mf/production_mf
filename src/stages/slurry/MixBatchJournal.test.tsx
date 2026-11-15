import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {db} from '../../core/db';
import {UserRole,type User,type MixComponent,type MixBatch} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {calculateSlurryPlan,slurryMassBalance,SLURRY_BASIS} from '../../core/manufacturing/slurryMath';
import {saveSlurryBatch,SLURRY_UNITS} from '../../core/manufacturing/slurryBatch';
import {MixBatchJournal} from './MixBatchJournal';
vi.mock('../_ui/PacketOutModal',()=>({PacketOutModal:()=> <p>Saved journal packet</p>}));
it('shows frozen source names and actual totals, exports without edits and durably prepares coating data',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();
 const worker:User={id:'worker',login:'worker',fullName:'Worker',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()};await db.users.add(worker);useAuthStore.setState({currentUser:worker});
 const components:MixComponent[]=[{id:'powder',name:'Original powder',kind:'active',solidsMassFraction:1,updatedAt:1},{id:'liquid',name:'Liquid',kind:'solvent',solidsMassFraction:0,updatedAt:1}];await db.mixComponents.bulkAdd(components);
 const lines=[{componentId:'powder',pct:100},{componentId:'liquid',pct:100}];const plan=calculateSlurryPlan(lines,components,1,SLURRY_BASIS);const weighings=plan.rows.map((row,i)=>({componentId:row.componentId,plannedG:row.grams,actualG:i===0?1000:900}));
 const now=Date.now();const batch:MixBatch={id:'batch',measurementVersion:1,batchCode:'SL-001',recipeName:'Manual composition',componentSnapshots:components,recipePlan:{basis:SLURRY_BASIS,lines},batchKg:1,weighings,massBalance:slurryMassBalance(weighings,components),measurementUnits:SLURRY_UNITS,measurementNote:'Entered measured grams, declared composition',workerId:'worker',recordedRole:UserRole.WORKER,createdAt:now,updatedAt:now};await saveSlurryBatch(batch,'worker');await db.mixComponents.update('powder',{name:'Changed catalog name',densityTrue:5,updatedAt:2});
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});const click=async(text:string)=>act(async()=>{[...node.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!.click();});
 try{
  await act(async()=>root.render(<MixBatchJournal/>));await wait(()=>expect(node.textContent).toContain('SL-001'));await click('SL-001');expect(node.textContent).toContain('Original powder');expect(node.textContent).not.toContain('Changed catalog name');
  await click('Передать сохранённый замес');await wait(()=>expect(node.textContent).toContain('Saved journal packet'));expect(await db.mixBatches.get(batch.id)).toEqual(batch);
  await click('Подготовить передачу на намазку');await wait(()=>expect(node.textContent).toContain('Saved journal packet'));await vi.waitFor(async()=>expect(await db.coatIncomingMixes.count()).toBe(1));
  const snap=await db.coatIncomingMixes.get(batch.id);expect(snap?.pasteDensity).toBeUndefined();expect(snap?.sourceBatch).toEqual(batch);expect(await db.mixBatches.get(batch.id)).toEqual(batch);
 }finally{await act(async()=>root.unmount());node.remove();useAuthStore.setState({currentUser:null});db.close();await db.delete();vi.unstubAllGlobals();}
});
