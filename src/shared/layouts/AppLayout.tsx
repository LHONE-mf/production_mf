import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuthStore } from '../../core/store/authStore';
import { db } from '../../core/db';
import { ROLE_LABELS, ROLE_COLORS, getPermissions } from '../../core/permissions';
import { UserRole, Task } from '../../core/types';
import { STAGES } from '../../stages/registry';
import { 
  Battery, LogOut, LayoutDashboard, Users, ClipboardList, 
  Bluetooth, Radio, BarChart3, Settings, Menu, X, MessageSquare
} from 'lucide-react';

interface AppLayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  roles: UserRole[];
}

export function AppLayout({ children, activeTab, onTabChange }: AppLayoutProps) {
  const { currentUser, logout } = useAuthStore();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  if (!currentUser) return null;

  const permissions = getPermissions(currentUser.role);

  const navItems: NavItem[] = [
    {
      id: 'dashboard',
      label: 'Дашборд',
      icon: <LayoutDashboard className="w-5 h-5" />,
      roles: [UserRole.WORKER, UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF],
    },
    {
      id: 'tasks',
      label: 'Задания',
      icon: <ClipboardList className="w-5 h-5" />,
      roles: [UserRole.WORKER, UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF],
    },
    {
      id: 'chat',
      label: 'Чат цеха',
      icon: <MessageSquare className="w-5 h-5" />,
      roles: [UserRole.WORKER, UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF],
    },
    {
      id: 'users',
      label: 'Сотрудники',
      icon: <Users className="w-5 h-5" />,
      roles: [UserRole.CHIEF],
    },
    {
      id: 'communication',
      label: 'Связь',
      icon: <Bluetooth className="w-5 h-5" />,
      roles: [UserRole.MASTER, UserRole.CHIEF],
    },
    {
      id: 'sync',
      label: 'Синхронизация',
      icon: <Radio className="w-5 h-5" />,
      roles: [UserRole.MASTER, UserRole.CHIEF],
    },
    {
      id: 'reports',
      label: 'Отчёты',
      icon: <BarChart3 className="w-5 h-5" />,
      roles: [UserRole.MASTER, UserRole.CHIEF],
    },
  ];

  const filteredNav = navItems.filter((item) => item.roles.includes(currentUser.role));

  // Комнаты этапов: worker видит только комнаты своих заданий, остальные роли — все этапы
  const tasksByWorker = useLiveQuery<Task[]>(
    async () => (currentUser ? db.tasks.where('assignedTo').equals(currentUser.id).toArray() : []),
    [currentUser?.id],
  ) ?? [];
  const visibleStages = (() => {
    if (currentUser.role !== UserRole.WORKER) return STAGES;
    const workerStages = new Set<string>();
    tasksByWorker.forEach((t) => t.stage && workerStages.add(t.stage));
    const list = STAGES.filter((s) => workerStages.has(s.id));
    return list.length ? list : STAGES.slice(0, 1);
  })();

  return (
    <div className="min-h-screen bg-slate-900 flex">
      {/* Sidebar - Desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-slate-800/80 backdrop-blur border-r border-slate-700/50">
        {/* Logo */}
        <div className="p-4 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-green-400 to-blue-500 rounded-xl flex items-center justify-center">
              <Battery className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-sm">Li-Ion Production</h1>
              <p className="text-slate-400 text-xs">Управление цехом</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 min-h-0 p-3 space-y-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
          {filteredNav.map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                activeTab === item.id
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}

          {/* Комнаты этапов производства */}
          <p className="px-3 pt-4 pb-1 text-xs uppercase tracking-wider text-slate-500 font-semibold">Этапы цеха</p>
          {visibleStages.map((s) => (
            <button
              key={s.id}
              onClick={() => onTabChange(`stage:${s.id}`)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all ${
                activeTab === `stage:${s.id}`
                  ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                  : 'text-slate-300 hover:bg-slate-700/50'
              }`}
            >
              <span>{s.icon}</span>
              <span className="truncate">{s.title}</span>
            </button>
          ))}
        </nav>

        {/* User info */}
        <div className="p-4 border-t border-slate-700/50">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-9 h-9 ${ROLE_COLORS[currentUser.role]} rounded-lg flex items-center justify-center text-white text-sm font-bold`}>
              {currentUser.fullName.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{currentUser.fullName}</p>
              <p className="text-slate-400 text-xs">{ROLE_LABELS[currentUser.role]}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-red-300 text-sm transition"
          >
            <LogOut className="w-4 h-4" />
            Выйти
          </button>
        </div>
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-slate-800 p-4 flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Battery className="w-6 h-6 text-green-400" />
                <span className="text-white font-bold">Li-Ion</span>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-6 h-6" />
              </button>
            </div>
            <nav className="flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
              {filteredNav.map((item) => (
                <button
                  key={item.id}
                  onClick={() => { onTabChange(item.id); setSidebarOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    activeTab === item.id
                      ? 'bg-blue-500/20 text-blue-300'
                      : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
              <p className="px-3 pt-3 pb-1 text-xs uppercase tracking-wider text-slate-500 font-semibold">Этапы цеха</p>
              {visibleStages.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { onTabChange(`stage:${s.id}`); setSidebarOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                    activeTab === `stage:${s.id}` ? 'bg-green-500/20 text-green-300' : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <span>{s.icon}</span> {s.title}
                </button>
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center justify-between p-4 bg-slate-800/80 backdrop-blur border-b border-slate-700/50">
          <button onClick={() => setSidebarOpen(true)} className="text-white">
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <Battery className="w-5 h-5 text-green-400" />
            <span className="text-white font-bold text-sm">Li-Ion Production</span>
          </div>
          <button
            onClick={logout}
            title="Выйти из профиля"
            className={`w-8 h-8 ${ROLE_COLORS[currentUser.role]} rounded-lg flex items-center justify-center text-white text-xs font-bold`}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
