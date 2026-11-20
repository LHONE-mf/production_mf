import {expect,it} from 'vitest';
import type {ElectrodeOutputSource} from './inventoryOutputTypes';
import {copySortingAssemblyOfferRequest,type SortingAssemblyOfferRequest} from './sortingAssemblyHandoff';

const receipt='11111111-1111-4111-8111-111111111111';
const source:ElectrodeOutputSource={
  runId:'sorted-test-1',cutRunId:'received:'+receipt,cuttingReceiptId:receipt,
  specId:'spec-test-1',mode:'grading',inputCount:4,
  categories:[{name:'A',minMass:1,maxMass:2},{name:'B',minMass:2,maxMass:3}],
  stages:[
    {station:'visual',inputCount:4,passedCount:4,rejectedCount:0,workerId:'inspector',recordedAt:1},
    {station:'thickness',inputCount:4,passedCount:4,rejectedCount:0,workerId:'inspector',recordedAt:2},
    {station:'mass',inputCount:4,passedCount:3,rejectedCount:1,workerId:'inspector',recordedAt:3,
      grades:[{categoryName:'A',count:2},{categoryName:'B',count:1}]},
  ],
};
const intent:SortingAssemblyOfferRequest={
  operationId:'22222222-2222-4222-8222-222222222222',
  deviceId:'33333333-3333-4333-8333-333333333333',
  productionBatchId:'44444444-4444-4444-8444-444444444444',
  source,sourceStepNumber:5,destinationStepNumber:6,expectedSourceRevision:1,
  recipientId:'55555555-5555-4555-8555-555555555555',
  outputLotLabel:'TEST-PHYSICAL-GRADE-A',
  grade:'A',materialId:'66666666-6666-4666-8666-666666666666',quantity:2,
  reason:'Actual sorted electrodes',evidence:'Three-station record',
};

it('preserves a single actual grade, physical lot, receipt identity and exact piece quantity',()=>{
  expect(copySortingAssemblyOfferRequest(intent)).toEqual(intent);
  expect(copySortingAssemblyOfferRequest({...intent,quantity:1})).toMatchObject({
    grade:'A',quantity:1,outputLotLabel:'TEST-PHYSICAL-GRADE-A',
    source:{cuttingReceiptId:receipt},
  });
});

it('rejects invented grades and over-counting a real grade',()=>{
  for(const input of [{...intent,quantity:3},{...intent,grade:'C'},{...intent,quantity:0},
    {...intent,quantity:1.5}])
    expect(()=>copySortingAssemblyOfferRequest(input)).toThrow();
});

it('requires the original server-confirmed Cutting receipt, not a local-only result',()=>{
  const {cuttingReceiptId:_removed,...local}=source;
  expect(()=>copySortingAssemblyOfferRequest({...intent,source:{...local,cutRunId:'cut-local'}})).toThrow(/подтверждённая/);
  expect(()=>copySortingAssemblyOfferRequest({...intent,source:{...source,cuttingReceiptId:'77777777-7777-4777-8777-777777777777'}})).toThrow();
});

it('rejects invalid route, actor/device identity or source revision before reservation',()=>{
  for(const input of [
    {...intent,destinationStepNumber:5},
    {...intent,sourceStepNumber:0},
    {...intent,recipientId:'not-a-user'},
    {...intent,expectedSourceRevision:0},
    {...intent,outputLotLabel:' '},
    {...intent,evidence:''},
  ])expect(()=>copySortingAssemblyOfferRequest(input)).toThrow();
});

it('drops unrecognized client fields rather than treating them as permission or warehouse stock',()=>{
  const candidate={...intent,warehouseEffect:'stock-created',qualityStatus:'released'};
  const copied=copySortingAssemblyOfferRequest(candidate);
  expect(copied).toEqual(intent);
  expect('warehouseEffect' in copied).toBe(false);
  expect('qualityStatus' in copied).toBe(false);
});
