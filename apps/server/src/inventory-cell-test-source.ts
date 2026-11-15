/** SYNTHETIC source evidence for disposable engineering tests only. */
import type {CellOutputSource} from './inventory-cell-output-contract.js';
export function syntheticCellSource():CellOutputSource{return{version:1 as const,identityId:'synthetic-identity',formationRunId:'synthetic-formation',
 lineage:{assemblyRunId:'synthetic-assembly',assemblyOutputId:'synthetic-cell-output',assemblyOperationId:'synthetic-cell-count',fillingRunId:'synthetic-fill',fillingReceiptId:'synthetic-fill-receipt',fillingBox:'dry-room' as const,formationInputId:'synthetic-fill'},
 cellType:'cylindrical' as const,inputSerialRange:{prefix:'SYNTHETIC-',start:10,end:13},ranges:[{start:10,end:10},{start:12,end:12}],
 formation:{cellsIn:4,cellsOut:2,cellsScrap:1,cellsUnknown:1,workerId:'synthetic-worker',recordedRole:'worker' as const,recordedAt:'2026-11-15T10:00:00.000Z',startDate:'2026-11-14',endDate:'2026-11-15',mode:{cycles:5,currentA:-1,voltageV:4.1},capacityCycle5Ah:2.5,coulombEfficiencyPct:95,measurementBasis:'Synthetic observed channel sheet',measurementUnits:{current:'A',voltage:'V',capacity:'Ah',efficiency:'%',cycles:'count'}},
 declaration:{recordedBy:'synthetic-worker',recordedRole:'worker' as const,recordedAt:'2026-11-15T10:01:00.000Z',evidence:'Synthetic explicit serial sheet'}};}
const guid='11111111-1111-4111-8111-111111111111';
export const syntheticCellSubmission=()=>({operationId:guid,deviceId:guid,productionBatchId:guid,completionId:guid,stepNumber:1,materialId:guid,source:syntheticCellSource(),reason:'Actual deliberate output offer',evidence:'Synthetic completed route and serial evidence'});
