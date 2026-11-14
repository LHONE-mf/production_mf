import {describe,expect,it} from 'vitest';
import {inventoryMovementsCsv,type MovementPage} from './inventoryMovements';
const id='11000000-0000-4000-8000-000000000001';
describe('inventory movement CSV',()=>{
 it('escapes leading spreadsheet formulas and multiline source descriptions',()=>{
  const p:MovementPage={epoch:id,throughSequence:3,hasMore:false,nextAfter:3,items:[{
   sequence:3,operationId:id,stockId:id,kind:'receive',quantity:100,recordedAt:'2026-11-14T00:00:00.000Z',
   actorId:id,deviceId:id,reason:'=RUN(1)\nquoted "note"',productionBatchId:null,
   materialId:id,materialCode:'-INPUT',materialName:' @SUM(1,2)',manufacturerLot:'"LOT,7"',
   locationId:id,unit:'mg',
  }]};
  const csv=inventoryMovementsCsv(p);
  expect(csv).toContain('"\'-INPUT"');
  expect(csv).toContain('"\' @SUM(1,2)"');
  expect(csv).toContain('"\'=RUN(1)\nquoted ""note"""');
  expect(csv).toContain('"""LOT,7"""');
  expect(csv).toContain('"100","mg"');
  expect(csv).not.toContain('undefined');
 });
 it('has safe headers for zero results',()=>{
  const csv=inventoryMovementsCsv({epoch:id,throughSequence:0,hasMore:false,nextAfter:0,items:[]});
  expect(csv).toContain('Sequence');expect(csv).toContain('Operation ID');
 });
});
