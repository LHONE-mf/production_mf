import {describe,expect,it} from 'vitest';
import {transitionInventory,type InventoryOperation,type InventoryStock} from './inventoryDomain.js';

const receipt: InventoryOperation = {
  operationId:'receipt-1',stockId:'container-1',kind:'receive',expectedRevision:0,
  quantity:2_000_000,actorId:'warehouse-operator',reason:'Goods received',
  materialId:'nmc-811',manufacturerLot:'MFG-2026-01',locationId:'cabinet-1/shelf-2',
  unit:'mg',quality:'quarantine',
};
const released: InventoryStock = {
  stockId:'container-1',materialId:'nmc-811',manufacturerLot:'MFG-2026-01',
  locationId:'cabinet-1/shelf-2',unit:'mg',quality:'released',
  onHand:2_000_000,reserved:0,revision:1,
};
const action = (kind: InventoryOperation['kind'], patch:Partial<InventoryOperation>={}) =>
  ({...receipt,kind,expectedRevision:1,quantity:500_000,...patch});

describe('authoritative inventory transition contract',()=>{
  it('creates only an explicit receipt identity, quarantined by default when declared',()=>{
    const result=transitionInventory(undefined,receipt);
    expect(result).toEqual({ok:true,stock:{...released,quality:'quarantine'},available:2_000_000});
    expect(transitionInventory(released,receipt)).toMatchObject({ok:false,code:'revision_conflict'});
    expect(transitionInventory(undefined,{...receipt,expectedRevision:2})).toMatchObject({ok:false,code:'revision_conflict'});
  });
  it('does not promote historical receipt notes to confirmed inventory',()=>{
    expect(transitionInventory(undefined,action('reserve',{productionBatchId:'batch-1'}))).toMatchObject({ok:false,code:'missing'});
    expect(transitionInventory(undefined,{...receipt,manufacturerLot:''})).toMatchObject({ok:false,code:'invalid'});
  });
  it('requires released quality, batch identity and available stock to reserve',()=>{
    expect(transitionInventory({...released,quality:'quarantine'},action('reserve',{productionBatchId:'batch-1'}))).toMatchObject({ok:false,code:'blocked'});
    expect(transitionInventory(released,action('reserve'))).toMatchObject({ok:false,code:'invalid'});
    expect(transitionInventory(released,action('reserve',{productionBatchId:'batch-1',quantity:2_000_001}))).toMatchObject({ok:false,code:'insufficient_stock'});
    expect(transitionInventory(released,action('reserve',{productionBatchId:'batch-1'}))).toEqual({
      ok:true,stock:{...released,reserved:500_000,revision:2},available:1_500_000,
    });
  });
  it('prevents stale competing operations on the same revision',()=>{
    const first=transitionInventory(released,action('reserve',{productionBatchId:'batch-1'}));
    expect(first.ok).toBe(true);
    if(!first.ok)return;
    expect(transitionInventory(first.stock,action('reserve',{productionBatchId:'batch-2'})))
      .toMatchObject({ok:false,code:'revision_conflict'});
  });
  it('rejects fractional, negative, NaN, infinite and unsafe quantities',()=>{
    for(const quantity of [0,-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
      expect(transitionInventory(undefined,{...receipt,quantity})).toMatchObject({ok:false,code:'invalid'});
    }
  });
  it('cannot release more reservation than exists',()=>{
    expect(transitionInventory(released,action('release_reservation',{productionBatchId:'batch-1'})))
      .toMatchObject({ok:false,code:'insufficient_stock'});
    expect(transitionInventory({...released,reserved:600_000},action('release_reservation',{productionBatchId:'batch-1'})))
      .toMatchObject({ok:true,available:1_900_000});
  });
  it('requires controlled server approval and never adjusts below reserved balance',()=>{
    expect(transitionInventory(released,action('adjust',{adjustment:'decrease'}))).toMatchObject({ok:false,code:'blocked'});
    expect(transitionInventory({...released,reserved:1_900_000},action('adjust',{adjustment:'decrease'}),{mayAdjust:true}))
      .toMatchObject({ok:false,code:'insufficient_stock'});
    expect(transitionInventory(released,action('adjust',{adjustment:'decrease'}),{mayAdjust:true}))
      .toMatchObject({ok:true,available:1_500_000});
  });
  it('rejects stock issues and returns until authoritative provenance is implemented',()=>{
    expect(transitionInventory(released,action('issue',{productionBatchId:'batch-1'})))
      .toMatchObject({ok:false,code:'invalid'});
    expect(transitionInventory(released,action('return',{productionBatchId:'batch-1'})))
      .toMatchObject({ok:false,code:'invalid'});
  });
  it('transfers only a whole unreserved container',()=>{
    expect(transitionInventory(released,action('transfer',{toLocationId:'cabinet-2'})))
      .toMatchObject({ok:false,code:'invalid'});
    expect(transitionInventory({...released,reserved:1},action('transfer',{toLocationId:'cabinet-2',quantity:2_000_000})))
      .toMatchObject({ok:false,code:'invalid'});
    expect(transitionInventory(released,action('transfer',{toLocationId:'cabinet-2',quantity:2_000_000})))
      .toMatchObject({ok:true,stock:{locationId:'cabinet-2',revision:2}});
  });
});
