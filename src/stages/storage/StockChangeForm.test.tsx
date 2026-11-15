import React,{act} from 'react';import{createRoot}from'react-dom/client';import{expect,it,vi}from'vitest';
import{StockChangeForm}from'./StockChangeForm';import{inventoryOutbox,inventoryScopeKey}from'../../core/sync/inventoryOutbox';
it.each([false,true])('queues a frozen stock proposal without changing confirmed stock (manager=%s)',async(canCorrect)=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await inventoryOutbox.open();
 const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
 const stock={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'A',unit:'mg' as const,quality:'quarantine' as const,onHand:2125000,reserved:0,available:2125000,revision:1};
 const destination='77777777-7777-4777-8777-777777777777';
 await inventoryOutbox.stocks.put({...stock,scopeKey:inventoryScopeKey(scope)});
 const props={scope,stock,localActorId:'warehouse',canCorrect,session:{serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofDeviceId:scope.deviceId,offlineEditExpiresAt:Date.now()+60000},locations:[{id:destination,parentId:null,label:'Shelf B',kind:'cabinet' as const,active:true}],onQueued:vi.fn()};
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 async function field(label:string,value:string){const input=node.querySelector<HTMLInputElement|HTMLSelectElement>('[aria-label="'+label+'"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 const click=async(text:string)=>{await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent===text)!.click());};
 try{await act(async()=>root.render(<StockChangeForm {...props}/>));await vi.waitFor(()=>expect(node.querySelector('form')).toBeTruthy());
 if(!canCorrect)expect(node.textContent).not.toContain('Величина коррекции');else{await field('Действие склада','adjust');await field('Величина коррекции','500');}
 await field('Место назначения',destination);await field('Основание изменения','Physical move signed');
 await vi.waitFor(async()=>expect((await inventoryOutbox.receivingDrafts.toArray())[0].fields.reason).toBe('Physical move signed'));
 await click('Проверить изменение');expect(node.querySelector('[role="alertdialog"]')?.textContent).toContain(canCorrect?'500 mg':'2125000 mg');await click('Сохранить изменение в очередь');await vi.waitFor(()=>expect(props.onQueued).toHaveBeenCalledTimes(1));
 const op=(await inventoryOutbox.stockOperations.toArray())[0];expect(op.request).toMatchObject(canCorrect?{kind:'adjust',quantity:500,expectedRevision:1,adjustment:'decrease'}:{kind:'transfer',quantity:2125000,expectedRevision:1,toLocationId:destination});expect((await inventoryOutbox.stocks.toArray())[0].locationId).toBe(stock.locationId);expect(fetch).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());node.remove();inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();}
});
