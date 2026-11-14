import {describe,it,expect} from 'vitest';
import {inventoryAlertsCsv,type InventoryAlertsPage} from './inventoryAlerts';
const id='11000000-0000-4000-8000-000000000001';
describe('inventory alert CSV safety',()=>{
 it('escapes formula injection, quotes and newlines without inventing stock rows',()=>{
  const report:InventoryAlertsPage={epoch:id,asOf:'2026-11-14T00:00:00.000Z',
   expiryDays:30,lowAvailable:0,materialId:null,hasMore:false,nextAfter:null,
   items:[{stock:{stockId:id,materialId:id,locationId:id,manufacturerLot:'=cmd|\n""',
     unit:'mg',onHand:3,reserved:1,available:2,quality:'released',revision:1},
     materialCode:'@HYPERLINK',materialName:' +SUM(1,2)',locationLabel:'"A",\r\nB',eligible:true,alerts:['low']}]};
  const csv=inventoryAlertsCsv(report);
  expect(csv).toContain('"\'@HYPERLINK"');
  expect(csv).toContain('"\' +SUM(1,2)"');
  expect(csv).toContain('"\'=cmd|\n""""""');
  expect(csv).toContain('"""A"",\r\nB"');
  expect(csv).toContain('"2","3","1","mg"');
  expect(csv.match(/@HYPERLINK/g)).toHaveLength(1);
 });
 it('renders headers with zero rows',()=>{
  const csv=inventoryAlertsCsv({epoch:id,asOf:'2026-11-14T00:00:00.000Z',
   expiryDays:30,lowAvailable:0,materialId:null,hasMore:false,nextAfter:null,items:[]});
  expect(csv).toContain('Material code');expect(csv).not.toContain('undefined');
 });
});
