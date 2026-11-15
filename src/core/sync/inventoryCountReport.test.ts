import {expect,it,vi} from 'vitest';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryCountEvents,type InventoryCountEvent,type CountHistoryPage} from './inventoryCounts';
import {collectCountHistory,inventoryCountHistoryCsv} from './inventoryCountReport';
vi.mock('./inventoryClient',()=>({inventoryRequest:vi.fn()}));
const id='11000000-0000-4000-8000-000000000001',other='22000000-0000-4000-8000-000000000002';
const event:InventoryCountEvent={operationId:other,countId:id,kind:'observe',stockId:id,observationId:null,
 quantity:0,expectedRevision:2,observedStock:{stockId:id,materialId:id,locationId:id,manufacturerLot:'=LOT',unit:'mg',quality:'released',onHand:100,reserved:0,available:100,revision:2},
 actorId:id,deviceId:id,reason:'=Count "sheet"',evidence:'@WITNESS',recordedAt:'2026-11-15T00:00:00.000Z',sequence:2};
const page=():CountHistoryPage=>({epoch:id,countId:id,throughSequence:2,closed:false,items:[event],nextAfter:null});
it('validates frozen count history bounds and sends the original upper sequence',async()=>{
 vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({...page(),hasMore:false})));
 const p=await loadInventoryCountEvents({} as never,{deviceId:id} as never,id,id,0,100,2);
 expect(p).toEqual(page());expect(vi.mocked(inventoryRequest).mock.calls[vi.mocked(inventoryRequest).mock.calls.length-1][2]).toContain('until=2');
 vi.mocked(inventoryRequest).mockResolvedValue(new Response(JSON.stringify({...page(),throughSequence:3,hasMore:false})));
 await expect(loadInventoryCountEvents({} as never,{deviceId:id} as never,id,id,0,100,2)).rejects.toThrow(/history/);
});
it('collects all events of the selected count snapshot without later closure or approval',async()=>{
 const calls:number[]=[];
 const p=await collectCountHistory(async after=>{
  calls.push(after);return after===0?{...page(),items:[{...event,sequence:1}],nextAfter:1}:page();
 },page());
 expect(calls).toEqual([0,1]);expect(p.items.map(r=>r.sequence)).toEqual([1,2]);expect(p.closed).toBe(false);
 for(const change of [{epoch:other},{countId:other},{throughSequence:3},{closed:true}])await expect(collectCountHistory(async()=>({...page(),...change}),page())).rejects.toThrow(/history/);
 await expect(collectCountHistory(async()=>({...page(),nextAfter:2}),page(),1)).rejects.toThrow(/limit/);
 await expect(collectCountHistory(async()=>({...page(),nextAfter:2}),page())).rejects.toThrow(/cursor/);
});
it('exports zero/unapproved observations with exact original stock, actor and safe signed difference',()=>{
 const csv=inventoryCountHistoryCsv(page());
 expect(csv).toContain(`"${id}","2","${id}","false"`);
 expect(csv).toContain('"observe"');expect(csv).toContain('"100","0","0","\'-100"');
 expect(csv).toContain('"\'=LOT"');expect(csv).toContain('"\'=Count ""sheet"""');expect(csv).toContain('"\'@WITNESS"');
 expect(csv).not.toMatch(/undefined|accessToken|proofToken|request_payload/);
});
