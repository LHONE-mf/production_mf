import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {ConfirmedStorage} from './ConfirmedStorage';
it('shows a truthful disconnected state without network requests or invented stock',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const node=document.createElement('div'),root=createRoot(node);
 try {await act(async()=>root.render(<ConfirmedStorage/>));
 expect(node.textContent).toContain('Сервер не подключён');
 expect(node.textContent).not.toContain('Остатков нет');
 expect(fetch).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
it('requires a fresh device proof and never fetches on mount',async()=>{
 const {setServerConnection,clearServerConnection}=await import('../../core/sync/serverConnection');
 setServerConnection({serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',serverActorId:'22222222-2222-4222-8222-222222222222',selectedDeviceId:'33333333-3333-4333-8333-333333333333',serverRole:'chief',enrolledDeviceId:'',myDevices:[],session:{serverUrl:'https://inventory.example',accessToken:'A'.repeat(43),deviceProofExpiresAt:0}});
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const node=document.createElement('div'),root=createRoot(node);
 try{await act(async()=>root.render(<ConfirmedStorage/>));expect(node.textContent).toContain('Требуется проверка устройства');expect(fetch).not.toHaveBeenCalled();}
 finally{await act(async()=>root.unmount());clearServerConnection();vi.unstubAllGlobals();}
});
it('loads real client reads only on explicit refresh and hides the view on logout',async()=>{
 const {setServerConnection,clearServerConnection}=await import('../../core/sync/serverConnection');
 const {inventoryOutbox}=await import('../../core/sync/inventoryOutbox');
 const actor='22222222-2222-4222-8222-222222222222',device='33333333-3333-4333-8333-333333333333';
 setServerConnection({serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',serverActorId:actor,selectedDeviceId:device,serverRole:'chief',enrolledDeviceId:device,myDevices:[device],session:{serverUrl:'https://inventory.example',accessToken:'A'.repeat(43),deviceProofDeviceId:device,deviceProofToken:'B'.repeat(43),deviceProofExpiresAt:Date.now()+300000}});
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const fetch=vi.fn(async(url:URL,_init?:RequestInit)=>({ok:true,json:async()=>url.pathname.endsWith('/me')?{level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true}:url.pathname.endsWith('/materials')?{materials:[],hasMore:false,nextAfter:null}:url.pathname.endsWith('/locations')?{locations:[],hasMore:false,nextAfter:null}:{changes:[],nextCursor:0,hasMore:false}}));vi.stubGlobal('fetch',fetch);
 const node=document.createElement('div'),root=createRoot(node);
 try{
  await act(async()=>root.render(<ConfirmedStorage/>));expect(fetch).not.toHaveBeenCalled();
  await act(async()=>node.querySelector('button')!.click());
  await vi.waitFor(()=>expect(node.textContent).toContain('Подтверждённых остатков пока нет.'));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(call=>!('method' in (call[1]??{})))).toBe(true);
  await act(async()=>clearServerConnection());expect(node.textContent).toContain('Сервер не подключён');expect(node.textContent).not.toContain('Последняя успешная');
 }finally{await act(async()=>root.unmount());clearServerConnection();inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();}
});
