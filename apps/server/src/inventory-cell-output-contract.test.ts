import {expect,it} from 'vitest';
import {cellSubmission} from './inventory-cell-output-contract.js';
import {syntheticCellSubmission} from './inventory-cell-test-source.js';
it('accepts explicit noncontiguous processed serials and preserves full input/unknown/scrap and original observations',()=>{
 const body=syntheticCellSubmission();expect(cellSubmission.parse(body)).toEqual(body);
});
it('rejects guessed or nonconserving serials/counts, wrong units, unknown fields and unsafe integers',()=>{
 const body=syntheticCellSubmission(),s=body.source;
 for(const source of [{...s,ranges:[]},{...s,ranges:[{start:10,end:13}]},{...s,ranges:[{start:10,end:10},{start:10,end:10}]},{...s,ranges:[{start:12,end:12},{start:10,end:10}]},{...s,ranges:[{start:9,end:10}]},{...s,ranges:[{start:10.5,end:11.5}]},{...s,formation:{...s.formation,cellsUnknown:0}},{...s,formation:{...s.formation,cellsIn:Number.MAX_SAFE_INTEGER+1}},{...s,inputSerialRange:{...s.inputSerialRange,end:14}},{...s,formation:{...s.formation,measurementUnits:{...s.formation.measurementUnits,capacity:'mAh'}}},{...s,ranges:[{start:10,end:10,quality:'released'},{start:12,end:12}]}])expect(cellSubmission.safeParse({...body,source}).success).toBe(false);
 expect(cellSubmission.safeParse({...body,quantity:999}).success).toBe(false);
});
it('requires ended Formation observations, real calendar dates and valid manually attributed lineage',()=>{
 const body=syntheticCellSubmission(),s=body.source;
 for(const source of [{...s,formation:{...s.formation,endDate:undefined}},{...s,formation:{...s.formation,startDate:'2026-02-30'}},{...s,formation:{...s.formation,endDate:'2026-11-13'}},{...s,lineage:{...s.lineage,fillingBox:'floor7-room5'}},{...s,lineage:{...s.lineage,walzingRunId:'invented-extra'}},{...s,declaration:{...s.declaration,recordedBy:'unrelated-worker'}},{...s,declaration:{...s.declaration,recordedAt:'2026-11-15T09:59:00.000Z'}},{...s,formation:{...s.formation,mode:{cycles:4}}}])expect(cellSubmission.safeParse({...body,source}).success).toBe(false);
});
it('accepts explicit walzing lineage and supervisor attribution without inferred QA or serial expansion',()=>{
 const body=syntheticCellSubmission(),s=body.source;
 const source={...s,lineage:{...s.lineage,fillingBox:'floor7-room5',walzingRunId:'synthetic-walz',formationInputId:'synthetic-walz'},declaration:{...s.declaration,recordedBy:'synthetic-chief',recordedRole:'chief'}};
 expect(cellSubmission.safeParse({...body,source}).success).toBe(true);
});
