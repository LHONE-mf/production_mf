import Dexie, { Table } from 'dexie';
import { v4 as uuidv4 } from 'uuid';
import { User, Task, TechCard, SyncDevice, SyncLog, UserRole, TaskStatus, TaskPriority, JournalEntry, StageComment, StageId, MixComponent, MixRecipe, MixBatch } from '../types';

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
}
