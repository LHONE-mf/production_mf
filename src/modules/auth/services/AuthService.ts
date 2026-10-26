import { db } from '../../../core/db';
import { User, UserRole } from '../../../core/types';
import { verifyPassword, hashPassword, isLegacyPlainPassword } from '../../../core/security';

export class AuthService {
  static async login(login: string, password: string): Promise<User | null> {
    const user = await db.users
      .where('login')
      .equals(login)
      .first();

    if (!user || !user.isActive) return null;

    // Поддержка старых открытых паролей с авто-миграцией в хеш при первом входе
    if (isLegacyPlainPassword(user.password)) {
      if (user.password !== password) return null;
      await db.users.update(user.id, { password: await hashPassword(password) });
      return user;
    }

    if (await verifyPassword(password, user.password)) {
      return user;
    }
    return null;
  }

  static async getAllUsers(): Promise<User[]> {
    return db.users.where('isActive').equals(1).toArray() as any;
  }

  static async getUsersByRole(role: UserRole): Promise<User[]> {
    return db.users.where('role').equals(role).toArray() as any;
  }

  static async createUser(userData: Omit<User, 'id' | 'createdAt'>): Promise<string> {
    const id = `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await db.users.add({
      ...userData,
      id,
      createdAt: new Date(),
    });
    return id;
  }

  static async updateUser(id: string, updates: Partial<User>): Promise<void> {
    await db.users.update(id, updates);
  }

  static async deleteUser(id: string): Promise<void> {
    await db.users.update(id, { isActive: false });
  }

  static async getUserById(id: string): Promise<User | undefined> {
    return db.users.get(id);
  }
}
