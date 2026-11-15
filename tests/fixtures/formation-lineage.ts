/** SYNTHETIC engineering fixture only. Calls the real offline manufacturing API. */
import {db} from '../../src/core/db';
import {type AssemblyRun,type FormationRun} from '../../src/core/types';
import {appendAssemblyOperation} from '../../src/core/manufacturing/assemblyOperations';
import {declareAssemblyCellOutput} from '../../src/core/manufacturing/assemblyCellOutput';
import {prepareFillingHandover,acceptFillingHandover} from '../../src/core/manufacturing/fillingHandover';
import {saveFillingResult,FILLING_UNITS} from '../../src/core/manufacturing/fillingResults';
import {prepareFormationHandover,saveFormationResult,FORMATION_UNITS} from '../../src/core/manufacturing/formationResults';
export async function syntheticFormationLineage(supervisorId:string,workerId:string):Promise<FormationRun>{
 const supervisor=(await db.users.get(supervisorId))!,worker=(await db.users.get(workerId))!,now=()=>new Date().toISOString(),id=()=>crypto.randomUUID();
 const base:AssemblyRun={id:id(),batchName:'SYNTHETIC explicit processed cells '+id(),cellType:'unassigned',ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId,createdAt:now(),updatedAt:now()};await db.assemblyRuns.add(base);
 const at=now(),observed=await appendAssemblyOperation(base,{id:id(),source:{kind:'declared',reference:'SYNTHETIC counted independent cells '+id()},substation:'crimp-cyl',workerId,recordedAt:at,finishedAt:at,qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells',output:'cells',scrap:'cells'},params:{},defects:[]},workerId);
 const source=await declareAssemblyCellOutput(observed,{id:id(),operationId:observed.ops[0].id!,count:4,cellType:'cylindrical',serialRange:{prefix:'SYN-'+id()+'-',start:10,end:13},recordedBy:supervisorId,recordedRole:supervisor.role,recordedAt:now(),note:'SYNTHETIC explicit counted cells, no pairing inference'},supervisorId);
 const instruction=await prepareFillingHandover(source,'dry-room',supervisorId,id()),receipt=await acceptFillingHandover(instruction,'dry-room',workerId,4,'SYNTHETIC physical count',id()),filledAt=now();
 const filled=await saveFillingResult({id:id(),resultVersion:1,sourceReceipt:receipt,box:'dry-room',batchName:source.batchName,serialRange:receipt.serialRange,cellType:receipt.cellType,cellsIn:4,cellsFilled:4,cellsScrap:0,cellsUnknown:0,electrolyteName:'SYNTHETIC test electrolyte',doseActual:2,vacuumKpa:0,pressureKpa:10,dwellMin:3,temperatureC:20,humidityPpm:0,measurementUnits:FILLING_UNITS,measurementBasis:'SYNTHETIC measured fixture values',defects:[],workerId,recordedRole:worker.role,createdAt:filledAt,updatedAt:filledAt},workerId);
 const incoming=await prepareFormationHandover(filled,workerId),recordedAt=now();
 return saveFormationResult({id:id(),sourceLedger:1,inputSnapshot:incoming,batchName:incoming.batchName,serialRange:incoming.serialRange,mode:{cycles:5},startDate:'2026-11-14',endDate:'2026-11-15',cellsIn:4,cellsOut:2,cellsScrap:1,cellsUnknown:1,measurementBasis:'SYNTHETIC actual partial processed count; no final QC',measurementUnits:FORMATION_UNITS,defects:[],workerId,recordedRole:worker.role,createdAt:recordedAt,updatedAt:recordedAt},workerId);
}
