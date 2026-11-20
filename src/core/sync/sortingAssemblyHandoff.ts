import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger} from './inventoryOutcomeTypes';
import {finishedBuckets,outputSourceCopy,type ElectrodeOutputSource} from './inventoryOutputTypes';

/**
 * One actual grade and one physical piece lot per offer. This is a validated
 * intent, not proof of server reservation, recipient receipt or QA release.
 */
export interface SortingAssemblyOfferRequest {
  operationId:string;
  deviceId:string;
  productionBatchId:string;
  source:ElectrodeOutputSource;
  sourceStepNumber:number;
  destinationStepNumber:number;
  expectedSourceRevision:number;
  recipientId:string;
  outputLotLabel:string;
  grade:string;
  materialId:string;
  quantity:number;
  reason:string;
  evidence:string;
}

/** The server must independently validate live source, route, quality, actor and capacity. */
export function copySortingAssemblyOfferRequest(raw:SortingAssemblyOfferRequest):SortingAssemblyOfferRequest {
  if(!raw || typeof raw!=='object' ||
     ![raw.operationId,raw.deviceId,raw.productionBatchId,raw.recipientId,raw.materialId].every(issueIdValid) ||
     !issueTextValid(raw.outputLotLabel) || raw.outputLotLabel.length>200 ||
     !issueTextValid(raw.reason) || !issueTextValid(raw.evidence) ||
     !outcomeInteger(raw.sourceStepNumber,1) ||
     !outcomeInteger(raw.destinationStepNumber,raw.sourceStepNumber+1) ||
     !outcomeInteger(raw.expectedSourceRevision,1) ||
     !outcomeInteger(raw.quantity,1))
    throw Error('Некорректная заявка Sorting → Assembly');
  const source=outputSourceCopy(raw.source);
  // Only a measured, confirmed Cutting receipt is eligible for the authoritative flow.
  if(!source.cuttingReceiptId)throw Error('Для передачи нужна подтверждённая приёмка из Cutting');
  const grade=finishedBuckets(source).find(b=>b.categoryName===raw.grade);
  if(!grade || raw.quantity>grade.count)
    throw Error('Сорт или количество не соответствует фактическому выходу сортировки');
  return {
    operationId:raw.operationId,deviceId:raw.deviceId,
    productionBatchId:raw.productionBatchId,source,
    sourceStepNumber:raw.sourceStepNumber,
    destinationStepNumber:raw.destinationStepNumber,
    expectedSourceRevision:raw.expectedSourceRevision,
    recipientId:raw.recipientId,
    outputLotLabel:raw.outputLotLabel,
    grade:raw.grade,materialId:raw.materialId,quantity:raw.quantity,
    reason:raw.reason,evidence:raw.evidence,
  };
}
