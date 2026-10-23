import React, { useState } from 'react';
import { useAuthStore } from '../../core/store/authStore';
import { UserRole, TaskStatus, TaskPriority } from '../../core/types';
import { ROLE_LABELS } from '../../core/permissions';
import { 
  Plus, Filter, Search, Clock, CheckCircle, AlertTriangle, 
  Circle, Play, XCircle, ChevronDown, MoreVertical, QrCode,
  Share2, Bluetooth
} from 'lucide-react';

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string;
  assignedToName: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  dueDate?: Date;
  progress: number;
}

const DEMO_TASKS: Task[] = [
  {
    id: '1', title: 'Сборка блока ячеек 48V', description: 'Собрать блок из 13 последовательных ячеек',
    status: TaskStatus.IN_PROGRESS, priority: TaskPriority.HIGH, assignedTo: 'worker-001',
    assignedToName: 'Козлов Д.С.', createdBy: 'master-001', createdByName: 'Петров П.П.',
    createdAt: new Date(Date.now() - 3600000), dueDate: new Date(Date.now() + 7200000), progress: 60,
  },
  {
    id: '2', title: 'Сварка никелевых контактов', description: 'Провести точечную сварку 48 контактов',
    status: TaskStatus.ASSIGNED, priority: TaskPriority.MEDIUM, assignedTo: 'worker-002',
    assignedToName: 'Новиков А.М.', createdBy: 'master-001', createdByName: 'Петров П.П.',
    createdAt: new Date(Date.now() - 1800000), dueDate: new Date(Date.now() + 14400000), progress: 0,
  },
  {
    id: '3', title: 'Тестирование BMS платы', description: 'Проверить все каналы балансировки',
    status: TaskStatus.CREATED, priority: TaskPriority.LOW, assignedTo: 'worker-003',
    assignedToName: 'Морозов С.Н.', createdBy: 'master-001', createdByName: 'Петров П.П.',
    createdAt: new Date(Date.now() - 900000), progress: 0,
  },
  {
    id: '4', title: 'Калибровка датчиков температуры', description: 'Калибровка 8 термопар на линии 2',
    status: TaskStatus.COMPLETED, priority: TaskPriority.MEDIUM, assignedTo: 'worker-001',
    assignedToName: 'Козлов Д.С.', createdBy: 'tech-001', createdByName: 'Сидоров А.В.',
    createdAt: new Date(Date.now() - 86400000), progress: 100,
  },
];

