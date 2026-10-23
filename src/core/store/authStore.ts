import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, UserRole, AuthSession, RolePermissions } from '../types';
import { getPermissions } from '../permissions';

interface AuthState {
  session: AuthSession | null;
  currentUser: User | null;
  permissions: RolePermissions | null;
  isAuthenticated: boolean;
  
  // Actions
  login: (user: User) => void;
  logout: () => void;
  updateSession: (session: Partial<AuthSession>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      session: null,
      currentUser: null,
      permissions: null,
      isAuthenticated: false,

      login: (user: User) => {
        const session: AuthSession = {
          userId: user.id,
          login: user.login,
          role: user.role,
          token: `token_${user.id}_${Date.now()}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 часа
        };
        set({
          session,
          currentUser: user,
          permissions: getPermissions(user.role),
          isAuthenticated: true,
        });
      },

      logout: () => {
        set({
          session: null,
          currentUser: null,
          permissions: null,
          isAuthenticated: false,
        });
      },

      updateSession: (partial) => {
        set((state) => ({
          session: state.session ? { ...state.session, ...partial } : null,
        }));
      },
    }),
    {
      name: 'auth-storage',
    }
  )
);
