import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {InventoryMovementsPanel} from './InventoryMovementsPanel';
import {InventoryReconciliationPanel} from './InventoryReconciliationPanel';
import {loadInventoryMovements,collectMovementSnapshot} from '../../core/sync/inventoryMovements';
import {loadIssueReconciliation,collectIssueReconciliation} from '../../core/sync/inventoryReconciliation';
vi.mock('../../core/sync/inventoryMovements',()=>({loadInventoryMovements:vi.fn(),collectMovementSnapshot:vi.fn()}));
vi.mock('../../core/sync/inventoryReconciliation',()=>({loadIssueReconciliation:vi.fn(),collectIssueReconciliation:vi.fn()}));
const id='11000000-0000-4000-8000-000000000001';
it.each([
 {Component:InventoryMovementsPanel,load:loadInventoryMovements,collect:collectMovementSnapshot,first:'Показать журнал',download:'Скачать весь срез до 10 000 строк',region:'Результат журнала движений',page:{epoch:id,throughSequence:0,items:[],hasMore:false,nextAfter:0}},
 {Component:InventoryReconciliationPanel,load:loadIssueReconciliation,collect:collectIssueReconciliation,first:'Показать сверку выдач',download:'Скачать весь срез сверки',region:'Результат сверки выдач',page:{epoch:id,throughIssueSequence:0,throughOutcomeSequence:0,items:[],hasMore:false,nextAfter:null}},
])('keeps failed full export feedback beside controls in $region',async({Component,load,collect,first,download,region,page})=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const node=document.createElement('div'),root=createRoot(node);
 vi.mocked(load).mockResolvedValue(page as never);vi.mocked(collect).mockRejectedValue(Error('export limit exceeded'));
 try{
  await act(async()=>root.render(<Component scope={{serverUrl:'https://inventory.example',organizationId:id,actorId:id,deviceId:id}} session={{serverUrl:'https://inventory.example',accessToken:'A'.repeat(43)}} epoch={id} materials={[]}/>));
  const click=async(text:string)=>{await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent===text)!.click());};
  await click(first);await click(download);
  expect(node.querySelector('[aria-label="'+region+'"] [role="alert"]')?.textContent).toContain('export limit exceeded');
  expect(node.querySelectorAll('[role="alert"]')).toHaveLength(1);
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();vi.clearAllMocks();}
});
