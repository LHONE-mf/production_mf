import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { TaskPriority, TaskStatus, UserRole, StageId, type SyncPacket, type Task } from '../core/types';
import { encodeTask } from '../core/sync/taskDto';
import { applyPacket } from './apply';

// The transport signing policy is tested separately. Exercise only the
// already-authenticated QR/BLE dispatch and its Dexie ownership boundary.
vi.mock('../core/security', () => ({ verifyPacketSig: vi.fn(async () => true) }));

const taskId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
function task(id = taskId): Task {
  const now = new Date('2026-11-10T08:00:00Z');
  return {
    id, title: 'Protected server assignment', description: 'Before import',
    priority: TaskPriority.MEDIUM, status: TaskStatus.ASSIGNED,
    assignedTo: actorId, createdBy: actorId,
    createdAt: now, updatedAt: now, comments: [], attachments: [],
  };
}
function packet(type: SyncPacket['type'], payload: unknown, forced = false): SyncPacket {
  return {
    v: 1, type, payload, from: actorId,
    ts: Date.parse('2026-11-10T10:00:00Z'),
    forced, role: UserRole.MASTER, sig: 'test-only-transport-signature',
  };
}

beforeEach(async () => {
  await db.open();
  await db.transaction('rw', [db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox], async () => {
    await db.tasks.clear();
    await db.hybridTaskRevisions.clear();
    await db.hybridTaskOutbox.clear();
  });
});

