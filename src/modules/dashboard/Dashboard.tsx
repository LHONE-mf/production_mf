import React from 'react';
import { useAuthStore } from '../../core/store/authStore';
import { UserRole } from '../../core/types';
import { ROLE_LABELS } from '../../core/permissions';
import { 
  ClipboardList, Users, CheckCircle, Clock, AlertTriangle, 
  TrendingUp, Activity, Zap, Battery, Shield, Radio 
} from 'lucide-react';

export function Dashboard() {
  const { currentUser } = useAuthStore();
  if (!currentUser) return null;

  const role = currentUser.role;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Добро пожаловать, {currentUser.fullName.split(' ')[1] || currentUser.fullName}!
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {ROLE_LABELS[role]} • {new Date().toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <span className="text-green-300 text-xs font-medium">Онлайн</span>
        </div>
      </div>

      {/* Role-specific stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {role === UserRole.CHIEF && <ChiefStats />}
        {role === UserRole.MASTER && <MasterStats />}
        {role === UserRole.TECHNOLOGIST && <TechnologistStats />}
        {role === UserRole.WORKER && <WorkerStats />}
      </div>

      {/* Role-specific content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {role === UserRole.CHIEF && <ChiefDashboard />}
        {role === UserRole.MASTER && <MasterDashboard />}
        {role === UserRole.TECHNOLOGIST && <TechnologistDashboard />}
        {role === UserRole.WORKER && <WorkerDashboard />}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color, trend }: { icon: React.ReactNode; label: string; value: string | number; color: string; trend?: string }) {
  return (
    <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 ${color} rounded-xl flex items-center justify-center`}>
          {icon}
        </div>
        {trend && (
          <span className="text-green-400 text-xs font-medium flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            {trend}
          </span>
        )}
      </div>
      <div className="mt-3">
        <p className="text-2xl font-bold text-white">{value}</p>
        <p className="text-slate-400 text-sm mt-0.5">{label}</p>
      </div>
    </div>
  );
}

function ChiefStats() {
  return (
    <>
      <StatCard icon={<Users className="w-5 h-5 text-white" />} label="Сотрудников" value={6} color="bg-blue-500" trend="+2" />
      <StatCard icon={<ClipboardList className="w-5 h-5 text-white" />} label="Заданий активно" value={12} color="bg-orange-500" />
      <StatCard icon={<CheckCircle className="w-5 h-5 text-white" />} label="Завершено сегодня" value={8} color="bg-green-500" trend="+15%" />
      <StatCard icon={<AlertTriangle className="w-5 h-5 text-white" />} label="Просрочено" value={1} color="bg-red-500" />
    </>
  );
}

function MasterStats() {
  return (
    <>
      <StatCard icon={<Users className="w-5 h-5 text-white" />} label="Работников в смене" value={4} color="bg-blue-500" />
      <StatCard icon={<ClipboardList className="w-5 h-5 text-white" />} label="Заданий в работе" value={7} color="bg-orange-500" />
      <StatCard icon={<CheckCircle className="w-5 h-5 text-white" />} label="Завершено" value={5} color="bg-green-500" />
      <StatCard icon={<Radio className="w-5 h-5 text-white" />} label="Устройств в mesh" value={3} color="bg-purple-500" />
    </>
  );
}

function TechnologistStats() {
  return (
    <>
      <StatCard icon={<Zap className="w-5 h-5 text-white" />} label="Тех. карт" value={4} color="bg-purple-500" />
      <StatCard icon={<ClipboardList className="w-5 h-5 text-white" />} label="На контроле" value={6} color="bg-orange-500" />
      <StatCard icon={<Activity className="w-5 h-5 text-white" />} label="Параметров в норме" value="98%" color="bg-green-500" />
      <StatCard icon={<AlertTriangle className="w-5 h-5 text-white" />} label="Отклонений" value={1} color="bg-red-500" />
    </>
  );
}

function WorkerStats() {
  return (
    <>
      <StatCard icon={<ClipboardList className="w-5 h-5 text-white" />} label="Мои задания" value={3} color="bg-blue-500" />
      <StatCard icon={<Clock className="w-5 h-5 text-white" />} label="В работе" value={1} color="bg-orange-500" />
      <StatCard icon={<CheckCircle className="w-5 h-5 text-white" />} label="Завершено сегодня" value={2} color="bg-green-500" />
      <StatCard icon={<Shield className="w-5 h-5 text-white" />} label="Смена" value="Дневная" color="bg-slate-500" />
    </>
  );
}

function ChiefDashboard() {
  return (
    <>
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-400" />
          Сводка по производству
        </h3>
        <div className="space-y-3">
          {[
            { line: 'Линия 1 - Сборка ячеек', progress: 78, status: 'active' },
            { line: 'Линия 2 - Формирование', progress: 45, status: 'active' },
            { line: 'Линия 3 - Тестирование', progress: 92, status: 'active' },
            { line: 'Линия 4 - Упаковка', progress: 15, status: 'waiting' },
          ].map((item) => (
            <div key={item.line} className="flex items-center gap-3">
              <div className="flex-1">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-slate-300">{item.line}</span>
                  <span className="text-slate-400">{item.progress}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all ${
                      item.progress > 80 ? 'bg-green-500' : item.progress > 40 ? 'bg-blue-500' : 'bg-orange-500'
                    }`}
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Battery className="w-5 h-5 text-green-400" />
          Последние события
        </h3>
        <div className="space-y-3">
          {[
            { time: '10:32', event: 'Мастер Петров завершил смену на Линии 1', type: 'success' },
            { time: '09:45', event: 'Технолог Сидоров обновил тех.карту TC-004', type: 'info' },
            { time: '09:12', event: 'Обнаружено отклонение параметра на Линии 2', type: 'warning' },
            { time: '08:30', event: 'Начало дневной смены. 6 сотрудников', type: 'info' },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 p-2 rounded-lg hover:bg-slate-700/30">
              <span className="text-slate-500 text-xs mt-0.5 w-10 flex-shrink-0">{item.time}</span>
              <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                item.type === 'success' ? 'bg-green-400' : item.type === 'warning' ? 'bg-yellow-400' : 'bg-blue-400'
              }`} />
              <span className="text-slate-300 text-sm">{item.event}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function MasterDashboard() {
  return (
    <>
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Users className="w-5 h-5 text-orange-400" />
          Сотрудники на смене
        </h3>
        <div className="space-y-2">
          {[
            { name: 'Козлов Д.С.', role: 'Работник', status: 'working', task: 'Сборка ячеек #45' },
            { name: 'Новиков А.М.', role: 'Работник', status: 'working', task: 'Сварка контактов #32' },
            { name: 'Морозов С.Н.', role: 'Работник', status: 'break', task: 'Обед' },
          ].map((emp, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-slate-700/30 rounded-xl">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold ${
                emp.status === 'working' ? 'bg-green-500' : 'bg-yellow-500'
              }`}>
                {emp.name.charAt(0)}
              </div>
              <div className="flex-1">
                <p className="text-white text-sm font-medium">{emp.name}</p>
                <p className="text-slate-400 text-xs">{emp.task}</p>
              </div>
              <div className={`px-2 py-0.5 rounded-full text-xs ${
                emp.status === 'working' ? 'bg-green-500/20 text-green-300' : 'bg-yellow-500/20 text-yellow-300'
              }`}>
                {emp.status === 'working' ? 'Работает' : 'Перерыв'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-blue-400" />
          Текущие задания
        </h3>
        <div className="space-y-2">
          {[
            { title: 'Сборка блока ячеек 48V', assignee: 'Козлов Д.С.', priority: 'high', progress: 60 },
            { title: 'Сварка никелевых контактов', assignee: 'Новиков А.М.', priority: 'medium', progress: 35 },
            { title: 'Тестирование BMS платы', assignee: 'Морозов С.Н.', priority: 'low', progress: 0 },
          ].map((task, i) => (
            <div key={i} className="p-3 bg-slate-700/30 rounded-xl">
              <div className="flex justify-between items-start mb-2">
                <p className="text-white text-sm font-medium">{task.title}</p>
                <span className={`px-2 py-0.5 rounded text-xs ${
                  task.priority === 'high' ? 'bg-red-500/20 text-red-300' :
                  task.priority === 'medium' ? 'bg-orange-500/20 text-orange-300' :
                  'bg-blue-500/20 text-blue-300'
                }`}>
                  {task.priority === 'high' ? 'Высокий' : task.priority === 'medium' ? 'Средний' : 'Низкий'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-slate-600 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.progress}%` }} />
                </div>
                <span className="text-slate-400 text-xs">{task.progress}%</span>
              </div>
              <p className="text-slate-500 text-xs mt-1">{task.assignee}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TechnologistDashboard() {
  return (
    <>
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Zap className="w-5 h-5 text-purple-400" />
          Технологические карты
        </h3>
        <div className="space-y-2">
          {[
            { name: 'TC-001: Сборка призматики', version: 'v2.3', status: 'active' },
            { name: 'TC-002: Электролитическое заполнение', version: 'v1.8', status: 'active' },
            { name: 'TC-003: Формирование SEI-слоя', version: 'v3.0', status: 'review' },
            { name: 'TC-004: Тест ёмкости', version: 'v1.2', status: 'draft' },
          ].map((tc, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-slate-700/30 rounded-xl">
              <div className="w-8 h-8 bg-purple-500/20 rounded-lg flex items-center justify-center">
                <Zap className="w-4 h-4 text-purple-400" />
              </div>
              <div className="flex-1">
                <p className="text-white text-sm font-medium">{tc.name}</p>
                <p className="text-slate-400 text-xs">{tc.version}</p>
              </div>
              <span className={`px-2 py-0.5 rounded text-xs ${
                tc.status === 'active' ? 'bg-green-500/20 text-green-300' :
                tc.status === 'review' ? 'bg-yellow-500/20 text-yellow-300' :
                'bg-slate-500/20 text-slate-300'
              }`}>
                {tc.status === 'active' ? 'Активна' : tc.status === 'review' ? 'На проверке' : 'Черновик'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Activity className="w-5 h-5 text-green-400" />
          Параметры производства
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Температура', value: '23.5°C', norm: true },
            { label: 'Влажность', value: '35%', norm: true },
            { label: 'Давление', value: '1.2 атм', norm: true },
            { label: 'Напряжение', value: '3.72V', norm: false },
          ].map((param, i) => (
            <div key={i} className="p-3 bg-slate-700/30 rounded-xl text-center">
              <p className="text-slate-400 text-xs mb-1">{param.label}</p>
              <p className={`text-lg font-bold ${param.norm ? 'text-green-400' : 'text-red-400'}`}>
                {param.value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function WorkerDashboard() {
  return (
    <>
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-5 lg:col-span-2">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-blue-400" />
          Мои задания на сегодня
        </h3>
        <div className="space-y-3">
          {[
            { title: 'Сборка блока ячеек 48V', status: 'in_progress', priority: 'high', deadline: '14:00', progress: 60 },
            { title: 'Проверка изоляции контактов', status: 'pending', priority: 'medium', deadline: '16:00', progress: 0 },
            { title: 'Маркировка готовых блоков', status: 'pending', priority: 'low', deadline: '17:00', progress: 0 },
          ].map((task, i) => (
            <div key={i} className="p-4 bg-slate-700/30 rounded-xl border border-slate-600/30">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-white font-medium">{task.title}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      task.status === 'in_progress' ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-500/20 text-slate-300'
                    }`}>
                      {task.status === 'in_progress' ? 'В работе' : 'Ожидает'}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      task.priority === 'high' ? 'bg-red-500/20 text-red-300' :
                      task.priority === 'medium' ? 'bg-orange-500/20 text-orange-300' :
                      'bg-blue-500/20 text-blue-300'
                    }`}>
                      {task.priority === 'high' ? 'Высокий' : task.priority === 'medium' ? 'Средний' : 'Низкий'}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-slate-400 text-xs">Дедлайн</p>
                  <p className="text-white text-sm font-medium">{task.deadline}</p>
                </div>
              </div>
              {task.status === 'in_progress' && (
                <div className="mt-3">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400">Прогресс</span>
                    <span className="text-blue-300">{task.progress}%</span>
                  </div>
                  <div className="h-2 bg-slate-600 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${task.progress}%` }} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
