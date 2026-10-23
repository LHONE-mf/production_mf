import Dexie, { Table } from 'dexie';
import { User, Task, TechCard, SyncDevice, SyncLog, UserRole, TaskStatus, TaskPriority } from '../types';

export class AppDatabase extends Dexie {
  users!: Table<User, string>;
  tasks!: Table<Task, string>;
  techCards!: Table<TechCard, string>;
  syncDevices!: Table<SyncDevice, string>;
  syncLogs!: Table<SyncLog, string>;

  constructor() {
    super('LiIonProductionDB');

    this.version(1).stores({
      users: 'id, login, role, isActive, assignedMasterId',
      tasks: 'id, status, assignedTo, createdBy, priority, updatedAt',
      techCards: 'id, name, createdBy',
      syncDevices: 'id, bluetoothId, role, masterDeviceId, isConnected',
      syncLogs: 'id, deviceId, timestamp, status',
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
    ] as Task[]);
  }
}
