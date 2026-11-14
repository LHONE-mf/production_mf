import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {loadIssueReconciliation,type ReconciliationPage} from '../../core/sync/inventoryReconciliation';
import {InventoryReconciliationPanel} from './InventoryReconciliationPanel';
vi.mock('../../core/sync/inventoryReconciliation',()=>({loadIssueReconciliation:vi.fn()}));
it('requires explicit read, hides obsolete filter/identity replies, and clears denied report downloads',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const node=document.createElement('div'),root=createRoot(node);
 const id='11000000-0000-4000-8000-000000000001';
 const scope={serverUrl:'https://inventory.example',organizationId:id,actorId:id,deviceId:id};
 const props={scope,session:{serverUrl:scope.serverUrl,accessToken:'A'.repeat(43)},epoch:id,materials:[]};
 const page:ReconciliationPage={epoch:id,throughIssueSequence:5,throughOutcomeSequence:2,items:[],hasMore:false,nextAfter:null};
 const click=async()=>{await act(async()=>node.querySelector('button')!.click());};
 try{
  await act(async()=>root.render(<InventoryReconciliationPanel {...props}/>));
  expect(loadIssueReconciliation).not.toHaveBeenCalled();expect(node.textContent).toContain('НЕ ЗАПИСАН');
  let finish!:(page:ReconciliationPage)=>void;
  vi.mocked(loadIssueReconciliation).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await click();
  const input=node.querySelector('input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,id);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>finish(page));
  expect(node.querySelector('[aria-label="Результат сверки выдач"]')).toBeNull();
  vi.mocked(loadIssueReconciliation).mockResolvedValue(page);await click();
  expect(node.textContent).toContain('Скачать CSV страницы сверки');
  expect(loadIssueReconciliation).toHaveBeenLastCalledWith(props.session,scope,id,{productionBatchId:id});
  vi.mocked(loadIssueReconciliation).mockRejectedValueOnce(Error('HTTP 403'));await click();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('403');
  expect(node.textContent).not.toContain('Скачать CSV страницы сверки');
  vi.mocked(loadIssueReconciliation).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await click();await act(async()=>root.render(<InventoryReconciliationPanel {...props} scope={{...scope,actorId:'22000000-0000-4000-8000-000000000002'}}/>));
  await act(async()=>finish(page));
  expect(node.querySelector('[aria-label="Результат сверки выдач"]')).toBeNull();
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();vi.clearAllMocks();}
});
