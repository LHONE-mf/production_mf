import Dexie, { Table } from 'dexie';
import { v4 as uuidv4 } from 'uuid';
import { User, Task, TechCard, SyncDevice, SyncLog, UserRole, TaskStatus, TaskPriority, JournalEntry, StageComment, StageId, MixComponent, MixRecipe, MixBatch, CoatRun, CoatingMixSnapshot, RollSpec, CalenderRun, ChatMessage, CuttingIncoming, CutRun, SortSpec, SortRun, DefectEntry, AssemblyRun, ElectrolyteIncoming, FillRun, WalzingIncoming, WalzRun } from '../types';

export class AppDatabase extends Dexie {
  users!: Table<User, string>;
  tasks!: Table<Task, string>;
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

/**
 * Инициализация базы данных:
 * - создаёт демо-пользователей (4 роли), если база пуста;
 * - создаёт демо-задания, чтобы модули были наполнены данными с первого запуска.
 * В продакшене пароли должны храниться в виде хешей (этап безопасности).
 */
export async function initializeDatabase() {
  const now = () => new Date();

  if ((await db.users.count()) === 0) {
    await db.users.bulkAdd([
      { id: 'chief-001', login: 'chief', password: 'admin123', fullName: 'Иванов Иван Иванович', role: UserRole.CHIEF, createdAt: now(), isActive: true },
      { id: 'master-001', login: 'master', password: 'master123', fullName: 'Петров Пётр Петрович', role: UserRole.MASTER, createdAt: now(), isActive: true },
      { id: 'tech-001', login: 'technologist', password: 'tech123', fullName: 'Сидоров Алексей Викторович', role: UserRole.TECHNOLOGIST, createdAt: now(), isActive: true },
      { id: 'worker-001', login: 'worker', password: 'worker123', fullName: 'Козлов Дмитрий Сергеевич', role: UserRole.WORKER, createdAt: now(), isActive: true, assignedMasterId: 'master-001' },
      { id: 'worker-002', login: 'worker2', password: 'worker123', fullName: 'Новиков Андрей Михайлович', role: UserRole.WORKER, createdAt: now(), isActive: true, assignedMasterId: 'master-001' },
      { id: 'worker-003', login: 'worker3', password: 'worker123', fullName: 'Морозов Сергей Николаевич', role: UserRole.WORKER, createdAt: now(), isActive: true, assignedMasterId: 'master-001' },
    ]);
  }

  if ((await db.tasks.count()) === 0) {
    await db.tasks.bulkAdd([
      {
        id: 'task-001', title: 'Сборка блока ячеек 48V',
        description: 'Собрать блок из 13 последовательных ячеек 21700, проверить полярность.',
        status: TaskStatus.IN_PROGRESS, priority: TaskPriority.HIGH,
        assignedTo: 'worker-001', createdBy: 'master-001',
        createdAt: new Date(Date.now() - 3600000), updatedAt: now(),
        dueDate: new Date(Date.now() + 7200000), comments: [], attachments: [],
      },
      {
        id: 'task-002', title: 'Сварка никелевых контактов',
        description: 'Провести точечную сварку 48 контактов, контроль качества каждого шва.',
        status: TaskStatus.ASSIGNED, priority: TaskPriority.MEDIUM,
        assignedTo: 'worker-002', createdBy: 'master-001',
        createdAt: new Date(Date.now() - 1800000), updatedAt: now(),
        dueDate: new Date(Date.now() + 14400000), comments: [], attachments: [],
      },
      {
        id: 'task-003', title: 'Тестирование BMS платы',
        description: 'Проверить все каналы балансировки и защиту по току.',
        status: TaskStatus.CREATED, priority: TaskPriority.LOW,
        assignedTo: 'worker-003', createdBy: 'tech-001',
        createdAt: new Date(Date.now() - 900000), updatedAt: now(),
        comments: [], attachments: [],
      },
      {
        id: 'task-004', title: 'Калибровка датчиков температуры',
        description: 'Калибровка 8 термопар на линии 2.',
        status: TaskStatus.COMPLETED, priority: TaskPriority.MEDIUM,
        assignedTo: 'worker-001', createdBy: 'tech-001',
        createdAt: new Date(Date.now() - 86400000), updatedAt: now(),
        comments: [], attachments: [],
      },
      {
        id: 'task-005', title: 'Комната замесов LFP (партия 12)',
        description: 'Замесить шлам по рецепту R-07: катод LFP, PVDF, CMC, вода. Проверить вязкость.',
        status: TaskStatus.ASSIGNED, priority: TaskPriority.HIGH,
        assignedTo: 'worker-002', createdBy: 'master-001',
        stage: StageId.SLURRY,
        createdAt: new Date(Date.now() - 3600000 * 5), updatedAt: now(),
        comments: [], attachments: [],
      },
      {
        id: 'task-006', title: 'Нанесение покрытия на фольгу, линия 1',
        description: 'Нанести шлам партии 12 на Al-фольгу, толщина 120 мкм, скорость 8 м/мин.',
        status: TaskStatus.IN_PROGRESS, priority: TaskPriority.HIGH,
        assignedTo: 'worker-003', createdBy: 'master-001',
        stage: StageId.COATING,
        createdAt: new Date(Date.now() - 3600000 * 3), updatedAt: now(),
        comments: [], attachments: [],
      },
      {
        id: 'task-007', title: 'Каландрирование рулона R-118',
        description: 'Обжать покрытие до 90 мкм, зазор валков 60 мкм, проверить плотность.',
        status: TaskStatus.CREATED, priority: TaskPriority.MEDIUM,
        assignedTo: 'worker-001', createdBy: 'tech-001',
        stage: StageId.CALENDARING,
        createdAt: new Date(Date.now() - 3600000), updatedAt: now(),
        comments: [], attachments: [],
      },
    ] as Task[]);
  }

  // Демо-записи журналов комнат + комментарии (чтобы комнаты не были пустыми)
  if ((await db.journal.count()) === 0) {
    await db.journal.bulkAdd([
      {
        id: 'jr-001', stage: StageId.SLURRY, workerId: 'worker-002',
        summary: 'Замес шлама партия 11, 240 кг', params: { 'Масса, кг': 240, 'Вязкость, сП': 3200, 'Температура, °C': 25 },
        defects: '', createdAt: new Date(Date.now() - 86400000),
      },
      {
        id: 'jr-002', stage: StageId.COATING, workerId: 'worker-003',
        summary: 'Покрытие рулон R-117, 800 м', params: { 'Длина, м': 800, 'Толщина, мкм': 122, 'Скорость, м/мин': 8 },
        defects: 'Проколы на участке 320-325 м', createdAt: new Date(Date.now() - 43200000),
      },
      {
        id: 'jr-003', stage: StageId.ASSEMBLY, workerId: 'worker-001',
        summary: 'Сборка 120 ячеек 21700, проверка полярности', params: { 'Количество': 120, 'Брак': 2 },
        defects: '2 ячейки с переполюсовкой', createdAt: new Date(Date.now() - 7200000),
      },
    ] as JournalEntry[]);

    await db.stageComments.bulkAdd([
      {
        id: 'sc-001', stage: StageId.SLURRY, authorId: 'tech-001',
        text: 'Для партии 12 снизить воду на 2% — вязкость была на верхней границе.',
        journalEntryId: 'jr-001', createdAt: new Date(Date.now() - 82800000),
      },
      {
        id: 'sc-002', stage: StageId.COATING, authorId: 'master-001',
        text: 'Проколы на R-117 — проверить натяжение ленты, вызвать наладчика.',
        journalEntryId: 'jr-002', createdAt: new Date(Date.now() - 40000000),
      },
    ] as StageComment[]);
  }

  // Демо-базы комнаты замесов: компоненты, стандартные замесы, журнал замесов
  if ((await db.mixComponents.count()) === 0) {
    const now = Date.now();
    await db.mixComponents.bulkAdd([
      { id: 'mc-lfp',   name: 'LFP (LiFePO4)', kind: 'active', densitySettled: 1.5, densityTrue: 3.6, capacity: 155, ssa: 18, d50: 0.8, updatedAt: now },
      { id: 'mc-nmc',   name: 'NMC 622', kind: 'active', densitySettled: 1.9, densityTrue: 4.75, capacity: 165, ssa: 12, d50: 5, updatedAt: now },
      { id: 'mc-gr',    name: 'Графит', kind: 'active', densitySettled: 0.9, densityTrue: 2.25, capacity: 350, ssa: 2, d50: 12, updatedAt: now },
      { id: 'mc-pvdf',  name: 'PVDF (связующее)', kind: 'binder', densitySettled: 0.5, densityTrue: 1.78, updatedAt: now },
      { id: 'mc-cmc',   name: 'CMC (связующее)', kind: 'binder', densityTrue: 1.59, updatedAt: now },
      { id: 'mc-sbr',   name: 'SBR (латекс)', kind: 'binder', updatedAt: now },
      { id: 'mc-cb',    name: 'Carbon Black (CB)', kind: 'conductive', densitySettled: 0.05, densityTrue: 1.8, ssa: 60, d50: 0.02, updatedAt: now },
      { id: 'mc-cn',    name: 'CNT-добавка', kind: 'conductive', updatedAt: now },
      { id: 'mc-water', name: 'Вода деионизованная', kind: 'solvent', densityTrue: 1, viscosity: 0.89, updatedAt: now },
      { id: 'mc-nmp',   name: 'NMP (растворитель)', kind: 'solvent', densityTrue: 1.03, viscosity: 1.87, updatedAt: now },
    ] as MixComponent[]);

    await db.mixRecipes.bulkAdd([
      {
        id: 'mr-lfp-r07', name: 'Катод LFP R-07', dryMassKg: 100,
        lines: [
          { componentId: 'mc-lfp', pct: 94 },
          { componentId: 'mc-pvdf', pct: 3 },
          { componentId: 'mc-cb', pct: 2 },
          { componentId: 'mc-water', pct: 48 }, // от массы сухих веществ
        ],
        mode: [
          { id: uuidv4(), name: 'Смешивание СВ (лопасти)', paddleRpm: 40, vacuumOn: false, tempC: 25, minutes: 15 },
          { id: uuidv4(), name: 'Диспергирование', disperserRpm: 1200, paddleRpm: 40, vacuumOn: true, vacuumKpa: -80, tempC: 30, minutes: 45 },
          { id: uuidv4(), name: 'Разбавление до вязкости', disperserRpm: 600, paddleRpm: 35, vacuumOn: true, vacuumKpa: -60, tempC: 25, minutes: 20 },
        ],
        note: 'Контролировать вязкость каждые 10 мин на этапе разбавления.',
        updatedBy: 'tech-001', updatedAt: now,
      },
      {
        id: 'mr-gr-anode', name: 'Анод графитовый A-03', dryMassKg: 80,
        lines: [
          { componentId: 'mc-gr', pct: 95 },
          { componentId: 'mc-cb', pct: 1 },
          { componentId: 'mc-cmc', pct: 1.5 },
          { componentId: 'mc-sbr', pct: 2.5 },
          { componentId: 'mc-water', pct: 55 },
        ],
        mode: [
          { id: uuidv4(), name: 'Набухание CMC', paddleRpm: 30, vacuumOn: false, tempC: 25, minutes: 20 },
          { id: uuidv4(), name: 'Диспергирование СВ', disperserRpm: 900, paddleRpm: 35, vacuumOn: true, vacuumKpa: -70, tempC: 28, minutes: 40 },
          { id: uuidv4(), name: 'Добавление SBR', disperserRpm: 500, paddleRpm: 30, vacuumOn: true, vacuumKpa: -70, tempC: 25, minutes: 15 },
        ],
        updatedBy: 'tech-001', updatedAt: now,
      },
    ] as MixRecipe[]);

    await db.mixBatches.bulkAdd([
      {
        id: 'mb-001', recipeId: 'mr-lfp-r07', recipeName: 'Катод LFP R-07', taskId: 'task-005',
        batchKg: 100,
        weighings: [
          { componentId: 'mc-lfp', plannedG: 94000, actualG: 94020 },
          { componentId: 'mc-pvdf', plannedG: 3000, actualG: 3000 },
          { componentId: 'mc-cb', plannedG: 2000, actualG: 1990 },
          { componentId: 'mc-water', plannedG: 48000, actualG: 47500 },
        ],
        viscosity: 3100, fineness: 15, notes: 'Вязкость в норме, перетир контрольный.',
        workerId: 'worker-002', createdAt: now - 86400000, updatedAt: now - 86400000,
      },
    ] as MixBatch[]);
  }

  // Демо-журнал нанесения покрытия (комната Coating)
  if ((await db.coatRuns.count()) === 0) {
    const now = Date.now();
    await db.coatRuns.bulkAdd([
      {
        id: 'cr-001', taskId: 'task-006', mixBatchId: 'mb-001',
        mixSnapshot: {
          mixBatchId: 'mb-001', recipeName: 'Катод LFP R-07', viscosity: 3100, fineness: 15,
          solidsPctMass: 64.9, solidsPctVol: 42.8, pasteDensity: 2.05, batchKg: 100, createdAt: now - 86400000,
        },
        foilType: 'Al 12 мкм', targetDryMgm2: 28,
        screwRpm: 45, webSpeedMpm: 8,
        ovenTempsC: [80, 95, 110, 120, 115, 100],
        mode: 'continuous',
        segLengthsM: [420, 380], sideALengthM: 800, sideBLengthM: 0,
        wetThicknessUm: 180, headGapUm: 190,
        defects: '', notes: 'Линия 1, смена утренняя.',
        workerId: 'worker-003', createdAt: now - 43200000, updatedAt: now - 43200000,
      },
      {
        id: 'cr-002', mixBatchId: 'mb-001',
        mixSnapshot: {
          mixBatchId: 'mb-001', recipeName: 'Катод LFP R-07', viscosity: 3100, fineness: 15,
          solidsPctMass: 64.9, solidsPctVol: 42.8, pasteDensity: 2.05, batchKg: 100, createdAt: now - 86400000,
        },
        foilType: 'Al 12 мкм', targetDryMgm2: 28,
        screwRpm: 52, webSpeedMpm: 10,
        ovenTempsC: [85, 100, 115, 125, 120, 105],
        mode: 'intermittent', gapWidthMm: 60, gapPitchMm: 240,
        segLengthsM: [300], sideALengthM: 300, sideBLengthM: 295,
        wetThicknessUm: 175, headGapUm: 185,
        defects: 'Смещение полос ~2 мм на участке 120 м',
        workerId: 'worker-003', createdAt: now - 7200000, updatedAt: now - 7200000,
      },
    ] as CoatRun[]);
  }

  // Демо для комнаты нарезки электродов: рулон пришёл с каландра + задание технолога
  if ((await db.cuttingRolls.count()) === 0) {
    const now = Date.now();
    await db.cuttingRolls.bulkAdd([
      {
        id: 'cal-demo-001',
        roll: {
          id: 'cal-demo-001', mixName: 'Катод LFP R-07 (рулон №4)',
          thicknessBeforeUm: 180, segLengthsM: [420, 380],
          sideALengthM: 800, sideBLengthM: 0, foilType: 'Al 12 мкм', createdAt: now - 3600000,
        },
        calender: {
          id: 'cal-demo-001', rollId: 'cal-demo-001', gapsMm: [0.35, 0.28, 0.25],
          totalLengthM: 800, thicknessAfterUm: 150, hasDefects: false,
          workerId: 'worker-003', createdAt: now - 1800000, updatedAt: now - 1800000,
        },
        thicknessAfterUm: 150,
        electrodeType: 'strip', coatingType: 'LFP (катод)',
        electrodeLengthMm: 950, webWidthMm: 318,
        techNotes: 'Полосы для цилиндрических 21700. Рез по центру поля.',
        createdAt: now - 1700000,
      },
      {
        id: 'cal-demo-002',
        roll: {
          id: 'cal-demo-002', mixName: 'Анод графит R-03 (рулон №2)',
          thicknessBeforeUm: 160, segLengthsM: [300],
          sideALengthM: 300, sideBLengthM: 295, foilType: 'Cu 8 мкм', createdAt: now - 5400000,
        },
        thicknessAfterUm: 132,
        electrodeType: 'prismatic', coatingType: 'Графит (анод)',
        electrodeLengthMm: 210, webWidthMm: 260,
        techNotes: 'Пластины для призматических ячеек 48Ah.',
        createdAt: now - 5000000,
      },
    ] as CuttingIncoming[]);
  }

  // Демо: реестр дефектов электродов (сортировка по КД) — критичные / не критичные
  if ((await db.defectRegistry.count()) === 0) {
    const now = Date.now();
    await db.defectRegistry.bulkAdd([
      { id: 'def-001', title: 'Разрушение токосъёмного слоя (осыпание)', severity: 'critical', description: 'Осыпание/отслоение активного слоя, видна фольга пятнами', action: 'Отбраковка', createdAt: now, updatedAt: now },
      { id: 'def-002', title: 'Сквозное повреждение фольги (прокол/разрыв)', severity: 'critical', description: 'Механическое повреждение токоcollectора насквозь', action: 'Отбраковка', createdAt: now, updatedAt: now },
      { id: 'def-003', title: 'Перекос реза (> допуск КД)', severity: 'critical', description: 'Нарезка смещена относительно полей покрытия', action: 'Отбраковка', createdAt: now, updatedAt: now },
      { id: 'def-004', title: 'Заусеницы / burr на кромке', severity: 'non-critical', description: 'Незначительные заусеницы по краю реза', action: 'Допустимо в пределах нормы КД', createdAt: now, updatedAt: now },
      { id: 'def-005', title: 'Царапины покрытия (неглубокие)', severity: 'non-critical', description: 'Поверхностные риски без обнажения фольги', action: 'В низший сорт', createdAt: now, updatedAt: now },
      { id: 'def-006', title: 'Наплывы / капли пасты', severity: 'non-critical', description: 'Локальные утолщения слоя после намазки', action: 'Контроль толщины, в низший сорт', createdAt: now, updatedAt: now },
      { id: 'def-007', title: 'Обнажённые участки вне поля', severity: 'non-critical', description: 'Промазы покрытия в межрядных промежутках', action: 'Допустимо в пределах нормы КД', createdAt: now, updatedAt: now },
    ] as DefectEntry[]);
  }

  // Демо: спецификация сортировки от технолога (партия с нарезки cal-demo-001)
  if ((await db.sortSpecs.count()) === 0) {
    const now = Date.now();
    await db.sortSpecs.add({
      id: 'ss-demo-001',
      batchName: 'Партия R-07/№4 (полосы LFP 950 мм)',
      incomingId: 'cal-demo-001', cutRunId: undefined,
      electrodeType: 'strip', coatingType: 'LFP (катод)',
      parameterName: 'Толщина электрода', unit: 'мкм',
      categories: [
        { name: 'Сорт А', criteria: 'Толщина 148–152 мкм; масса 4,80–4,95 г; дефекты только некритичные (допускаются: заусеницы, царапины)', minUm: 148, maxUm: 152, minMass: 4.8, maxMass: 4.95, allowedDefects: ['def-004', 'def-005'], notes: 'Основной сорт, идёт на сборку 21700' },
        { name: 'Сорт Б', criteria: 'Толщина 145–148 или 152–155 мкм; масса вне допуска А', minUm: 145, maxUm: 155, minMass: 4.65, maxMass: 5.1, allowedDefects: ['def-004', 'def-005', 'def-006'], notes: 'Низший сорт, резерв' },
      ],
      techNotes: 'Критичные дефекты — только отбраковка. Контроль: 10 пластин из каждой коробки.',
      authorId: 'tech-001', createdAt: now - 1500000, updatedAt: now - 1500000,
    } as SortSpec);
  }
}
