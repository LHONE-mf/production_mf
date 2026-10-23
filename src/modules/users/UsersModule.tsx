import React, { useState } from 'react';
import { UserRole } from '../../core/types';
import { ROLE_LABELS, ROLE_COLORS } from '../../core/permissions';
import { Plus, Search, Edit2, Trash2, Shield, UserCheck, UserX } from 'lucide-react';

interface UserItem {
  id: string;
  login: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  lastSeen?: string;
}

const DEMO_USERS: UserItem[] = [
  { id: 'chief-001', login: 'chief', fullName: 'Иванов Иван Иванович', role: UserRole.CHIEF, isActive: true, lastSeen: 'Сейчас' },
  { id: 'master-001', login: 'master', fullName: 'Петров Пётр Петрович', role: UserRole.MASTER, isActive: true, lastSeen: 'Сейчас' },
  { id: 'tech-001', login: 'technologist', fullName: 'Сидоров Алексей Викторович', role: UserRole.TECHNOLOGIST, isActive: true, lastSeen: '10 мин назад' },
  { id: 'worker-001', login: 'worker', fullName: 'Козлов Дмитрий Сергеевич', role: UserRole.WORKER, isActive: true, lastSeen: 'Сейчас' },
  { id: 'worker-002', login: 'worker2', fullName: 'Новиков Андрей Михайлович', role: UserRole.WORKER, isActive: true, lastSeen: '5 мин назад' },
  { id: 'worker-003', login: 'worker3', fullName: 'Морозов Сергей Николаевич', role: UserRole.WORKER, isActive: false, lastSeen: '2 дня назад' },
];

export function UsersModule() {
  const [users] = useState<UserItem[]>(DEMO_USERS);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');
  const [showAddModal, setShowAddModal] = useState(false);

  const filteredUsers = users.filter((user) => {
    if (roleFilter !== 'all' && user.role !== roleFilter) return false;
    if (searchQuery && !user.fullName.toLowerCase().includes(searchQuery.toLowerCase()) && !user.login.includes(searchQuery)) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Сотрудники</h1>
          <p className="text-slate-400 text-sm mt-1">{filteredUsers.length} из {users.length} сотрудников</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-5 h-5" />
          Добавить сотрудника
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по имени или логину..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-800/60 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          />
        </div>
        <div className="flex gap-2">
          {(['all', UserRole.CHIEF, UserRole.MASTER, UserRole.TECHNOLOGIST, UserRole.WORKER] as const).map((role) => (
            <button
              key={role}
              onClick={() => setRoleFilter(role)}
              className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${
                roleFilter === role ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-slate-800/60 text-slate-400 border border-slate-700/50 hover:text-white'
              }`}
            >
              {role === 'all' ? 'Все' : ROLE_LABELS[role]}
            </button>
          ))}
        </div>
      </div>

      {/* User list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filteredUsers.map((user) => (
          <div key={user.id} className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 hover:border-slate-600/50 transition">
            <div className="flex items-start gap-3">
              <div className={`w-12 h-12 ${ROLE_COLORS[user.role]} rounded-xl flex items-center justify-center text-white font-bold text-lg flex-shrink-0 ${!user.isActive ? 'opacity-50' : ''}`}>
                {user.fullName.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-white font-medium text-sm">{user.fullName}</h3>
                    <p className="text-slate-400 text-xs">@{user.login}</p>
                  </div>
                  <div className="flex gap-1">
                    <button className="p-1.5 hover:bg-slate-700 rounded-lg transition">
                      <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                    <button className="p-1.5 hover:bg-red-500/20 rounded-lg transition">
                      <Trash2 className="w-3.5 h-3.5 text-slate-400 hover:text-red-400" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[user.role]} text-white`}>
                    {ROLE_LABELS[user.role]}
                  </span>
                  <span className={`flex items-center gap-1 text-xs ${user.isActive ? 'text-green-400' : 'text-red-400'}`}>
                    {user.isActive ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                    {user.isActive ? 'Активен' : 'Неактивен'}
                  </span>
                </div>
                {user.lastSeen && (
                  <p className="text-slate-500 text-xs mt-1">Был(а) в сети: {user.lastSeen}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add user modal */}
      {showAddModal && <AddUserModal onClose={() => setShowAddModal(false)} />}
    </div>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const [fullName, setFullName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>(UserRole.WORKER);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-800 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-blue-400" />
            Новый сотрудник
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">×</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">ФИО</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder="Иванов Иван Иванович"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-300 mb-1">Логин</label>
              <input
                type="text"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="login"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-1">Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="••••••"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Роль / Должность</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              {Object.entries(ROLE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-medium transition">
              Отмена
            </button>
            <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition shadow-lg shadow-blue-500/20">
              Добавить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { UsersModule as default };
