import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { useAuthStore } from '../../core/store/authStore';
import { recordedTotal, displayRecordedTotal, recordedTotalNote } from '../../core/manufacturing/recordedTotals';
import { TaskStatus, UserRole } from '../../core/types';

/** Local data summary only. No fabricated plan adherence, output or KPI ratings. */
export function ReportsModule(){
  const actor=useAuthStore(s=>s.currentUser);
  const data=useLiveQuery(async()=>{
    const [tasks,journal,formations,users]=await Promise.all([
      listVisibleTasks(),db.journal.toArray(),db.formationRuns.toArray(),db.users.toArray(),
    ]);
    return {tasks,journal,formations,users};
  },[]);
  if(!actor || ![UserRole.CHIEF,UserRole.MASTER].includes(actor.role))
    return <p className="text-red-200">Отчёты недоступны для вашей роли.</p>;
  if(!data)return <p className="text-slate-400" role="status">Читаем локальные записи…</p>;
  const done=data.tasks.filter(t=>t.status===TaskStatus.COMPLETED);
  const total=data.tasks.length;
  const finishedToday=done.filter(t=>
    new Date(t.updatedAt).toDateString()===new Date().toDateString()).length;
  const now=new Date();
  const days=Array.from({length:7},(_,index)=>{
    const date=new Date(now.getFullYear(),now.getMonth(),now.getDate()-6+index);
    const key=date.toDateString();
    return {key,label:date.toLocaleDateString('ru-RU',{weekday:'short',day:'numeric'}),
      count:done.filter(t=>new Date(t.updatedAt).toDateString()===key).length};
  });
  const max=Math.max(1,...days.map(d=>d.count));
  const recentJournal=[...data.journal].sort((a,b)=>
    new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()).slice(0,10);
  const formed=recordedTotal(data.formations.map(record=>record.cellsOut),true);
  const userRows=data.users.filter(user=>user.isActive)
    .map(user=>({...user,assigned:data.tasks.filter(t=>t.assignedTo===user.id).length,
      completed:done.filter(t=>t.assignedTo===user.id).length}));
  return <section className="space-y-5">
    <div>
      <h1 className="text-xl font-bold text-white">Отчёты по локальным данным</h1>
      <p className="text-sm text-slate-400">Только сохранённые на данном устройстве записи.
        Это не сводный отчёт PostgreSQL и не подтверждённый выпуск склада.</p>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ['Доступных заданий',total],
        ['Завершённых заданий',done.length],
        ['Завершено сегодня',finishedToday],
        ['Заявленный выход формовки, шт.',displayRecordedTotal(formed)],
      ].map(([label,value])=><div key={label} className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <p className="text-xs text-slate-400">{label}</p>
        <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      </div>)}
    </div>
    <p className="text-xs text-slate-400">Формовка: {recordedTotalNote(formed)}. —: нет значения; + ?: частичный итог. Пустые исторические поля не считаются нулём.</p>
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
      <h2 className="mb-3 font-semibold text-white">Завершённые задачи за 7 дней</h2>
      <p className="mb-3 text-xs text-slate-400">
        По дате последнего изменения статуса, без выдуманных норм смены.</p>
      {done.length===0 && <p className="text-sm text-slate-400">Нет завершённых заданий.</p>}
      <div className="space-y-2">
        {days.map(day=><div key={day.key} className="flex items-center gap-2">
          <span className="w-16 text-xs text-slate-400">{day.label}</span>
          <div className="h-5 flex-1 rounded bg-slate-700">
            <div className="h-full rounded bg-blue-500"
              style={{width:(day.count/max*100)+'%'}}/>
          </div>
          <span className="w-7 text-right text-xs text-slate-200">{day.count}</span>
        </div>)}
      </div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800 p-4">
        <h2 className="font-semibold text-white">Задания сотрудников</h2>
        {userRows.length===0?<p className="text-sm text-slate-400">Нет сотрудников.</p>:
          userRows.map(user=><div key={user.id} className="flex justify-between gap-2 text-sm text-slate-200">
            <span>{user.fullName}</span>
            <span className="text-slate-400">{user.completed}/{user.assigned} завершено</span>
          </div>)}
      </section>
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800 p-4">
        <h2 className="font-semibold text-white">Последние записи работ</h2>
        {recentJournal.length===0?<p className="text-sm text-slate-400">
          Записей пока нет.</p>:recentJournal.map(entry=><p key={entry.id} className="text-sm text-slate-200">
            {entry.summary||'Запись без описания'} · {new Date(entry.createdAt).toLocaleDateString('ru-RU')}
          </p>)}
      </section>
    </div>
    <p className="text-xs text-slate-400">Сумма выхода формовки — сумма заявленных полей
      сохранённых записей за всё время, без подтверждения завершения процесса, проверки дублей, статуса контроля качества или прихода на склад.</p>
  </section>;
}

export default ReportsModule;
