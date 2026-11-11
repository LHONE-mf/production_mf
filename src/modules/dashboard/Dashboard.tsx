import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import { useAuthStore } from '../../core/store/authStore';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { useServerConnection } from '../../core/sync/serverConnection';
import { TaskStatus, UserRole, type Task } from '../../core/types';
import { ROLE_LABELS } from '../../core/permissions';

const statusNames:Record<TaskStatus,string>={
  created:'Создано',assigned:'Назначено',in_progress:'В работе',
  checked:'На проверке',completed:'Завершено',rejected:'Отклонено',
};
const isOpen=(t:Task)=>t.status!==TaskStatus.COMPLETED&&t.status!==TaskStatus.REJECTED;
const isToday=(date:unknown)=>date && new Date(date as string).toDateString()===new Date().toDateString();
const statsCard=(title:string,value:number|string,description:string)=><div key={title}
  className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
  <p className="text-sm text-slate-300">{title}</p>
  <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
  <p className="text-xs text-slate-400">{description}</p>
</div>;

/** No fictitious employees, shifts, equipment status or production output. */
export function Dashboard(){
  const user=useAuthStore(s=>s.currentUser);
  const server=useServerConnection();
  const data=useLiveQuery(async()=>{
    const [tasks,users,techCards,devices]=await Promise.all([
      listVisibleTasks(),db.users.toArray(),db.techCards.toArray(),db.syncDevices.toArray(),
    ]);
    return {tasks,users,techCards,devices};
  },[]);
  if(!user)return null;
  if(!data)return <p role="status" className="text-slate-300">Загружаем показатели из базы…</p>;
  const tasks=user.role===UserRole.WORKER
    ? data.tasks.filter(t=>t.assignedTo===user.id):data.tasks;
  const finished=tasks.filter(t=>t.status===TaskStatus.COMPLETED);
  const todayCompleted=finished.filter(t=>isToday(t.updatedAt)).length;
  const active=tasks.filter(isOpen).length;
  const overdue=tasks.filter(t=>isOpen(t)&&t.dueDate&&new Date(t.dueDate).getTime()<Date.now()).length;
  const team=data.users.filter(u=>u.isActive && u.assignedMasterId===user.id);
  const activeUsers=data.users.filter(u=>u.isActive);
  const cards=user.role===UserRole.CHIEF?[
    ['Локальных сотрудников',activeUsers.length,'Активные локальные профили'],
    ['Активных заданий',active,'Из доступных вам задач'],
    ['Завершено сегодня',todayCompleted,'По последнему обновлению задачи'],
    ['Просрочено',overdue,'Срок задачи уже прошёл'],
  ]:user.role===UserRole.MASTER?[
    ['Работников в команде',team.length,'С локальным назначением мастера'],
    ['Активных заданий',active,'Из доступных вам задач'],
    ['Завершено сегодня',todayCompleted,'Из доступных вам задач'],
    ['Зарегистрированных устройств',data.devices.length,'Локальные записи, не статус mesh-сети'],
  ]:user.role===UserRole.TECHNOLOGIST?[
    ['Локальных техкарт',data.techCards.length,'На этом устройстве'],
    ['Активных заданий',active,'Из доступных вам задач'],
    ['Завершено сегодня',todayCompleted,'Из доступных вам задач'],
    ['Просрочено',overdue,'Из доступных вам задач'],
  ]:[
    ['Мои задания',tasks.length,'Назначены этому работнику'],
    ['В работе',tasks.filter(t=>t.status===TaskStatus.IN_PROGRESS).length,'Выполняются сейчас'],
    ['Завершено сегодня',todayCompleted,'Мои задания'],
    ['Просрочено',overdue,'Мои задания'],
  ];
  const recent=[...tasks].sort((a,b)=>
    new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime()).slice(0,8);
  return <main className="space-y-5">
    <div>
      <h1 className="text-xl font-bold text-white">Добро пожаловать, {user.fullName}</h1>
      <p className="text-sm text-slate-400">{ROLE_LABELS[user.role]} · Локальные данные устройства ·
        {' '}{server?'Серверная сессия активна':'Нет серверной сессии'}</p>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map(([title,value,note])=>statsCard(String(title),value,String(note)))}
    </div>
    {user.role===UserRole.MASTER && <section className="space-y-2 rounded-xl bg-slate-800/70 p-4">
      <h2 className="font-semibold text-white">Моя команда</h2>
      {team.length===0?<p className="text-sm text-slate-400">
        Сотрудники пока не назначены вашему локальному профилю.</p>:
        team.map(member=><p className="text-sm text-slate-200" key={member.id}>
          {member.fullName} · {ROLE_LABELS[member.role]}</p>)}
    </section>}
    {user.role===UserRole.TECHNOLOGIST && <section className="space-y-2 rounded-xl bg-slate-800/70 p-4">
      <h2 className="font-semibold text-white">Локальные технологические карты</h2>
      {data.techCards.length===0?<p className="text-sm text-slate-400">
        Технологические карты пока не внесены.</p>:
        data.techCards.slice(0,10).map(card=><p className="text-sm text-slate-200" key={card.id}>{card.name}</p>)}
    </section>}
    <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/70 p-4">
      <h2 className="font-semibold text-white">
        {user.role===UserRole.WORKER?'Мои задания':'Последние доступные задания'}
      </h2>
      {recent.length===0?<p className="text-sm text-slate-400">
        Заданий пока нет. Никакие демонстрационные задания не созданы.</p>:
        recent.map(task=><div className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-950/50 p-3"
          key={task.id}>
          <p className="text-sm text-white">{task.title}</p>
          <span className="text-xs text-slate-300">{statusNames[task.status]}</span>
          {task.dueDate && <span className="text-xs text-slate-400">
            Срок: {new Date(task.dueDate).toLocaleDateString('ru-RU')}</span>}
        </div>)}
    </section>
  </main>;
}

export default Dashboard;
