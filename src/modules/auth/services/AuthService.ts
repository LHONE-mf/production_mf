import { db } from '../../../core/db';
import { User, UserRole } from '../../../core/types';

export class AuthService {
  static async login(login: string, password: string): Promise<User | null> {
    const user = await db.users
      .where('login')
      .equals(login)
      .first();

    if (user && user.password === password && user.isActive) {
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
