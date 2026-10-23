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
