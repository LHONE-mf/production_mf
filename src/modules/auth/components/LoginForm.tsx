import React, { useState } from 'react';
import { useAuthStore } from '../../../core/store/authStore';
import { AuthService } from '../services/AuthService';
import { User } from '../../../core/types';
import { ROLE_LABELS, ROLE_COLORS } from '../../../core/permissions';
import { Battery, Lock, User as UserIcon, AlertCircle, Loader2 } from 'lucide-react';

export function LoginForm() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login: authLogin } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const user = await AuthService.login(login, password);
      if (user) {
        authLogin(user);
      } else {
        setError('Неверный логин или пароль');
      }
    } catch (err) {
      setError('Ошибка подключения к базе данных');
    } finally {
      setIsLoading(false);
    }
  };

  const quickLogin = async (loginName: string, pass: string) => {
    setLogin(loginName);
    setPassword(pass);
    setIsLoading(true);
    try {
      const user = await AuthService.login(loginName, pass);
      if (user) {
        authLogin(user);
      }
    } catch (err) {
      setError('Ошибка входа');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }} />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-green-400 to-blue-500 rounded-2xl shadow-2xl mb-4">
            <Battery className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Li-Ion Production</h1>
          <p className="text-blue-200 text-sm mt-1">Система управления производством</p>
        </div>

        {/* Login Form */}
        <div className="bg-white/10 backdrop-blur-xl rounded-2xl p-8 shadow-2xl border border-white/20">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-blue-100 mb-1.5">
                Логин
              </label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-blue-300" />
                <input
                  type="text"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition"
                  placeholder="Введите логин"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-blue-100 mb-1.5">
                Пароль
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-blue-300" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition"
                  placeholder="Введите пароль"
                  required
                />
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/20 border border-red-400/30 rounded-xl text-red-200 text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600 text-white font-semibold rounded-xl shadow-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                'Войти в систему'
              )}
            </button>
          </form>

          {/* Quick login */}
          <div className="mt-6 pt-6 border-t border-white/10">
            <p className="text-xs text-blue-200/70 text-center mb-3">Быстрый вход (демо):</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => quickLogin('chief', 'admin123')}
                className="px-3 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-400/30 rounded-lg text-red-200 text-xs font-medium transition"
              >
                👑 Нач. производства
              </button>
              <button
                onClick={() => quickLogin('master', 'master123')}
                className="px-3 py-2 bg-orange-500/20 hover:bg-orange-500/30 border border-orange-400/30 rounded-lg text-orange-200 text-xs font-medium transition"
              >
                ⛑️ Мастер цеха
              </button>
              <button
                onClick={() => quickLogin('technologist', 'tech123')}
                className="px-3 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 rounded-lg text-purple-200 text-xs font-medium transition"
              >
                🧪 Технолог
              </button>
              <button
                onClick={() => quickLogin('worker', 'worker123')}
                className="px-3 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/30 rounded-lg text-blue-200 text-xs font-medium transition"
              >
                🔧 Работник
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-blue-300/50 text-xs mt-4">
          v1.0.0 • Офлайн режим • Bluetooth Mesh
        </p>
      </div>
    </div>
  );
}
