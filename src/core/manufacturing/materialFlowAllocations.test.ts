import {describe,expect,it} from 'vitest';
import {StageId} from '../types';
import {checkMaterialAllocations,type FlowSource,type FlowAllocation} from './materialFlowAllocations';

const scope={organizationId:'synthetic-tenant',workshopId:'workshop',room:StageId.ASSEMBLY};
const source=(id='receipt-a',quantity=10):FlowSource=>({
  scope,reference:{kind:'received-issue',id,revision:1,operationId:`operation-${id}`},
  material:{catalogueId:'explicit-material',specification:{id:'spec',revision:2},variantId:null,
    lotId:'lot-a',kind:'sorted-electrodes',polarity:'cathode',cellFormat:'pouch'},
  custody:{locationId:'assembly-buffer'},availability:'available',quality:'unknown',
  remaining:{quantity,unit:'pieces'},
});
const allocation=(s:FlowSource,id:string,quantity:number):FlowAllocation=>({
  id,source:s.reference,quantity,unit:s.remaining.unit,destinationOperationId:'output-operation',
});

describe('nonposting material allocations',()=>{
  it('conserves multiple partial parent lots over multiple operations without mutating sources',()=>{
    const a=source(),b={...source('receipt-b',7),material:{...source().material,lotId:'lot-b'}};
    const parents=[a,b],original=structuredClone(parents);
    const allocations=[allocation(a,'a-1',4),{...allocation(a,'a-2',3),destinationOperationId:'other-output'},allocation(b,'b-1',2)];
    expect(checkMaterialAllocations(scope,parents,allocations).map(r=>r.remaining.quantity)).toEqual([3,5]);
    expect(parents).toEqual(original);
    // Pure projection, not a reservation or a second warehouse debit.
    expect(checkMaterialAllocations(scope,parents,allocations).map(r=>r.remaining.quantity)).toEqual([3,5]);
  });

  it('does not combine packages merely because their material and lot match',()=>{
    const a=source(),b=source('other-receipt');
    expect(checkMaterialAllocations(scope,[a,b],[allocation(a,'a',10)]).map(r=>r.remaining.quantity)).toEqual([0,10]);
  });

  it('rejects over-allocation, invalid quantities, overflow and cross-dimension arithmetic',()=>{
    const a=source();
    for(const quantity of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,11])
      expect(()=>checkMaterialAllocations(scope,[a],[allocation(a,'a',quantity)])).toThrow();
    expect(()=>checkMaterialAllocations(scope,[a],[allocation(a,'a',6),allocation(a,'b',5)])).toThrow();
    expect(()=>checkMaterialAllocations(scope,[a],[{...allocation(a,'a',1),unit:'mg'}])).toThrow();
    const large=source('large',Number.MAX_SAFE_INTEGER);
    expect(()=>checkMaterialAllocations(scope,[large],[allocation(large,'a',Number.MAX_SAFE_INTEGER),allocation(large,'b',1)])).toThrow();
  });

  it('retains exact selected serials and refuses count-based subset inference or double spending',()=>{
    const a={...source('serials',3),serials:['cell-10','cell-12','cell-19']};
    const take={...allocation(a,'a',2),serials:['cell-19','cell-10']};
    expect(checkMaterialAllocations(scope,[a],[take])[0].serials).toEqual(['cell-12']);
    for(const serials of [undefined,['cell-10'],['cell-10','cell-10'],['cell-10','cell-11']])
      expect(()=>checkMaterialAllocations(scope,[a],[{...take,serials}])).toThrow();
    expect(()=>checkMaterialAllocations(scope,[a],[{...allocation(a,'a',1),serials:['cell-10']},{...allocation(a,'b',1),serials:['cell-10']}])).toThrow();
    expect(()=>checkMaterialAllocations(scope,[source()],[{...allocation(source(),'a',1),serials:['cell-10']}])).toThrow();
  });

  it('rejects duplicate identities, stale snapshots, scope changes and unspendable sources',()=>{
    const a=source(),take=allocation(a,'a',1);
    expect(()=>checkMaterialAllocations(scope,[a,a],[take])).toThrow();
    expect(()=>checkMaterialAllocations(scope,[a],[take,take])).toThrow();
    for(const sourceRef of [{...a.reference,revision:2},{...a.reference,operationId:'other'},{...a.reference,id:'absent'}])
      expect(()=>checkMaterialAllocations(scope,[a],[{...take,source:sourceRef}])).toThrow();
    for(const changed of [{...scope,organizationId:'other'},{...scope,workshopId:'other'},{...scope,room:StageId.SORTING}])
      expect(()=>checkMaterialAllocations(scope,[{...a,scope:changed}],[take])).toThrow();
    for(const quality of ['hold','blocked','rejected'] as const)
      expect(()=>checkMaterialAllocations(scope,[{...a,quality}],[take])).toThrow();
    for(const availability of ['held','unknown'] as const)
      expect(()=>checkMaterialAllocations(scope,[{...a,availability}],[take])).toThrow();
  });

  it('keeps missing polarity/QA unknown and validates serial evidence and explicit catalogue/spec identity',()=>{
    const a=source();
    const unknown={...a,material:{...a.material,polarity:'unknown' as const}};
    const kept=checkMaterialAllocations(scope,[unknown],[])[0];
    expect(kept.quality).toBe('unknown');
    expect(kept.material.polarity).toBe('unknown');
    for(const invalid of [
      {...a,material:{...a.material,catalogueId:''}},
      {...a,material:{...a.material,kind:'invented' as 'slurry'}},
      {...a,material:{...a.material,specification:{id:'spec',revision:0}}},
      {...a,serials:['cell-1']},
      {...a,serials:Array(10).fill('cell-1')},
      {...a,remaining:{quantity:NaN,unit:'pieces' as const}},
      {...a,remaining:{quantity:10,unit:'rolls' as 'pieces'}},
    ])expect(()=>checkMaterialAllocations(scope,[invalid],[])).toThrow();
    const b={...source('other',10),serials:Array.from({length:10},(_,i)=>`cell-${i}`)};
    expect(()=>checkMaterialAllocations(scope,[{...a,serials:b.serials},b],[])).toThrow();
  });
});
