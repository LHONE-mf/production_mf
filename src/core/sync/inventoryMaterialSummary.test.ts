import {describe,expect,it} from 'vitest';
import {materialBalancesCsv,type MaterialBalancePage} from './inventoryMaterialSummary';
const id='11000000-0000-4000-8000-000000000001';
describe('material balance export safety',()=>{
 it('keeps exact huge decimal totals and protects spreadsheet text',()=>{
  const page:MaterialBalancePage={epoch:id,asOf:'2026-11-14T00:00:00.000Z',expiryDays:30,
   hasMore:false,nextAfter:null,items:[{
    materialId:id,code:'=CODE()',name:'@FORMULA',unit:'mg',category:'raw_material',active:true,
    onHand:'9007199254740993000',reserved:'2',physicallyUnreserved:'9007199254740992998',
    eligibleAvailable:'9007199254740992998',quarantined:'0',blocked:'0',expired:'0',
    packageCount:'2',manufacturerLots:'1',expiringPackages:'0',
   }]};
  const csv=materialBalancesCsv(page);
  expect(csv).toContain('"\'=CODE()"');expect(csv).toContain('"\'@FORMULA"');
  expect(csv).toContain('9007199254740993000');expect(csv).not.toContain('undefined');
 });
});
