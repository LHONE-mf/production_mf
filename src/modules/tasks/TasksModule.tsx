import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import type { Task as StoredTask } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { UserRole, TaskStatus, TaskPriority } from '../../core/types';
import { createServerManagedTask, editServerManagedTask } from '../../core/sync/atomicTasks';
import { requireOfflineTaskEditLease } from '../../core/sync/offlineTaskLease';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { 
  Plus, Search, Clock, CheckCircle, 
  Circle, Play, XCircle
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
  const storedTasks = useLiveQuery(() => listVisibleTasks(), []);
  const users = useLiveQuery(() => db.users.toArray(), []);
  const editLease = useLiveQuery(() => db.hybridTaskEditLeases.get('active'), []);
  const sharedTaskVisibility = useLiveQuery(async () => {
    const revisions = await db.hybridTaskRevisions.toArray();
    const queued = await db.hybridTaskOutbox.toArray();
    return {
      ids: new Set([...revisions.map(row => row.entityId), ...queued.map(row => row.entityId)]),
      locallyCreated: new Set(queued.filter(op => op.expectedRevision === 0)
        .map(op => op.entityId)),
    };
  }, []);
  const sharedTaskIds = sharedTaskVisibility?.ids;
  const authorizedIds = new Set(editLease?.authorizedTaskIds ?? []);
  const hasEditLease = Boolean(editLease && editLease.expiresAt > Date.now());
  const tasks: Task[] = (storedTasks ?? []).map(task => ({
    ...task,
    assignedToName: users?.find(user => user.id === task.assignedTo)?.fullName ?? (task.assignedTo || 'Не назначен'),
    createdByName: users?.find(user => user.id === task.createdBy)?.fullName ?? task.createdBy,
    progress: task.status === TaskStatus.COMPLETED ? 100 : 0,
  }));
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<StoredTask | null>(null);

  if (!currentUser) return null;

  const localSupervisor = currentUser.role === UserRole.MASTER || currentUser.role === UserRole.CHIEF;
  const verifiedSupervisor = hasEditLease && (editLease?.role === 'chief' || editLease?.role === 'master');
  const canCreate = localSupervisor || verifiedSupervisor;
  const canViewAll = currentUser.role !== UserRole.WORKER;

  const filteredTasks = tasks.filter((task) => {
    // Local demo accounts must not reveal previously synced server records.
    // Access to shared tasks requires a still-valid offline permission from
    // the verified server identity, independently of the local demo role.
    if (sharedTaskIds?.has(task.id) ?? true) {
      if (!hasEditLease) return false;
      if (!authorizedIds.has(task.id) &&
          !(sharedTaskVisibility?.locallyCreated.has(task.id) && task.createdBy === editLease?.actorId)) return false;
      if (editLease?.role === 'worker' && task.assignedTo !== editLease.actorId) return false;
    } else if (!canViewAll && task.assignedTo !== currentUser.id) {
      return false;
    }
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

      {!hasEditLease && (sharedTaskIds?.size ?? 0) > 0 && <p className="text-amber-300 text-sm">
        Серверные задания скрыты. Подтвердите Android-устройство в разделе синхронизации для доступа к сохранённым заданиям.
      </p>}
      {storedTasks === undefined && <p className="text-slate-400 text-sm">Загрузка заданий...</p>}
      {/* Task list */}
      <div className="space-y-3">
        {filteredTasks.map((task) => (
          <TaskCard key={task.id} task={task}
            canManage={sharedTaskIds?.has(task.id) ? verifiedSupervisor : localSupervisor}
            canEditSharedFields={hasEditLease && (editLease?.role === 'chief' || editLease?.role === 'master')}
            canEditSharedStatus={hasEditLease && (
              editLease?.role === 'chief' || editLease?.role === 'master' ||
              (editLease?.role === 'worker' && task.assignedTo === editLease.actorId)
            )}
            canEditLocalStatus={currentUser.role === UserRole.WORKER && task.assignedTo === currentUser.id}
            onEdit={() => setEditingTask(storedTasks?.find(item => item.id === task.id) ?? null)} />
        ))}
        {filteredTasks.length === 0 && (
          <div className="text-center py-12">
            <ClipboardIcon className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">Задания не найдены</p>
          </div>
        )}
      </div>

      {/* Create task modal */}
      {showCreateModal && <CreateTaskModal creatorId={currentUser.id} users={users ?? []} canCreateShared={verifiedSupervisor} onClose={() => setShowCreateModal(false)} />}
      {editingTask && <CreateTaskModal key={editingTask.id} initialTask={editingTask} creatorId={currentUser.id} users={users ?? []} onClose={() => setEditingTask(null)} />}
    </div>
  );
}

function TaskCard({ task, canManage, canEditSharedFields, canEditSharedStatus, canEditLocalStatus, onEdit }: {
  task: Task; canManage: boolean; canEditSharedFields: boolean; canEditSharedStatus: boolean;
  canEditLocalStatus: boolean; onEdit: () => void;
}) {
  const [statusError, setStatusError] = useState('');
  const [updating, setUpdating] = useState(false);
  const managedRevision = useLiveQuery(() => db.hybridTaskRevisions.get(task.id), [task.id]);
  const queuedEdits = useLiveQuery(() => db.hybridTaskOutbox.where('entityId').equals(task.id).count(), [task.id]);
  const serverManaged = Boolean(managedRevision) || Boolean(queuedEdits);
  async function changeStatus(status: TaskStatus) {
    setUpdating(true); setStatusError('');
    try {
      if (serverManaged) {
        await editServerManagedTask(task.id, { status });
      } else {
        await db.tasks.update(task.id, { status, updatedAt: new Date() });
      }
    }
    catch (error) { setStatusError(error instanceof Error ? error.message : 'Не удалось обновить статус'); }
    finally { setUpdating(false); }
  }
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

          {(canManage || canEditLocalStatus || (serverManaged && canEditSharedStatus)) && <div className="flex flex-wrap gap-2 mt-3 items-center">
            {canManage && <button type="button" disabled={serverManaged && !canEditSharedFields} title={serverManaged && !canEditSharedFields ? 'Сначала подтвердите устройство начальника или мастера' : 'Edit task'} onClick={onEdit} className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs hover:bg-slate-600">Редактировать</button>}
            <label className="text-slate-400 text-xs" htmlFor={`status-${task.id}`}>Статус</label>
            <select id={`status-${task.id}`} aria-label="Статус задания" disabled={updating || (serverManaged && !canEditSharedStatus)} value={task.status} onChange={event => void changeStatus(event.target.value as TaskStatus)} className="bg-slate-700 border border-slate-600 text-white rounded-lg px-2 py-1.5 text-xs">
              {Object.entries(STATUS_CONFIG).map(([status, config]) => <option key={status} value={status}>{config.label}</option>)}
            </select>
          </div>}
          {serverManaged && <p className="text-amber-300 text-xs mt-2">{canEditSharedStatus ? 'Серверное задание: изменения сохраняются офлайн и будут отправлены при ручной синхронизации.' : 'Серверное задание: для редактирования подтвердите Android-устройство в разделе синхронизации.'}</p>}
          {statusError && <p role="alert" className="text-red-300 text-xs mt-2">{statusError}</p>}
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

function CreateTaskModal({ onClose, creatorId, users, initialTask, canCreateShared = false }: { onClose: () => void; creatorId: string; users: Array<{id:string;fullName:string;isActive:boolean}>; initialTask?: StoredTask; canCreateShared?: boolean }) {
  const [title, setTitle] = useState(initialTask?.title ?? '');
  const [description, setDescription] = useState(initialTask?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(initialTask?.priority ?? TaskPriority.MEDIUM);
  const [assignee, setAssignee] = useState(initialTask?.assignedTo ?? '');
  const [createShared, setCreateShared] = useState(false);
  const [sharedAssigneeId, setSharedAssigneeId] = useState('');
  const [sharedWorkshopId, setSharedWorkshopId] = useState('');
  const managedRevision = useLiveQuery(async () => initialTask ? db.hybridTaskRevisions.get(initialTask.id) : undefined, [initialTask?.id]);
  const managedQueued = useLiveQuery(async () => initialTask ? db.hybridTaskOutbox.where('entityId').equals(initialTask.id).count() : 0, [initialTask?.id]);
  const serverManaged = Boolean(managedRevision || managedQueued);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function createTask() {
    if (!title.trim()) { setError('Введите название задания'); return; }
    setSaving(true); setError('');
    try {
      const now = new Date();
      const task: StoredTask = {
        ...initialTask,
        id: initialTask?.id ?? crypto.randomUUID(), title: title.trim(), description: description.trim(),
        priority, status: initialTask?.status ?? (assignee ? TaskStatus.ASSIGNED : TaskStatus.CREATED),
        assignedTo: assignee, createdBy: initialTask?.createdBy ?? creatorId, createdAt: initialTask?.createdAt ?? now, updatedAt: now,
        comments: initialTask?.comments ?? [], attachments: initialTask?.attachments ?? [],
      };
      if (!initialTask && createShared) {
        await createServerManagedTask({
          title: title.trim(), description: description.trim(), priority,
          assignedTo: sharedAssigneeId.trim(), workshopId: sharedWorkshopId.trim(),
        });
      } else if (initialTask && serverManaged) {
        // Never send locally seeded demo assignee IDs to the shared server:
        // editing a shared assignment needs a separate server-user picker.
        const lease = await requireOfflineTaskEditLease();
        if (lease.role === 'worker') throw new Error('Работник может менять только статус назначенного задания');
        await editServerManagedTask(initialTask.id, {
          title: title.trim(), description: description.trim(), priority,
        });
      } else if (initialTask) {
        await db.transaction('rw', db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox, async () => {
          const revision = await db.hybridTaskRevisions.get(initialTask.id);
          const queued = await db.hybridTaskOutbox.where('entityId').equals(initialTask.id).count();
          if (revision || queued) throw new Error('Server-managed tasks require device verification');
          await db.tasks.put(task);
        });
      } else await db.tasks.add(task);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить задание'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-800 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">{initialTask ? 'Редактировать задание' : 'Новое задание'}</h2>
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
              {serverManaged ? (
                <p className="text-slate-400 text-xs break-all rounded-lg p-2 bg-slate-700/50">
                  {initialTask?.assignedTo || 'Не назначен'} (изменение назначения пока недоступно)
                </p>
              ) : createShared ? (
                <input value={sharedAssigneeId} onChange={event => setSharedAssigneeId(event.target.value)}
                  placeholder="UUID пользователя сервера (необязательно)"
                  className="w-full rounded-lg bg-slate-700 text-white p-2 text-xs" />
              ) : (
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-700/50 border border-slate-600/50 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                >
                  <option value="">Выберите...</option>
                  {users.filter(user => user.isActive).map(user => <option key={user.id} value={user.id}>{user.fullName}</option>)}
                </select>
              )}
            </div>
          </div>

          {!initialTask && canCreateShared && <label className="flex items-center gap-2 text-slate-200 text-sm">
            <input type="checkbox" checked={createShared} onChange={event => setCreateShared(event.target.checked)} />
            Создать серверное задание (отправка при ручной синхронизации)
          </label>}
          {!initialTask && createShared && <label className="block text-slate-300 text-sm">
            Участок (код из сервера)
            <input value={sharedWorkshopId} maxLength={120} onChange={event => setSharedWorkshopId(event.target.value)}
              placeholder="assembly" className="mt-1 w-full rounded-lg bg-slate-700 p-2 text-white" />
            <span className="text-xs text-slate-400">Для мастера и заданий с исполнителем участок обязателен. Исполнитель указывается UUID пользователя сервера.</span>
          </label>}
          {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
          <p className="text-slate-400 text-xs">{serverManaged || createShared ? 'Задание сохраняется в локальной очереди и отправляется при ручной синхронизации.' : 'Локальное задание сохраняется только на этом устройстве.'}</p>
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-medium transition"
            >
              Отмена
            </button>
            <button
              onClick={createTask}
              disabled={saving}
              className="flex-1 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition shadow-lg shadow-blue-500/20"
            >
              {saving ? 'Сохранение...' : initialTask ? 'Сохранить' : 'Создать'}
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
