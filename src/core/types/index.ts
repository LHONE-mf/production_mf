// ============================================================
// ЭТАПЫ ПРОИЗВОДСТВА («комнаты» цеха). Каждый этап — отдельный
// модуль в src/stages/<id>. Полный офлайн: данные хранятся
// локально, передача только через Bluetooth / QR / текст.
// ============================================================
export enum StageId {
  STORAGE = 'storage',         // Склад материалов
  SLURRY = 'slurry',           // Комната замесов (приготовление шлама)
  COATING = 'coating',         // Нанесение покрытия
  CALENDARING = 'calendaring', // Каландрирование
  SORTING = 'sorting',         // Сортировка / рубка пластин
  ASSEMBLY = 'assembly',       // Сборка элементов
  ELECTROLYTE = 'electrolyte', // Розлив электролита
  FORMATION = 'formation',     // Формирование (ЧЦЦ)
  AGING = 'aging',             // Старение
}

export const STAGE_LABELS: Record<StageId, string> = {
  [StageId.STORAGE]: 'Склад материалов',
  [StageId.SLURRY]: 'Комната замесов',
  [StageId.COATING]: 'Нанесение покрытия',
  [StageId.CALENDARING]: 'Каландрирование',
  [StageId.SORTING]: 'Сортировка',
  [StageId.ASSEMBLY]: 'Сборка элементов',
  [StageId.ELECTROLYTE]: 'Розлив электролита',
  [StageId.FORMATION]: 'Формирование (ЧЦЦ)',
  [StageId.AGING]: 'Старение',
};

// Порядок техпроцесса (для навигации и KPI-цепочки)
export const STAGE_ORDER: StageId[] = [
  StageId.STORAGE, StageId.SLURRY, StageId.COATING, StageId.CALENDARING,
  StageId.SORTING, StageId.ASSEMBLY, StageId.ELECTROLYTE,
  StageId.FORMATION, StageId.AGING,
];

// Запись в журнале работ конкретной комнаты (единица учёта для KPI)
export interface JournalEntry {
  id: string;
  stage: StageId;
  taskId?: string;          // связь с заданием (если работа по заданию)
  workerId: string;         // кто выполнил
  summary: string;          // что сделано
  params?: Record<string, number | string>; // специфичные параметры этапа
  defects?: string;         // дефекты / брак (пусто = без замечаний)
  createdAt: Date;
}

// ============================================================
// КОМНАТА ЗАМЕСОВ (slurry): компоненты, стандартные замесы,
// режимы замеса, журнал фактических замесов.
// ============================================================

// Компонент замеса из справочной базы (редактируется технологом/мастером)
export interface MixComponent {
  id: string;
  name: string;                  // название (например «LFP», «PVDF», «вода деионизованная»)
  kind: 'active' | 'binder' | 'conductive' | 'solvent' | 'additive'; // тип компонента
  densitySettled?: number;       // плотность утряски, г/см³
  densityTrue?: number;          // истинная плотность, г/см³
  capacity?: number;             // удельная ёмкость, мАч/г (если применимо)
  ssa?: number;                  // удельная площадь поверхности частиц, м²/г (BET)
  d50?: number;                  // D50 — медианный размер частиц, мкм
  updatedAt: number;             // для разрешения конфликтов при офлайн-синхронизации
}

// Строка рецепта: компонент + доля
export interface MixRecipeLine {
  componentId: string;
  pct: number;                   // % массы (для сухих — от массы СВ; для растворителя — от массы СВ)
}

// Этап режима замеса (скорости диспергатора/лопастей, вакуум, термостат, время)
export interface MixModeStage {
  id: string;
  name: string;                  // например «Диспергирование СВ»
  disperserRpm?: number;         // скорость диспергатора (высокооборотистая мешалка), об/мин
  paddleRpm?: number;            // скорость лопастей (низкооборотистая мешалка), об/мин
  vacuumOn: boolean;             // вакуум включён?
  vacuumKpa?: number;            // глубина вакуума, кПа (если включён)
  tempC?: number;                // температура термостата (чиллера), °C
  minutes: number;               // длительность этапа, мин
}

// Стандартный замес (рецепт + режим) — редактируемая база
export interface MixRecipe {
  id: string;
  name: string;                  // например «Катод LFP R-07»
  dryMassKg: number;             // базовая масса сухих веществ, кг
  lines: MixRecipeLine[];        // строки с выбором компонентов
  mode: MixModeStage[];          // этапы режима замеса
  note?: string;
  updatedBy: string;             // кто последний редактировал (User.id)
  updatedAt: number;
}

// Фактическая навеска компонента в замесе
export interface MixBatchWeighing {
  componentId: string;
  plannedG: number;              // расчётная граммовка, г
  actualG: number;               // фактическая навеска, г
}

