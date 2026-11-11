import Dexie, { Table } from 'dexie';
import { migratePasswords } from '../security';
import type { PendingTaskOperation } from '../sync/hybridOutbox';
import type { ArchivedTaskConflict } from '../sync/taskConflictResolution';
import type { OfflineTaskEditLease } from '../sync/offlineTaskLease';
import type { DeferredTaskChange } from '../sync/deferredTaskChange';
import { User, Task, TechCard, SyncDevice, SyncLog, JournalEntry, StageComment, StageId, MixComponent, MixRecipe, MixBatch, CoatRun, CoatingMixSnapshot, RollSpec, CalenderRun, ChatMessage, CuttingIncoming, CutRun, SortSpec, SortRun, DefectEntry, AssemblyRun, ElectrolyteIncoming, FillRun, WalzingIncoming, WalzRun, FormationIncoming, FormationRun } from '../types';

export class AppDatabase extends Dexie {
  users!: Table<User, string>;
  tasks!: Table<Task, string>;
  hybridTaskOutbox!: Table<PendingTaskOperation, string>;
  hybridTaskRevisions!: Table<{ entityId: string; revision: number }, string>;
  hybridTaskResolutions!: Table<ArchivedTaskConflict, string>;
  hybridTaskEditLeases!: Table<OfflineTaskEditLease, string>;
  hybridTaskDeferred!: Table<DeferredTaskChange, number>;
  hybridSyncMetadata!: Table<{ key: string; value: number }, string>;
  techCards!: Table<TechCard, string>;
  syncDevices!: Table<SyncDevice, string>;
  syncLogs!: Table<SyncLog, string>;
  journal!: Table<JournalEntry, string>;      // журналы работ комнат
  stageComments!: Table<StageComment, string>; // комментарии в комнатах
  // Комната замесов: базы и журнал
  mixComponents!: Table<MixComponent, string>; // база компонентов с параметрами
  mixRecipes!: Table<MixRecipe, string>;       // база стандартных (редактируемых) замесов
  mixBatches!: Table<MixBatch, string>;        // журнал фактических замесов
  // Комната нанесения покрытия
  coatRuns!: Table<CoatRun, string>;           // журнал нанесения
  coatIncomingMixes!: Table<CoatingMixSnapshot, string>; // принятые данные замесов (входящие на намазку)
  // Комната каландрирования
  rollSpecs!: Table<RollSpec, string>;         // рулоны, пришедшие с намазки (roll-spec)
  calenderRuns!: Table<CalenderRun, string>;   // журнал прокатки (параметры, зазоры, дефекты)
  // Комната нарезки электродов
  cuttingRolls!: Table<CuttingIncoming, string>; // входящие рулоны с каландра + задание технолога
  cuttingRuns!: Table<CutRun, string>;           // журнал нарезки → сортировка
  // Комната сортировки электродов
  sortSpecs!: Table<SortSpec, string>;           // спецификации технолога (параметры из КД)
  sortRuns!: Table<SortRun, string>;             // журнал сортировки (разнос по категориям)
  defectRegistry!: Table<DefectEntry, string>;   // реестр дефектов электродов (критичные/не критичные)
  // Комната сборки элементов
  assemblyRuns!: Table<AssemblyRun, string>;     // партии сборки: подсекции, выход ячеек, дефекты
  // Заливка электролита (два помещения: сухая комната и 7 этаж/к.5)
  electrolyteIncoming!: Table<ElectrolyteIncoming, string>; // входящие партии ячеек со сборки
  fillRuns!: Table<FillRun, string>;                         // журнал заливки
  // Вальцовка (после заливки на 7 этаже): обжим залитых ячеек
  walzingIncoming!: Table<WalzingIncoming, string>;          // входящие партии с заливки
  walzRuns!: Table<WalzRun, string>;                         // журнал вальцовки
  // Формировка (связана с заливкой в сухой комнате): номера АК мигрируют сборка → заливка → формовка
  formationIncoming!: Table<FormationIncoming, string>;      // входящие партии на формовку
  formationRuns!: Table<FormationRun, string>;               // журнал формировки
  // Меш-чат (офлайн): сообщения, доставленные по Bluetooth/QR/тексту
  chatMessages!: Table<ChatMessage, string>;   // id = from:ts — дедупликация в mesh

