import Dexie, { Table } from 'dexie';
import { User, Task, TechCard, SyncDevice, SyncLog } from '../types';

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

// Инициализация - создание пользователя-администратора по умолчанию
export async function initializeDatabase() {
  const usersCount = await db.users.count();
  
  if (usersCount === 0) {
    // Создаём нач. производства по умолчанию
    await db.users.add({
      id: 'chief-001',
      login: 'chief',
      password: 'admin123', // В реальности - хеш
      fullName: 'Иванов Иван Иванович',
      role: 'chief' as any,
      createdAt: new Date(),
      isActive: true,
    });

    // Создаём мастера цеха
    await db.users.add({
      id: 'master-001',
      login: 'master',
      password: 'master123',
      fullName: 'Петров Пётр Петрович',
      role: 'master' as any,
      createdAt: new Date(),
      isActive: true,
    });

    // Создаём технолога
    await db.users.add({
      id: 'tech-001',
      login: 'technologist',
      password: 'tech123',
      fullName: 'Сидоров Алексей Викторович',
      role: 'technologist' as any,
      createdAt: new Date(),
      isActive: true,
    });

    // Создаём работника
    await db.users.add({
      id: 'worker-001',
      login: 'worker',
      password: 'worker123',
      fullName: 'Козлов Дмитрий Сергеевич',
      role: 'worker' as any,
      createdAt: new Date(),
      isActive: true,
    });

    // Создаём ещё работников
    await db.users.add({
      id: 'worker-002',
      login: 'worker2',
      password: 'worker123',
      fullName: 'Новиков Андрей Михайлович',
      role: 'worker' as any,
      createdAt: new Date(),
      isActive: true,
    });

    await db.users.add({
      id: 'worker-003',
      login: 'worker3',
      password: 'worker123',
      fullName: 'Морозов Сергей Николаевич',
      role: 'worker' as any,
      createdAt: new Date(),
      isActive: true,
    });
  }
}