const STATUS_CONFIG = {
  [TaskStatus.CREATED]: { label: 'Создано', icon: Circle, color: 'text-slate-400', bg: 'bg-slate-500/20' },
  [TaskStatus.ASSIGNED]: { label: 'Назначено', icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/20' },
  [TaskStatus.IN_PROGRESS]: { label: 'В работе', icon: Play, color: 'text-orange-400', bg: 'bg-orange-500/20' },
  [TaskStatus.CHECKED]: { label: 'Проверено', icon: CheckCircle, color: 'text-purple-400', bg: 'bg-purple-500/20' },
  [TaskStatus.COMPLETED]: { label: 'Завершено', icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-500/20' },
  [TaskStatus.REJECTED]: { label: 'Отклонено', icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/20' },
};

const PRIORITY_CONFIG = {
  [TaskPriority.LOW]: { label: 'Низкий', color: 'bg-blue-500/20 text-blue-300' },
  [TaskPriority.MEDIUM]: { label: 'Средний', color: 'bg-orange-500/20 text-orange-300' },
  [TaskPriority.HIGH]: { label: 'Высокий', color: 'bg-red-500/20 text-red-300' },
  [TaskPriority.CRITICAL]: { label: 'Критический', color: 'bg-red-600/30 text-red-200' },
};

export function TasksModule() {
  const { currentUser } = useAuthStore();
  const [tasks] = useState<Task[]>(DEMO_TASKS);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (!currentUser) return null;

  const canCreate = currentUser.role === UserRole.MASTER || currentUser.role === UserRole.CHIEF;
  const canViewAll = currentUser.role !== UserRole.WORKER;

  const filteredTasks = tasks.filter((task) => {
    if (!canViewAll && task.assignedTo !== currentUser.id) return false;
    if (statusFilter !== 'all' && task.status !== statusFilter) return false;
    if (searchQuery && !task.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Задания</h1>
          <p className="text-slate-400 text-sm mt-1">
            {filteredTasks.length} заданий {statusFilter !== 'all' ? `• ${STATUS_CONFIG[statusFilter].label}` : ''}
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition shadow-lg shadow-blue-500/20"
          >
            <Plus className="w-5 h-5" />
            Создать задание
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск заданий..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-800/60 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${
              statusFilter === 'all' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-slate-800/60 text-slate-400 border border-slate-700/50 hover:text-white'
            }`}
          >
            Все
          </button>
          {Object.entries(STATUS_CONFIG).map(([status, config]) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status as TaskStatus)}
              className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${
                statusFilter === status ? `${config.bg} ${config.color} border border-current/30` : 'bg-slate-800/60 text-slate-400 border border-slate-700/50 hover:text-white'
              }`}
            >
              {config.label}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-3">
        {filteredTasks.map((task) => (
          <TaskCard key={task.id} task={task} canManage={canCreate} />
        ))}
        {filteredTasks.length === 0 && (
          <div className="text-center py-12">
            <ClipboardIcon className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">Задания не найдены</p>
          </div>
        )}
      </div>

      {/* Create task modal */}
      {showCreateModal && <CreateTaskModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}

function TaskCard({ task, canManage }: { task: Task; canManage: boolean }) {
  const statusConfig = STATUS_CONFIG[task.status];
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const StatusIcon = statusConfig.icon;

  return (
    <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 hover:border-slate-600/50 transition group">
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 ${statusConfig.bg} rounded-xl flex items-center justify-center flex-shrink-0`}>
          <StatusIcon className={`w-5 h-5 ${statusConfig.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-white font-medium text-sm">{task.title}</h3>
              <p className="text-slate-400 text-xs mt-0.5 line-clamp-1">{task.description}</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${priorityConfig.color}`}>
                {priorityConfig.label}
              </span>
              {canManage && (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                  <button className="p-1 hover:bg-slate-700 rounded" title="Отправить по QR">
                    <QrCode className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button className="p-1 hover:bg-slate-700 rounded" title="Отправить по Bluetooth">
                    <Bluetooth className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  <button className="p-1 hover:bg-slate-700 rounded" title="Поделиться">
                    <Share2 className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 mt-2">
            <span className="text-slate-500 text-xs">
              👤 {task.assignedToName}
            </span>
            <span className="text-slate-500 text-xs">
              📋 от {task.createdByName}
            </span>
            {task.dueDate && (
              <span className="text-slate-500 text-xs">
                ⏰ до {task.dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          {task.status === TaskStatus.IN_PROGRESS && (
            <div className="mt-3">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Прогресс</span>
                <span className="text-blue-300">{task.progress}%</span>
              </div>
              <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.progress}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateTaskModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.MEDIUM);
  const [assignee, setAssignee] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-800 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Новое задание</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <XCircle className="w-6 h-6" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">Название</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder="Введите название задания"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Описание</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 h-24 resize-none"
              placeholder="Опишите задание подробно"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-300 mb-1">Приоритет</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                <option value={TaskPriority.LOW}>Низкий</option>
                <option value={TaskPriority.MEDIUM}>Средний</option>
                <option value={TaskPriority.HIGH}>Высокий</option>
                <option value={TaskPriority.CRITICAL}>Критический</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-1">Исполнитель</label>
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                <option value="">Выберите...</option>
                <option value="worker-001">Козлов Д.С.</option>
                <option value="worker-002">Новиков А.М.</option>
                <option value="worker-003">Морозов С.Н.</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-medium transition"
            >
              Отмена
            </button>
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition shadow-lg shadow-blue-500/20"
            >
              Создать
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  );
}

export { TasksModule as default };