describe('legacy packet boundary for authoritative server tasks', () => {
  it('rejects task, result, and forced packets for a known server revision across restart', async () => {
    await db.tasks.put(task());
    await db.hybridTaskRevisions.put({ entityId: taskId, revision: 4 });
    const attempted = [
      packet('task', { ...task(), title: 'QR replacement', updatedAt: new Date('2026-11-10T10:00:00Z') }),
      packet('result', { taskId, status: TaskStatus.COMPLETED }),
      packet('forced-push', { ...task(), title: 'Forced replacement' }, true),
    ];
    for (const incoming of attempted) {
      const result = await applyPacket(incoming);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Серверное задание');
      expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
      expect((await db.tasks.get(taskId))?.status).toBe(TaskStatus.ASSIGNED);
    }
    expect((await db.hybridTaskRevisions.get(taskId))?.revision).toBe(4);
    db.close();
    await db.open();
    expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
  });

  it('protects a first-upload task identified only by its pending outbox operation', async () => {
    const row = task();
    await db.tasks.put(row);
    await db.hybridTaskOutbox.add({
      operationId: crypto.randomUUID(), deviceId, entityType: 'task',
      entityId: taskId, operationType: 'upsert', expectedRevision: 0,
      payload: encodeTask(row), queuedAt: Date.now(), state: 'pending',
    });
    expect((await applyPacket(packet('task', { ...row, title: 'Unsafe overwrite' }))).ok).toBe(false);
    expect((await applyPacket(packet('forced-push', { ...row, title: 'Unsafe forced overwrite' }, true))).ok).toBe(false);
    expect((await db.tasks.get(taskId))?.title).toBe('Protected server assignment');
    expect(await db.hybridTaskOutbox.count()).toBe(1);
  });

  it('keeps the existing local-only QR task workflow available', async () => {
    const localTask = task('local-demo-task');
    await db.tasks.put(localTask);
    expect((await applyPacket(packet('task', { ...localTask, title: 'Legacy QR edit',
      updatedAt: new Date('2026-11-10T09:00:00Z') }))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.title).toBe('Legacy QR edit');
    expect((await applyPacket(packet('result', { taskId: localTask.id, status: TaskStatus.CHECKED }))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.status).toBe(TaskStatus.CHECKED);
    expect((await applyPacket(packet('forced-push', { ...localTask, title: 'Legacy forced edit' }, true))).ok).toBe(true);
    expect((await db.tasks.get(localTask.id))?.title).toBe('Legacy forced edit');
    expect(await db.hybridTaskOutbox.count()).toBe(0);
  });
});

describe('explicit cutting instruction receipt',()=>{
  it('retains frozen instructions across duplicate and competing forced packets',async()=>{
    const id='cut-instruction-receipt';await db.cuttingRolls.delete(id);
    const payload={id,electrodeType:'prismatic',electrodeLengthMm:100,electrodeWidthMm:50,webWidthMm:120,
      roll:{id:'roll-receipt',mixName:'Fixture',segLengthsM:[10],createdAt:1},
      calender:{id,rollId:'roll-receipt',gapsMm:[0.35],totalLengthM:10,thicknessAfterUm:80,hasDefects:false,workerId:actorId,createdAt:1,updatedAt:1},
      thicknessAfterUm:80,instruction:{recordedBy:actorId,recordedAt:1,calenderUpdatedAt:1},createdAt:1};
    expect((await applyPacket({...packet('cutting-roll',payload),role:UserRole.WORKER})).ok).toBe(false);
    const attempts=await Promise.all([applyPacket(packet('cutting-roll',payload)),applyPacket(packet('cutting-roll',{...payload,electrodeWidthMm:60},true))]);
    expect(attempts.filter(r=>r.ok)).toHaveLength(1);
    const stored=await db.cuttingRolls.get(id);expect(stored).toBeDefined();
    expect((await applyPacket(packet('cutting-roll',stored))).ok).toBe(true);
    expect((await applyPacket(packet('cutting-roll',{...stored,electrodeLengthMm:200},true))).ok).toBe(false);
    expect((await applyPacket(packet('cutting-roll',{...stored,instruction:undefined},true))).ok).toBe(false);
    expect(await db.cuttingRolls.get(id)).toEqual(stored);
    await db.cuttingRolls.delete(id);
  });
});

it('does not allow forced or legacy packets to duplicate an explicit sorting allocation',async()=>{
 const id='sorting-receipt';await db.sortRuns.delete(id);await db.sortRuns.delete('sorting-bypass');
 const source={id:'cut-receipt',incomingId:'roll-sort',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
 const spec={id:'spec-receipt',batchName:'roll-sort',cutRunId:source.id,electrodeType:'strip' as const,parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
 const payload={id,cutRunId:source.id,cutRunSnapshot:source,specSnapshot:spec,specId:spec.id,batchName:source.incomingId,goodCount:10,buckets:[{categoryName:'A',count:8}],rejected:2,workerId:'sorter',createdAt:1,updatedAt:1};
 expect((await applyPacket(packet('sort-run',payload))).ok).toBe(true);
 expect((await applyPacket(packet('sort-run',payload,true))).ok).toBe(true);
 expect((await applyPacket(packet('sort-run',{...payload,id:'sorting-bypass'},true))).ok).toBe(false);
 expect((await applyPacket(packet('sort-run',{...payload,id:'sorting-bypass',cutRunId:undefined,cutRunSnapshot:undefined,specSnapshot:undefined},true))).ok).toBe(false);
 expect((await applyPacket(packet('forced-push',{...payload,id:'sorting-bypass'},true))).ok).toBe(false);
 expect(await db.tasks.get('sorting-bypass')).toBeUndefined();
 expect(await db.sortRuns.get(id)).toEqual(payload);await db.sortRuns.delete(id);
});

it('does not misroute other unsupported forced manufacturing payloads into tasks',async()=>{
 for(const payload of [{id:'not-task',incomingId:'roll',goodCount:10,defectCount:0},
   {id:'not-task',rollId:'roll',gapsMm:[0.35],totalLengthM:10,thicknessAfterUm:80}]){
  expect((await applyPacket(packet('forced-push',payload,true))).ok).toBe(false);
  expect(await db.tasks.get('not-task')).toBeUndefined();
 }
});

it('protects an assembly intake against forced and stripped-source replacement',async()=>{
 const {takeAssemblySource}=await import('../core/manufacturing/assemblyIntake');
 const cut={id:'assembly-cut',incomingId:'assembly-roll',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
 const spec={id:'assembly-spec',cutRunId:cut.id,batchName:cut.incomingId,electrodeType:'strip' as const,parameterName:'Thickness',unit:'um',categories:[{name:'A',criteria:'Entered criterion'}],authorId:'tech',createdAt:1,updatedAt:1};
 const sorted={id:'assembly-sorted',cutRunId:cut.id,cutRunSnapshot:cut,specSnapshot:spec,specId:spec.id,batchName:cut.incomingId,goodCount:10,buckets:[{categoryName:'A',count:8}],rejected:2,workerId:'sorter',createdAt:1,updatedAt:1};
 await db.sortRuns.put(sorted);
 const run=await takeAssemblySource(sorted,'assembler','assembly-intake');
 expect((await applyPacket(packet('assembly-run',run))).ok).toBe(true);
 expect((await applyPacket(packet('assembly-run',{...run,cellsOut:4},true))).ok).toBe(false);
 expect((await applyPacket(packet('forced-push',{...run,intake:undefined,sourceSort:undefined},true))).ok).toBe(false);
 expect(await db.assemblyRuns.get(run.id)).toEqual(run);expect(await db.tasks.get(run.id)).toBeUndefined();
 await db.assemblyRuns.delete(run.id);await db.sortRuns.delete(sorted.id);await db.journal.delete(run.id);
});

it('protects appended assembly observation history against typed and generic forced replacements',async()=>{
 const {appendAssemblyOperation}=await import('../core/manufacturing/assemblyOperations');
 const base={id:'ops-receipt',batchName:'Historical recorded batch',cellType:'cylindrical' as const,ops:[],cellsOut:7,cellsScrap:1,defects:[],workerId:'original',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};
 await db.assemblyRuns.put(base);
 const op={source:{kind:'declared' as const,reference:'ops-receipt-source'},conversionNote:'Separate observed unit counts',id:'op-receipt',recordedAt:'2026-11-11T11:00:00Z',finishedAt:'2026-11-11T11:00:00Z',substation:'winding' as const,workerId:'operator',qtyIn:10,qtyOut:9,qtyScrap:1,units:{input:'sets' as const,output:'blocks' as const,scrap:'sets' as const},params:{},defects:[]};
 const saved=await appendAssemblyOperation(base,op,'operator');
 expect((await applyPacket(packet('assembly-run',saved))).ok).toBe(true);
 for(const type of ['assembly-run','forced-push'] as const){
  for(const payload of [{...base,updatedAt:'2099-01-01'}, {...saved,ops:[{...op,qtyOut:10}]},{...saved,operationLedger:undefined}])
   expect((await applyPacket(packet(type,payload,true))).ok).toBe(false);
 }
 expect((await applyPacket(packet('forced-push',{...base,id:'stripped-ops-receipt'},true))).ok).toBe(false);
 expect(await db.assemblyRuns.get('stripped-ops-receipt')).toBeUndefined();
 expect(await db.assemblyRuns.get(base.id)).toEqual(saved);expect(await db.tasks.get(base.id)).toBeUndefined();
 await db.assemblyRuns.delete(base.id);await db.journal.delete(op.id);
});

it('requires a permitted envelope role for cell-output declarations and protects their immutable history',async()=>{
 const {declareAssemblyCellOutput}=await import('../core/manufacturing/assemblyCellOutput');
 const {appendAssemblyOperation}=await import('../core/manufacturing/assemblyOperations');
 const base={id:'output-packet-job',batchName:'Output packet fixture',cellType:'unassigned' as const,ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId:'operator',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z'};
 await db.users.put({id:'output-master',login:'output-master',fullName:'Output master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()});await db.assemblyRuns.put(base);
 const operation={id:'output-packet-op',source:{kind:'declared' as const,reference:'output-packet-source'},substation:'crimp-cyl' as const,workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:3,qtyOut:2,qtyScrap:1,units:{input:'cells' as const,output:'cells' as const,scrap:'cells' as const},params:{},defects:[]};
 const observed=await appendAssemblyOperation(base,operation,'operator');
 const output={id:'output-packet-declaration',operationId:operation.id,count:2,cellType:'cylindrical' as const,serialRange:{prefix:'PKT-',start:9000,end:9001},recordedBy:'output-master',recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Entered count evidence, not QA'};
 const saved=await declareAssemblyCellOutput(observed,output,'output-master');await db.assemblyRuns.put(observed);
 expect((await applyPacket({...packet('assembly-run',saved),role:UserRole.WORKER})).ok).toBe(false);
 expect((await applyPacket(packet('assembly-run',saved))).ok).toBe(true);
 expect((await applyPacket(packet('forced-push',{...saved,cellOutput:undefined},true))).ok).toBe(false);
 expect((await applyPacket(packet('forced-push',{...base,id:'legacy-range-bypass',cellType:'cylindrical',cellsOut:2,serialRange:output.serialRange},true))).ok).toBe(false);
 expect(await db.assemblyRuns.get('legacy-range-bypass')).toBeUndefined();
 const legacy={...base,id:'legacy-retained-range',cellType:'cylindrical' as const,cellsOut:2,serialRange:{prefix:'KEEP-',start:10000,end:10001}};await db.assemblyRuns.put(legacy);
 expect((await applyPacket(packet('forced-push',{...legacy,serialRange:undefined,updatedAt:'2099-01-01'},true))).ok).toBe(false);expect(await db.assemblyRuns.get(legacy.id)).toEqual(legacy);await db.assemblyRuns.delete(legacy.id);
 expect(await db.assemblyRuns.get(base.id)).toEqual(saved);
 await db.assemblyRuns.delete(base.id);await db.users.delete('output-master');await db.journal.bulkDelete([operation.id,output.id]);
});

it('routes typed/forced filling transfers through declaration allocation and preserves recorded receipts',async()=>{
 const {prepareFillingHandover,acceptFillingHandover}=await import('../core/manufacturing/fillingHandover');
 const source={id:'filling-source',batchName:'Filling packet fixture',cellType:'unassigned' as const,ops:[{id:'filling-cells',source:{kind:'declared' as const,reference:'filling-counted-source'},substation:'crimp-cyl' as const,workerId:'operator',recordedAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:00:00Z',qtyIn:5,qtyOut:4,qtyScrap:1,units:{input:'cells' as const,output:'cells' as const,scrap:'cells' as const},params:{},defects:[]}],sourceLedger:1 as const,operationLedger:1 as const,cellsOut:0,cellsScrap:0,defects:[],workerId:'operator',createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T13:00:00Z',cellOutput:{id:'filling-output',operationId:'filling-cells',count:4,cellType:'cylindrical' as const,serialRange:{prefix:'FILL-',start:100,end:103},recordedBy:actorId,recordedRole:UserRole.MASTER,recordedAt:'2026-11-11T13:00:00Z',note:'Counted cells'}};
 await db.users.bulkPut([{id:actorId,login:'filling-master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()},{id:'filling-receiver',login:'filling-receiver',fullName:'Receiver',password:'test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);await db.assemblyRuns.put(source);
 const pending=await prepareFillingHandover(source,'dry-room',actorId,'filling-transfer');
 const typed={...packet('electrolyte-in',pending),stage:StageId.ELECTROLYTE};
 expect((await applyPacket(typed)).ok).toBe(true);expect((await db.electrolyteIncoming.get(pending.id))?.receipt).toBeUndefined();
 expect((await applyPacket({...typed,stage:StageId.ELECTROLYTE_705})).ok).toBe(false);
 expect((await applyPacket({...typed,payload:{...pending,cellsIn:3},forced:true})).ok).toBe(false);
 for(const payload of [{...pending,id:'filling-duplicate',box:'floor7-room5'},{...pending,id:'filling-duplicate',box:'floor7-room5',handover:undefined,sourceAssembly:undefined}])expect((await applyPacket({...packet('forced-push',payload,true),stage:StageId.ELECTROLYTE_705})).ok).toBe(false);
 expect(await db.tasks.get('filling-duplicate')).toBeUndefined();expect(await db.electrolyteIncoming.get('filling-duplicate')).toBeUndefined();
 const accepted=await acceptFillingHandover(pending,'dry-room','filling-receiver',4,'Count verified','filling-receipt');
 expect((await applyPacket(typed)).ok).toBe(true);expect(await db.electrolyteIncoming.get(pending.id)).toEqual(accepted);
 await db.electrolyteIncoming.delete(pending.id);await db.assemblyRuns.delete(source.id);await db.users.bulkDelete([actorId,'filling-receiver']);await db.journal.bulkDelete([pending.id,'filling-receipt']);
});
