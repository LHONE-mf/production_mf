import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {ReceivingForm} from './ReceivingForm';
import {inventoryOutbox} from '../../core/sync/inventoryOutbox';
it('freezes a received package without network or confirmed stock changes and restores its ID',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await inventoryOutbox.open();
 const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
 const materialId='55555555-5555-4555-8555-555555555555',locationId='66666666-6666-4666-8666-666666666666';
 const props={scope,session:{serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofDeviceId:scope.deviceId,offlineEditExpiresAt:Date.now()+60000},localActorId:'warehouse',materials:[{id:materialId,name:'PVDF',code:'P',category:'raw_material' as const,baseUnit:'mg' as const}],locations:[{id:locationId,parentId:null,label:'Shelf A',kind:'cabinet' as const,active:true}],onQueued:vi.fn()};
 const node=document.createElement('div');document.body.append(node);let root=createRoot(node);
 const click=async(text:string)=>{await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent===text)!.click());};
 async function field(label:string,value:string){const input=node.querySelector<HTMLInputElement|HTMLSelectElement>('[aria-label="'+label+'"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});await vi.waitFor(()=>expect(node.textContent).toContain('Черновик сохранён'));}
 try{
  await act(async()=>root.render(<ReceivingForm {...props}/>));await vi.waitFor(()=>expect(node.querySelector('input')).toBeTruthy());
  await field('Материал приёмки',materialId);await field('Место приёмки',locationId);await field('Партия производителя','LOT-A');await field('Количество приёмки','2.125');await field('Единица приёмки','kg');await field('Основание приёмки / свидетельство','Physical receipt sheet');
  await click('Проверить приёмку');expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain('Карантин');
  await click('Сохранить приёмку в очередь');await vi.waitFor(()=>expect(props.onQueued).toHaveBeenCalledTimes(1));
  const queued=(await inventoryOutbox.operations.toArray())[0];expect(queued.request.quantity).toBe(2125000);expect(await inventoryOutbox.stocks.count()).toBe(0);expect(fetch).not.toHaveBeenCalled();
  await act(async()=>root.unmount());inventoryOutbox.close();await inventoryOutbox.open();root=createRoot(node);await act(async()=>root.render(<ReceivingForm {...props}/>));await vi.waitFor(()=>expect(node.textContent).toContain(queued.operationId));
  expect(await inventoryOutbox.operations.count()).toBe(1);
 }finally{await act(async()=>root.unmount());node.remove();inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();}
});
