import {describe,expect,it} from 'vitest';
import {validateInventorySplit} from './inventorySplitValidation.js';
import type {InventoryStock} from './inventoryDomain.js';

const stock:InventoryStock={
  stockId:'receipt-a',materialId:'powder',manufacturerLot:'LOT-7',
  unit:'mg',locationId:'cabinet-a',quality:'released',
  onHand:1000,reserved:0,revision:2,
};
describe('inventory split preconditions (pure, no writes)',()=>{
  it('conserves quantity for a strictly partial split',()=>{
    const result=validateInventorySplit(stock,250,'cabinet-b');
    expect(result).toEqual({ok:true,remaining:750,childQuantity:250});
    if(result.ok)expect(result.remaining+result.childQuantity).toBe(stock.onHand);
  });
  it('refuses zero, fractional, negative, unsafe and whole-stock splits',()=>{
    for(const n of [0,-1,0.5,1000,1001,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])
      expect(validateInventorySplit(stock,n,'cabinet-b').ok).toBe(false);
  });
  it('refuses reserved or held stock and invalid destination',()=>{
    expect(validateInventorySplit({...stock,reserved:100},200,'cabinet-b'))
      .toEqual({ok:false,reason:'reserved_stock'});
    expect(validateInventorySplit({...stock,quality:'quarantine'},200,'cabinet-b'))
      .toEqual({ok:false,reason:'unreleased_stock'});
    expect(validateInventorySplit(stock,200,'cabinet-a'))
      .toEqual({ok:false,reason:'same_location'});
    expect(validateInventorySplit(stock,200,'  ').ok).toBe(false);
  });
  it('rejects corrupted stock balances before planning a split',()=>{
    for(const invalid of [{onHand:-1},{reserved:-1},{reserved:1001},{onHand:1.5}])
      expect(validateInventorySplit({...stock,...invalid},1,'cabinet-b').ok).toBe(false);
  });
});