  constructor() {
    super('LiIonProductionDB');

    this.version(1).stores({
      users: 'id, login, role, isActive, assignedMasterId',
      tasks: 'id, status, assignedTo, createdBy, priority, updatedAt',
      techCards: 'id, name, createdBy',
      syncDevices: 'id, bluetoothId, role, masterDeviceId, isConnected',
      syncLogs: 'id, deviceId, timestamp, status',
    });

    // v2: комнаты этапа производства — журналы и комментарии
    this.version(2).stores({
      journal: 'id, stage, workerId, taskId, createdAt',
      stageComments: 'id, stage, authorId, journalEntryId, createdAt',
      tasks: 'id, status, assignedTo, createdBy, priority, updatedAt, stage',
    });

    // v3: комната замесов — компоненты, стандартные замесы, журнал замесов
    this.version(3).stores({
      mixComponents: 'id, name, kind, updatedAt',
      mixRecipes: 'id, name, updatedBy, updatedAt',
      mixBatches: 'id, recipeId, taskId, workerId, updatedAt',
    });

    // v4: фикс ошибки "KeyPath createdAt on object store mixBatches is not indexed"
    // добавляем индекс createdAt в журнал замесов (Dexie пересоздаст индекс при открытии)
    this.version(4).stores({
      mixBatches: 'id, recipeId, taskId, workerId, createdAt, updatedAt',
    });

    // v5: комната нанесения покрытия — журнал нанесения + входящие данные замесов
    this.version(5).stores({
      coatRuns: 'id, taskId, mixBatchId, workerId, createdAt, updatedAt',
      coatIncomingMixes: 'mixBatchId, recipeName, createdAt',
    });

    // v6: комната каландрирования — рулоны с намазки (roll-spec) и журнал прокатки
    this.version(6).stores({
      rollSpecs: 'id, mixName, createdAt',            // RollSpec[] — пришли от участка нанесения
      calenderRuns: 'id, rollId, taskId, workerId, createdAt, updatedAt', // CalenderRun[]
    });

    // v7: меш-чат — сообщения, доставленные по Bluetooth/QR/тексту
    this.version(7).stores({
      chatMessages: 'id, from, ts',
    });

    // v8: комната нарезки электродов — входящие рулоны + журнал нарезки
    this.version(8).stores({
      cuttingRolls: 'id, electrodeType, createdAt',              // CuttingIncoming[]
      cuttingRuns: 'id, incomingId, workerId, createdAt, updatedAt', // CutRun[]
    });

    // v9: комната сортировки электродов — спецификации технолога (КД) + журнал сортировки
    this.version(9).stores({
      sortSpecs: 'id, batchName, cutRunId, electrodeType, createdAt, updatedAt', // SortSpec[]
      sortRuns: 'id, specId, batchName, workerId, createdAt, updatedAt',         // SortRun[]
    });

    // v10: реестр дефектов электродов для сортировки (критичные / не критичные)
    this.version(10).stores({
      defectRegistry: 'id, severity, title, createdAt, updatedAt',               // DefectEntry[]
    });

    // v12: комната сборки — партии ячеек, идущие по подсекциям (Шаг Б1)
    this.version(12).stores({
      assemblyRuns: 'id, batchName, cellType, workerId, createdAt, updatedAt',   // AssemblyRun[]
    });

    // v13: заливка электролита — два бокса (сухая комната и 7 этаж/к.5)
    this.version(13).stores({
      electrolyteIncoming: 'id, box, batchName, receivedAt, updatedAt',           // ElectrolyteIncoming[]
      fillRuns: 'id, box, batchName, workerId, createdAt, updatedAt',             // FillRun[]
    });

    // v14: вальцовка — обжим залитых ячеек после заливки на 7 этаже (к.5)
    this.version(14).stores({
      walzingIncoming: 'id, batchName, receivedAt, updatedAt',                    // WalzingIncoming[]
      walzRuns: 'id, batchName, workerId, createdAt, updatedAt',                  // WalzRun[]
    });

    // v15: формирование (ЧЦЦ) — входящие партии с номерами АК + журнал формовки
    this.version(15).stores({
      formationIncoming: 'id, batchName, sourceBox, receivedAt, updatedAt',       // FormationIncoming[]
      formationRuns: 'id, batchName, workerId, startDate, createdAt, updatedAt',  // FormationRun[]
    });

    // v16: atomic task + outbox writes for hybrid server synchronization.
    this.version(16).stores({
      hybridTaskOutbox: 'operationId, entityId, state, queuedAt',
      hybridTaskRevisions: 'entityId',
      hybridSyncMetadata: 'key',
    });

    // v17: append-only local conflict archive, no change to previous stores.
    this.version(17).stores({
      hybridTaskResolutions: 'id, entityId, archivedAt',
    });

    // v18: time-limited proven-device local edit authorization (no bearer tokens).
    this.version(18).stores({
      hybridTaskEditLeases: 'id, deviceId, expiresAt',
    });

    // v19: replayable remote task changes that were blocked by offline edits.
    this.version(19).stores({
      hybridTaskDeferred: 'sequence, entityId',
    });

    // v11: миграция старых записей нарезки (stage:'sorting') → новый этап CUTTING.
    // Комнаты нарезки и сортировки разделены (Шаг S4). Миграция однократная,
    // выполняется при открытии БД (populate = новая база, upgrade = существующая).
    this.on('populate', async () => { await migrateCuttingStage(); });
    this.version(11).upgrade(async (tx) => {
      const tables = [tx.table('journal'), tx.table('stageComments'), tx.table('tasks')];
      for (const table of tables) {
        await table.toCollection().modify((row: any) => {
          if (row.stage === 'sorting') row.stage = 'cutting';
        });
      }
    });
  }
}

