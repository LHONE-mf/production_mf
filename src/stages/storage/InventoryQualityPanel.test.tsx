import React,{act} from 'react';import {createRoot} from 'react-dom/client';import {expect,it,vi} from 'vitest';
import {InventoryQualityPanel} from './InventoryQualityPanel';
it('shows disposition controls only to proven Chief capabilities and never fetches quality history on mount',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const node=document.createElement('div'),root=createRoot(node);
 const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
 const stock={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'CI',quality:'quarantine' as const,unit:'mg' as const,onHand:1000,reserved:0,available:1000,revision:1};
 const props={scope,stock,session:{serverUrl:scope.serverUrl,accessToken:'A'.repeat(43)},localActorId:'local',onChanged:()=>{}};
 try{await act(async()=>root.render(<InventoryQualityPanel {...props} canDecide={false}/>));expect(node.textContent).toContain('Загрузить историю качества');expect(node.textContent).not.toContain('Проверить решение о качестве');expect(fetch).not.toHaveBeenCalled();await act(async()=>root.render(<InventoryQualityPanel {...props} canDecide/>));expect(node.textContent).toContain('Проверить решение о качестве');expect(node.textContent).toContain('Только Chief');expect(fetch).not.toHaveBeenCalled();}
 finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
