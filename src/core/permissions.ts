import { UserRole, RolePermissions } from './types';

// Карта прав доступа для каждой роли
const ROLE_PERMISSIONS: Record<UserRole, RolePermissions> = {
  [UserRole.WORKER]: {
    canViewOwnTasks: true,
    canCreateTasks: false,
    canAssignTasks: false,
    canManageUsers: false,
    canViewAllTasks: false,
    canEditTechCards: false,
    canViewWorkshopReports: false,
    canViewProductionReports: false,
    canManageMasterSlave: false,
    canConfigureMesh: false,
  },
  [UserRole.TECHNOLOGIST]: {
    canViewOwnTasks: true,
    canCreateTasks: false,
    canAssignTasks: false,
    canManageUsers: false,
    canViewAllTasks: true,
    canEditTechCards: true,
    canViewWorkshopReports: false,
    canViewProductionReports: false,
    canManageMasterSlave: false,
    canConfigureMesh: false,
  },
  [UserRole.MASTER]: {
    canViewOwnTasks: true,
    canCreateTasks: true,
    canAssignTasks: true,
    canManageUsers: false,
    canViewAllTasks: true,
    canEditTechCards: true,
    canViewWorkshopReports: true,
    canViewProductionReports: false,
    canManageMasterSlave: true,
    canConfigureMesh: false,
  },
  [UserRole.CHIEF]: {
    canViewOwnTasks: true,
    canCreateTasks: true,
    canAssignTasks: true,
    canManageUsers: true,
    canViewAllTasks: true,
    canEditTechCards: true,
    canViewWorkshopReports: true,
    canViewProductionReports: true,
    canManageMasterSlave: true,
    canConfigureMesh: true,
  },
};

// Названия ролей
export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.WORKER]: 'Работник',
  [UserRole.TECHNOLOGIST]: 'Технолог',
  [UserRole.MASTER]: 'Мастер цеха',
  [UserRole.CHIEF]: 'Начальник производства',
};

// Цвета ролей для UI
export const ROLE_COLORS: Record<UserRole, string> = {
  [UserRole.WORKER]: 'bg-blue-500',
  [UserRole.TECHNOLOGIST]: 'bg-purple-500',
  [UserRole.MASTER]: 'bg-orange-500',
  [UserRole.CHIEF]: 'bg-red-500',
};

// Иконки ролей
export const ROLE_ICONS: Record<UserRole, string> = {
  [UserRole.WORKER]: 'wrench',
  [UserRole.TECHNOLOGIST]: 'flask-conical',
  [UserRole.MASTER]: 'hard-hat',
  [UserRole.CHIEF]: 'crown',
};

export function getPermissions(role: UserRole): RolePermissions {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: UserRole, permission: keyof RolePermissions): boolean {
  return ROLE_PERMISSIONS[role][permission];
}

// Цепочка подчинения
export function getSubordinates(role: UserRole): UserRole[] {
  switch (role) {
    case UserRole.CHIEF:
      return [UserRole.MASTER, UserRole.TECHNOLOGIST, UserRole.WORKER];
    case UserRole.MASTER:
      return [UserRole.TECHNOLOGIST, UserRole.WORKER];
    case UserRole.TECHNOLOGIST:
      return [UserRole.WORKER];
    case UserRole.WORKER:
      return [];
  }
}

export function getSupervisor(role: UserRole): UserRole | null {
  switch (role) {
    case UserRole.WORKER:
      return UserRole.MASTER;
    case UserRole.TECHNOLOGIST:
      return UserRole.MASTER;
    case UserRole.MASTER:
      return UserRole.CHIEF;
    case UserRole.CHIEF:
      return null;
    default:
      return null;
  }
}
