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
  CUTTING = 'cutting',         // Нарезка электродов (рулон → пластины/полосы)
  SORTING = 'sorting',         // Сортировка электродов по параметрам КД
  ASSEMBLY = 'assembly',       // Сборка элементов
  ELECTROLYTE = 'electrolyte', // Заливка электролита: бокс сухой комнаты
  ELECTROLYTE_705 = 'electrolyte-705', // Заливка электролита: бокс 7 этаж, к.5
  WALZING = 'walzing',       // Вальцовка (обжим залитых ячеек, после 7 этажа)
  FORMATION = 'formation',     // Формирование (ЧЦЦ)
}

export const STAGE_LABELS: Record<StageId, string> = {
  [StageId.STORAGE]: 'Склад материалов',
  [StageId.SLURRY]: 'Комната замесов',
  [StageId.COATING]: 'Нанесение покрытия',
  [StageId.CALENDARING]: 'Каландрирование',
  [StageId.CUTTING]: 'Нарезка электродов',
  [StageId.SORTING]: 'Сортировка',
  [StageId.ASSEMBLY]: 'Сборка элементов',
  [StageId.ELECTROLYTE]: 'Заливка электролита (сухая комната)',
  [StageId.ELECTROLYTE_705]: 'Заливка электролита (7 эт. / к.5)',
  [StageId.WALZING]: 'Вальцовка',
  [StageId.FORMATION]: 'Формирование (ЧЦЦ)',
};

// Порядок техпроцесса (для навигации и KPI-цепочки)
export const STAGE_ORDER: StageId[] = [
  StageId.STORAGE, StageId.SLURRY, StageId.COATING, StageId.CALENDARING,
  StageId.CUTTING, StageId.SORTING, StageId.ASSEMBLY, StageId.ELECTROLYTE,
  StageId.ELECTROLYTE_705, StageId.WALZING, StageId.FORMATION,
];

// ============================================================
// ЗАЛИВКА ЭЛЕКТРОЛИТА. Два разных помещения с одним процессом:
//  - ELECTROLYTE      — бокс сухой комнаты;
//  - ELECTROLYTE_705  — бокс на 7 этаже, комната 5.
// Партии приходят со СБОРКИ (assembly-run). Детали помещений
// опишем позже — структура намеренно расширяемая.
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
  | 'coating-mix'   // данные замеса → участку нанесения (снимок для расчётов)
  | 'coat-run'      // запись журнала нанесения покрытия (slave → master)
  | 'roll-spec'     // рулон намазка → технологу (master) → каландрирование
  | 'calender-result' // результат прокатки → нарезка / master
  | 'cutting-roll'    // рулон + задание технолога: каландр/технолог → нарезка
  | 'cut-run'         // запись журнала нарезки → сортировка / master
  | 'sort-spec'       // спецификация сортировки от технолога (параметры из КД) → сортировка
  | 'sort-run'        // результат сортировки партии → мастер/технолог (master)
  | 'defect-entry'    // запись реестра дефектов электродов (критичные/не критичные)
  | 'assembly-run'    // партия сборки элементов (сортировка → сборка → формовка/master)
  | 'electrolyte-in'  // входящая партия ячеек со сборки в бокс заливки
  | 'fill-run'        // результат заливки электролита (журнал → вальцовка/master)
  | 'walzing-in'      // залитые ячейки с 7 этажа/к.5 → на вальцовку
  | 'walz-run'        // запись журнала вальцовки (→ формирование/master)
  | 'formation-in'    // партия на формировку (заливка сух.комнаты/вальцовка → формирование)
  | 'formation-run'   // запись журнала формировки (→ старение/master)
  | 'chat'            // сообщение меш-чата (работник ↔ мастер ↔ технолог ↔ начальник)
  | 'forced-push';  // принудительная запись master'ом в slave-устройство

// ============================================================
// КОМНАТА НАРЕЗКИ ЭЛЕКТРОДОВ: рулон с каландра + задание технолога
// (тип электрода, покрытие, длина) → журнал нарезки → сортировка.
// ============================================================

export interface ChatMessage {
  id: string;            // id = from + ':' + ts (детерминированный — дедупликация в mesh)
  from: string;          // User.id автора
  fromName: string;      // имя автора для отображения (на случай, если пользователя ещё нет в базе)
  role?: UserRole;       // роль автора (для бейджа)
  text: string;
  ts: number;            // миллисекунды
  ttl: number;           // счётчик ретрансляций: стартует с MAX_HOPS, уменьшается при каждой пересылке
}

export const CHAT_MAX_HOPS = 5;   // сколько раз пакет может быть ретранслирован
export const CHAT_TTL_START = CHAT_MAX_HOPS;

export interface SyncPacket {
  v: 1;
  type: SyncPacketType;
  stage?: StageId;
  payload: unknown;         // Task | JournalEntry | StageComment | User ...
  from: string;             // id отправителя (User.id)
  ts: number;               // timestamp миллисекунды
  forced?: boolean;         // пакет от master, применяется безусловно
  role?: UserRole;          // роль отправителя (для проверки forced)
  sig?: string;             // подпись пакета (HMAC-SHA256, base64url), см. security.ts
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

// === ДОМЕННЫЕ ТИПЫ (декомпозиция) ===
export * from './domains/fill-formation';   // заливка электролита (2 бокса), вальцовка, формирование
export * from './domains/slurry-coating';   // замесы: журнал, компоненты, рецепты, режимы; намазка; комментарии
export * from './domains/cutting-sorting-calender'; // нарезка, дефекты, сортировка, каландрирование
export * from './domains/assembly';         // участок сборки: 6 подсекций, операции, партии
