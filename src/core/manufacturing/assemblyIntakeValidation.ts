import type {AssemblyRun} from '../types';
import {validateSortPartition} from './sortingAllocation';

export function validateAssemblyIntake(run:AssemblyRun):void {
 if(!run?.intake||!run.sourceSort)throw new Error('Источник приёмки не указан');
 validateSortPartition(run.sourceSort);
 const count=run.sourceSort.buckets.reduce((n,b)=>n+b.count,0);
 if(typeof run.id!=='string'||!run.id||typeof run.intake.recordedAt!=='string'||typeof run.intake.recordedBy!=='string'||!run.intake.recordedBy.trim()||run.workerId!==run.intake.recordedBy||run.createdAt!==run.intake.recordedAt||run.updatedAt!==run.createdAt||!Number.isFinite(new Date(run.intake.recordedAt).getTime())||
  !Array.isArray(run.defects)||run.defects.length>0||run.electrodesPerCell!==undefined||run.coatingType!==run.sourceSort.specSnapshot?.coatingType||run.cellType!=='unassigned'||run.electrodeType!==run.sourceSort.specSnapshot?.electrodeType||run.intake.sortRunId!==run.sourceSort.id||!run.sourceSort.cutRunId||!run.sourceSort.specSnapshot||
  !Number.isSafeInteger(count)||count<=0||run.intake.electrodeCount!==count||run.batchName!==run.sourceSort.batchName||
  !Array.isArray(run.ops)||run.ops.length||run.cellsOut!==0||run.cellsScrap!==0||run.serialRange)
  throw new Error('Приёмка должна сохранять источник и электроды без выдуманного выхода ячеек или станционных операций');
}
