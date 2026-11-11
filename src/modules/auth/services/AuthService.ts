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

  /** One-time on-device administrator creation. This is NOT a PostgreSQL
   * account and grants no M2 server privileges. */
  static async createFirstLocalAdmin(input: {
    fullName: string; login: string; password: string;
  }): Promise<User> {
    const fullName=input.fullName.trim();
    const login=input.login.trim().toLowerCase();
    if (fullName.length < 2 || login.length < 3 ||
        !/^[a-z0-9_.-]{3,40}$/.test(login) || input.password.length < 10)
      throw new Error('Укажите имя, логин латиницей (3–40 символов) и пароль от 10 символов');
    // WebCrypto must run before the Dexie transaction to avoid an inactive
    // IndexedDB transaction while the PBKDF2 promise is unresolved.
    const hash=await hashPassword(input.password);
    const user:User={
      id:crypto.randomUUID(),login,password:hash,fullName,
      role:UserRole.CHIEF,createdAt:new Date(),isActive:true,
    };
    await db.transaction('rw',db.users,async()=>{
      if(await db.users.count()!==0)
        throw new Error('Первый пользователь уже создан. Войдите в систему');
      await db.users.add(user);
    });
    return user;
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
      password: await hashPassword(userData.password),
      id,
      createdAt: new Date(),
    });
    return id;
  }

  static async updateUser(id: string, updates: Partial<User>): Promise<void> {
    await db.users.update(id, updates.password
      ? { ...updates, password: await hashPassword(updates.password) }
      : updates);
  }

  static async deleteUser(id: string): Promise<void> {
    await db.users.update(id, { isActive: false });
  }

  static async getUserById(id: string): Promise<User | undefined> {
    return db.users.get(id);
  }
}
