import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {db} from '../../core/db';
import {inventoryOutbox} from '../../core/sync/inventoryOutbox';
import {UserRole} from '../../core/types';
import {createFormationSerialIdentity,declareFormationSerialIdentity} from '../../core/manufacturing/formationSerialIdentity';
import {syntheticFormationLineage} from '../../../tests/fixtures/formation-lineage';
import {CellOutputPanel} from './FinishedCellOffers';
it('preserves form source, selected completion/material and operation ID through failed freeze/reopen, then saves offline without POST',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();await inventoryOutbox.open();
 const chief={id:'chief',login:'chief',fullName:'Chief',password:'test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()};await db.users.bulkAdd([chief,{...chief,id:'worker',login:'worker',role:UserRole.WORKER}]);
 const source=await syntheticFormationLineage('chief','worker'),identity=createFormationSerialIdentity(source,[{start:10,end:10},{start:12,end:12}],'Original channel sheet',chief,crypto.randomUUID(),new Date().toISOString());await declareFormationSerialIdentity(identity,'chief');
 const scope={serverUrl:'https://inventory.example',organizationId:crypto.randomUUID(),actorId:crypto.randomUUID(),deviceId:crypto.randomUUID()},epoch=crypto.randomUUID(),session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
 const step={completionId:crypto.randomUUID(),productionBatchId:crypto.randomUUID(),batchCode:'Actual batch',stepNumber:1,workshopId:'formation',name:'Final Formation',materialLine:'cell',quantity:2,unit:'pieces',completedAt:new Date().toISOString()},material={id:crypto.randomUUID(),code:'CELL',name:'Cell',category:'cell',baseUnit:'pieces'};let posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{if(init?.method)posts++;return new Response(JSON.stringify({organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,epoch,postingEnabled:true,items:url.pathname.endsWith('/steps')?[step]:url.pathname.endsWith('/materials')?[material]:[],hasMore:false,nextAfter:null}));}));
 const node=document.createElement('div');document.body.appendChild(node);let root=createRoot(node);
 const wait=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});check();});
 const click=async(text:string)=>act(async()=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent===text);expect(button,text).toBeDefined();button!.click();});
 const edit=async(label:string,value:string)=>act(async()=>{const el=node.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('[aria-label="'+label+'"]')!;expect(el,label).toBeTruthy();const prototype=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});
 async function mount(){await act(async()=>root.render(<CellOutputPanel {...{scope,session}} localActorId="chief" identities={[identity]}/>));await click('Загрузить завершённые шаги и предложения ячеек');await wait(()=>expect(node.querySelector('select')).toBeTruthy());await edit('Заявление номеров для предложения',identity.id);await wait(()=>expect(node.querySelector('form')).toBeTruthy());}
 try{
  await mount();await edit('Завершённый шаг ячеек',step.completionId);await click('Загрузить материалы ячеек');await wait(()=>expect(node.textContent).toContain('CELL'));await edit('Материал ячеек',material.id);await edit('Основание предложения ячеек','Actual output');await edit('Свидетельство выхода ячеек','Explicit channel sheet');
  await wait(()=>expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Explicit channel sheet'));
  let operation='';const fail=(_key:unknown,row:{request:{operationId:string}})=>{operation=row.request.operationId;throw Error('Cell claim storage unavailable');};db.cellOutputClaims.hook('creating',fail);
  try{await click('Сохранить исходное предложение ячеек');await wait(()=>expect(node.textContent).toContain('Cell claim storage unavailable'));expect(await db.cellOutputClaims.count()).toBe(0);}finally{db.cellOutputClaims.hook('creating').unsubscribe(fail);}
  await act(async()=>root.unmount());db.close();await db.open();root=createRoot(node);await mount();expect(node.textContent).toContain(operation);expect(node.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Explicit channel sheet');
  await click('Сохранить исходное предложение ячеек');await wait(()=>expect(node.textContent).toContain('Отправить исходное предложение ячеек'));
  const claim=await db.cellOutputClaims.get(source.id);expect(claim?.request).toMatchObject({operationId:operation,completionId:step.completionId,materialId:material.id});expect(claim?.identity).toEqual(identity);expect(posts).toBe(0);expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await db.formationRuns.get(source.id)).toEqual(source);
 }finally{await act(async()=>root.unmount());node.remove();db.close();await db.delete();inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();}
});
