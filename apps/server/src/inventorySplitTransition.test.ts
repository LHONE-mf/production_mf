import {describe,expect,it} from 'vitest';
import type {InventoryStock} from './inventoryDomain.js';
import {planInventorySplit} from './inventorySplitTransition.js';

const parent:InventoryStock={
  stockId:'parent',materialId:'powder',manufacturerLot:'LOT-7',
  unit:'mg',locationId:'shelf-a',quality:'released',
  onHand:1000,reserved:0,revision:2,
};
describe('split projection (no writes)',()=>{
  it('conserves stock and preserves provenance across distinct IDs',()=>{
    const result=planInventorySplit(parent,'child',250,'shelf-b',false);
    expect(result.ok).toBe(true);
    if(!result.ok)return;
    expect(result.parent.onHand+result.child.onHand).toBe(parent.onHand);
    expect(result.parent).toMatchObject({stockId:'parent',locationId:'shelf-a',onHand:750,revision:3});
    expect(result.child).toMatchObject({stockId:'child',locationId:'shelf-b',onHand:250,
      revision:1,reserved:0,manufacturerLot:'LOT-7',materialId:'powder',quality:'released'});
    expect(parent.onHand).toBe(1000);
  });
  it('requires explicit quarantine acknowledgement without releasing quality',()=>{
    const held={...parent,quality:'quarantine' as const};
    expect(planInventorySplit(held,'child',100,'shelf-b',false))
      .toEqual({ok:false,reason:'quarantine_approval_required'});
    const result=planInventorySplit(held,'child',100,'shelf-b',true);
    expect(result.ok).toBe(true);
    if(result.ok){
      expect(result.parent.quality).toBe('quarantine');
      expect(result.child.quality).toBe('quarantine');
    }
  });
  it('rejects blocked stock and reservations',()=>{
    expect(planInventorySplit({...parent,quality:'blocked'},'child',100,'shelf-b',true).ok).toBe(false);
    expect(planInventorySplit({...parent,reserved:1},'child',100,'shelf-b',true))
      .toEqual({ok:false,reason:'reserved_stock'});
  });
  it('rejects invalid quantities, identities, destinations and revision overflow',()=>{
    for(const quantity of [0,-1,1.5,1000,1001,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
      expect(planInventorySplit(parent,'child',quantity,'shelf-b',true).ok).toBe(false);
    expect(planInventorySplit(parent,'parent',100,'shelf-b',true).ok).toBe(false);
    expect(planInventorySplit(parent,'child',100,'shelf-a',true).ok).toBe(false);
    expect(planInventorySplit(parent,'child',100,'',true).ok).toBe(false);
    expect(planInventorySplit({...parent,revision:2147483647},'child',100,'shelf-b',true))
      .toEqual({ok:false,reason:'revision_overflow'});
  });
});
