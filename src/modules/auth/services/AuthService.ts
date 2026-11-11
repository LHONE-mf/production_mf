import { db } from '../../../core/db';
import { User, UserRole } from '../../../core/types';
import { verifyPassword, hashPassword, isLegacyPlainPassword } from '../../../core/security';

export class AuthService {
  static async login(login: string, password: string): Promise<User | null> {
    const user = await db.users
      .where('login')
      .equals(login.trim().toLowerCase())
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
    const login=userData.login.trim().toLowerCase();
    if(!/^[a-z0-9_.-]{3,40}$/.test(login) ||
       userData.fullName.trim().length<2 || userData.password.length<10)
      throw new Error('Имя, логин латиницей и пароль от 10 символов обязательны');
    const id=crypto.randomUUID();
    const hashed=await hashPassword(userData.password);
    await db.transaction('rw',db.users,async()=>{
      if(await db.users.where('login').equals(login).count()>0)
        throw new Error('Этот логин уже занят');
      await db.users.add({
        ...userData,login,fullName:userData.fullName.trim(),password:hashed,
        id,createdAt:new Date(),
      });
    });
    return id;
  }

  static async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const login=updates.login?.trim().toLowerCase();
    if(login!==undefined && !/^[a-z0-9_.-]{3,40}$/.test(login))
      throw new Error('Логин должен быть от 3 до 40 символов латиницей');
    if(updates.fullName!==undefined && updates.fullName.trim().length<2)
      throw new Error('Укажите имя сотрудника');
    if(updates.password!==undefined && updates.password.length<10)
      throw new Error('Пароль должен содержать не менее 10 символов');
    const password=updates.password===undefined?undefined:await hashPassword(updates.password);
    await db.transaction('rw',db.users,async()=>{
      const existing=await db.users.get(id);
      if(!existing)throw new Error('Сотрудник не найден');
      if(login!==undefined && login!==existing.login &&
         await db.users.where('login').equals(login).count()>0)
        throw new Error('Этот логин уже занят');
      if(existing.role===UserRole.CHIEF && updates.role && updates.role!==UserRole.CHIEF &&
         await db.users.where('role').equals(UserRole.CHIEF).filter(u=>u.isActive).count()<=1)
        throw new Error('Нельзя изменить роль последнего начальника');
      await db.users.update(id,{
        ...updates,
        ...(login!==undefined?{login}:{}),
        ...(updates.fullName!==undefined?{fullName:updates.fullName.trim()}:{}),
        ...(password!==undefined?{password}:{}),
      });
    });
  }

  static async deleteUser(id: string): Promise<void> {
    await db.transaction('rw',db.users,async()=>{
      const user=await db.users.get(id);
      if(!user)throw new Error('Сотрудник не найден');
      if(user.role===UserRole.CHIEF && user.isActive &&
         await db.users.where('role').equals(UserRole.CHIEF).filter(u=>u.isActive).count()<=1)
        throw new Error('Нельзя отключить последнего начальника');
      await db.users.update(id,{isActive:false});
    });
  }

  static async getUserById(id: string): Promise<User | undefined> {
    return db.users.get(id);
  }
}