/** Перенос старых записей нарезки с id SORTING на CUTTING для НОВЫХ баз (populate) */
async function migrateCuttingStage() {
  try {
    const jOld = await db.journal.filter((j) => j.stage === ('sorting' as StageId)).toArray();
    for (const j of jOld) { j.stage = StageId.CUTTING; await db.journal.put(j); }
    const cOld = await db.stageComments.filter((c) => c.stage === ('sorting' as StageId)).toArray();
    for (const c of cOld) { c.stage = StageId.CUTTING; await db.stageComments.put(c); }
    const tOld = await db.tasks.filter((t) => t.stage === ('sorting' as StageId)).toArray();
    for (const t of tOld) { t.stage = StageId.CUTTING; await db.tasks.put(t); }
  } catch (e) {
    console.warn('migrateCuttingStage: пропускаем миграцию', e);
  }
}

export const db = new AppDatabase();

/** All local stores are reset together, including unsent offline task changes.
 * This never contacts the PostgreSQL server or deletes server-side records. */
export async function clearLocalDatabase(): Promise<void> {
  await db.open();
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}

const LEGACY_DEMO_USERS = new Set([
  'chief-001','master-001','tech-001','worker-001','worker-002','worker-003',
]);

/** No sample users, recipes, tasks, measurements or production runs are seeded.
 * Existing devices containing *only* the original built-in demo identities
 * are automatically cleared once. Other devices are never silently erased:
 * a deliberate local reset is available from the login screen.
 * Returns true if a legacy demo installation was reset. */
export async function initializeDatabase(): Promise<boolean> {
  await db.open();
  const users = await db.users.toArray();
  if (users.length > 0 && users.every(user => LEGACY_DEMO_USERS.has(user.id))) {
    await clearLocalDatabase();
    return true;
  }
  await migratePasswords(db.users);
  return false;
}
