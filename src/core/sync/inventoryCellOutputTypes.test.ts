import {beforeEach,afterEach,expect,it} from 'vitest';
import {db} from '../db';
import {UserRole,type FormationRun} from '../types';
import {createFormationSerialIdentity,type FormationSerialIdentity} from '../manufacturing/formationSerialIdentity';
import {syntheticFormationLineage} from '../../../tests/fixtures/formation-lineage';
import {cellSourceFromIdentity} from './inventoryCellOutputTypes';
let source:FormationRun,identity:FormationSerialIdentity;
beforeEach(async()=>{await db.open();await db.users.bulkAdd([{id:'chief',login:'chief',fullName:'Chief',password:'SYNTHETIC-test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'SYNTHETIC-test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);source=await syntheticFormationLineage('chief','worker');identity=createFormationSerialIdentity(source,[{start:10,end:10},{start:12,end:12}],'Actual explicit channel sheet',(await db.users.get('chief'))!,crypto.randomUUID(),new Date().toISOString());});
afterEach(async()=>{db.close();await db.delete();});
it('projects actual immutable identity, full input, measurements and authentic source links without inferring QC or serials',()=>{
 const result=cellSourceFromIdentity(identity),fill=source.inputSnapshot!.sourceFill!;
 expect(result).toMatchObject({version:1,identityId:identity.id,formationRunId:source.id,cellType:'cylindrical',inputSerialRange:source.serialRange,ranges:identity.ranges,lineage:{assemblyRunId:fill.sourceReceipt!.sourceAssembly!.id,assemblyOutputId:identity.assemblyOutputId,fillingRunId:fill.id,fillingReceiptId:fill.sourceReceipt!.receipt!.id,formationInputId:source.inputSnapshot!.id},formation:{cellsIn:4,cellsOut:2,cellsScrap:1,cellsUnknown:1,mode:source.mode,measurementUnits:source.measurementUnits,measurementBasis:source.measurementBasis},declaration:{recordedBy:'chief',recordedRole:'chief',evidence:identity.evidence}});
 expect(result.lineage.walzingRunId).toBeUndefined();expect(result.formation.capacityCycle5Ah).toBeUndefined();expect(result.inputSerialRange.end-result.inputSerialRange.start+1).toBe(4);expect(identity.source).toEqual(source);
});
it('does not submit unended, unlinked, changed-count or guessed processed output',()=>{
 for(const bad of [{...identity,source:{...source,endDate:undefined}},{...identity,source:{...source,inputSnapshot:undefined,sourceLedger:undefined}},{...identity,count:4},{...identity,ranges:[{start:10,end:13}]}])expect(()=>cellSourceFromIdentity(bad)).toThrow();
});
it('allowlists source data and clones explicit ranges instead of publishing unknown local fields or mutating the original',()=>{
 const withUnknown={...identity,source:{...source,accessToken:'never-upload-local-metadata',mode:{...source.mode,accessToken:'never-upload-nested-mode'},measurementUnits:{...source.measurementUnits!,accessToken:'never-upload-nested-units'}}};const result=cellSourceFromIdentity(withUnknown as FormationSerialIdentity);
 expect(JSON.stringify(result)).not.toContain('never-upload-');result.ranges[0].start=11;expect(identity.ranges[0].start).toBe(10);expect(source.serialRange!.start).toBe(10);
});
