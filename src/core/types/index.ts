// ============================================================
// ЭТАПЫ ПРОИЗВОДСТВА («комнаты» цеха). Каждый этап — отдельный
// модуль в src/stages/<id>. Полный офлайн: данные хранятся
// локально, передача только через Bluetooth / QR / текст.
// ============================================================
export enum StageId {
  STORAGE = 'storage',         // Склад материалов
  SLURRY = 'slurry',           // Приготовление шлама
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
  [StageId.SLURRY]: 'Приготовление шлама',
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
  | 'task'        // новое задание / изменение задания
  | 'result'      // результат выполнения (закрытие задания)
  | 'journal'     // запись журнала комнаты
  | 'comment'     // комментарий
  | 'user'        // пользователь (создаётся только chief)
  | 'forced-push';// принудительная запись master'ом в slave-устройство

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
