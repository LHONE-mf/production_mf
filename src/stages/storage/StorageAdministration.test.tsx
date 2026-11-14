import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {StorageAdministration} from './StorageAdministration';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43)};
it('shows catalogue creation to an explicit manager but keeps employee grants Chief-only and makes no automatic requests',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const node=document.createElement('div'),root=createRoot(node);
 const props={scope,session,localActorId:'local',materials:[],locations:[],onChanged:()=>{}};
 try{
  await act(async()=>root.render(<StorageAdministration {...props} access={{level:'manager',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true}}/>));
  expect(node.textContent).toContain('Новый материал');expect(node.textContent).toContain('Новое место');
  expect(node.textContent).not.toContain('Загрузить сотрудников');expect(fetch).not.toHaveBeenCalled();
  await act(async()=>root.render(<StorageAdministration {...props} access={{level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true}}/>));
  expect(node.textContent).toContain('Загрузить сотрудников');expect(fetch).not.toHaveBeenCalled();
  await act(async()=>root.render(<StorageAdministration {...props} access={{level:'operator',canRecordReceipts:true,canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false}}/>));
  expect(node.textContent).toBe('');
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