// Журнал замеса — результат выполнения (slave → master пакетами)
export interface MixBatch {
  id: string;
  recipeId?: string;             // по какому стандартному замесу делали (если по базе)
  recipeName: string;            // снимок названия на момент замеса
  taskId?: string;               // задание, в рамках которого выполнен замес
  batchKg: number;               // масса замеса (СВ), кг
  weighings: MixBatchWeighing[]; // фактические навески
  modeActual?: MixModeStage[];   // факт режима (если отличался)
  viscosity?: number;            // вязкость (сП или мПа·с — как принято на участке)
  fineness?: number;             // степень перетира, мкм (лаборатория Хегмана)
  notes?: string;                // примечания / дефекты
  workerId: string;              // кто выполнил
  createdAt: number;
  updatedAt: number;             // для синхронизации
}

// Комментарий в комнате этапа (общая секция для всех ролей комнаты)
export interface StageComment {
  id: string;
  stage: StageId;
  authorId: string;
  text: string;
  journalEntryId?: string;  // опциональная привязка к записи журнала
  createdAt: Date;
}

// ============================================================
// ОФЛАЙН-ПАКЕТ ПЕРЕДАЧИ (Bluetooth / QR / текст — единый формат)
// ============================================================
export type SyncPacketType =
  | 'task'          // новое задание / изменение задания
  | 'result'        // результат выполнения (закрытие задания)
  | 'journal'       // запись журнала комнаты
  | 'comment'       // комментарий
  | 'user'          // пользователь (создаётся только chief)
  | 'mix-batch'     // журнал замеса (результат, отправляется slave → master)
  | 'mix-component' // компонент из базы комнаты замесов
  | 'mix-recipe'    // стандартный замес из базы
  | 'forced-push';  // принудительная запись master'ом в slave-устройство

export interface SyncPacket {
  v: 1;
  type: SyncPacketType;
  stage?: StageId;
  payload: unknown;         // Task | JournalEntry | StageComment | User ...
  from: string;             // id отправителя (User.id)
  ts: number;               // timestamp миллисекунды
  forced?: boolean;         // пакет от master, применяется безусловно
}

// Роли пользователей в системе
export enum UserRole {
  WORKER = 'worker',           // Работник
  TECHNOLOGIST = 'technologist', // Технолог
  MASTER = 'master',           // Мастер цеха
  CHIEF = 'chief',             // Начальник производства
}

// Права доступа для каждой роли
export interface RolePermissions {
  canViewOwnTasks: boolean;
  canCreateTasks: boolean;
  canAssignTasks: boolean;
  canManageUsers: boolean;
  canViewAllTasks: boolean;
  canEditTechCards: boolean;
  canViewWorkshopReports: boolean;
  canViewProductionReports: boolean;
  canManageMasterSlave: boolean;
  canConfigureMesh: boolean;
}

// Пользователь
export interface User {
  id: string;
  login: string;
  password: string; // В реальном приложении - хеш
  fullName: string;
  role: UserRole;
  createdAt: Date;
  isActive: boolean;
  assignedMasterId?: string; // ID мастера/начальника (для slave-устройств)
}

// Статус задания
export enum TaskStatus {
  CREATED = 'created',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  CHECKED = 'checked',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

// Приоритет задания
export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// Задание
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string; // User ID
  createdBy: string; // User ID
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
  techCardId?: string;
  stage?: StageId;      // этап производства (комната), к относится задание
  workshopId?: string;
  comments: TaskComment[];
  attachments: TaskAttachment[];
}

// Комментарий к заданию
export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  text: string;
  createdAt: Date;
}

// Вложение к заданию
export interface TaskAttachment {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  data: string; // Base64 или URL
  createdAt: Date;
}

// Технологическая карта
export interface TechCard {
  id: string;
  name: string;
  description: string;
  steps: TechCardStep[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Шаг технологической карты
export interface TechCardStep {
  id: string;
  order: number;
  title: string;
  description: string;
  duration: number; // в минутах
  parameters?: Record<string, string>;
}

// Устройство для синхронизации
export interface SyncDevice {
  id: string;
  name: string;
  bluetoothId?: string;
  role: 'master' | 'slave';
  masterDeviceId?: string;
  lastSyncAt?: Date;
  isConnected: boolean;
  isOnline: boolean;
}

// Запись синхронизации
export interface SyncLog {
  id: string;
  deviceId: string;
  timestamp: Date;
  direction: 'upload' | 'download' | 'bidirectional';
  recordsSynced: number;
  status: 'success' | 'error' | 'partial';
  errorMessage?: string;
}

// Сообщение Bluetooth Mesh
export interface MeshMessage {
  id: string;
  type: 'task_assign' | 'task_update' | 'sync_request' | 'sync_data' | 'status_update';
  senderId: string;
  targetIds: string[]; // пустой = broadcast
  payload: any;
  timestamp: Date;
  ttl: number; // time to live в секундах
}

// Сессия авторизации
export interface AuthSession {
  userId: string;
  login: string;
  role: UserRole;
  token: string;
  expiresAt: Date;
}
