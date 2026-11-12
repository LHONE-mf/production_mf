import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Edit2, UserX, UserCheck } from 'lucide-react';
import { db } from '../../core/db';
import { exportLocalBackup, inspectLocalBackup } from '../../core/db/localBackup';
import type { LocalBackupInspection } from '../../core/db/localBackup';
import { User, UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { AuthService } from '../auth/services/AuthService';
import { ROLE_LABELS, ROLE_COLORS } from '../../core/permissions';

const inputClass='w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white';
type Draft={fullName:string;login:string;password:string;role:UserRole};
const emptyDraft=():Draft=>({fullName:'',login:'',password:'',role:UserRole.WORKER});

/** Local employee directory, not the separate server workshop membership list. */
export function UsersModule(){
  const currentUser=useAuthStore(s=>s.currentUser);
  const users=useLiveQuery(()=>db.users.toArray(),[]);
  const [search,setSearch]=useState('');
  const [roleFilter,setRoleFilter]=useState<UserRole|'all'>('all');
  const [editing,setEditing]=useState<User|null|'new'>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [backupBusy,setBackupBusy]=useState(false);
  const [backupNote,setBackupNote]=useState('');
  const [inspection,setInspection]=useState<LocalBackupInspection|null>(null);
  const [inspectionError,setInspectionError]=useState('');
  const [inspectionBusy,setInspectionBusy]=useState(false);
  async function saveBackup(){
    if(backupBusy||!window.confirm(
      'Архив содержит пользователей, хеши локальных паролей и производственные записи. Сохраните его в защищённом месте вне телефона. Продолжить?'
    ))return;
    setBackupBusy(true);setBackupNote('');setError('');
    try{
      const archive=await exportLocalBackup();
      const filename='production-mf-local-'+new Date().toISOString().slice(0,10)+'.json';
      const file=new File([archive],filename,{type:'application/json'});
      if(navigator.canShare?.({files:[file]})){
        await navigator.share({files:[file],title:'Резервная копия Production MF'});
      }else{
        const url=URL.createObjectURL(file);
        const link=document.createElement('a');
        link.href=url;link.download=filename;document.body.appendChild(link);
        link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),60_000);
      }
      setBackupNote('Копия подготовлена. Убедитесь, что файл действительно сохранён вне телефона. Без проверки восстановления выпуск для реального производства запрещён.');
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Не удалось подготовить резервную копию');
    }finally{setBackupBusy(false);}
  }

  async function inspectSavedBackup(event:React.ChangeEvent<HTMLInputElement>){
    const input=event.currentTarget;
    const file=input.files?.[0];
    if(!file||inspectionBusy)return;
    setInspectionBusy(true);setInspection(null);setInspectionError('');
    try{
      if(file.size>80_000_000)throw new Error('Файл слишком велик для проверки на устройстве');
      setInspection(await inspectLocalBackup(await file.text()));
    }catch(cause){
      setInspectionError(cause instanceof Error?cause.message:'Не удалось прочитать файл резервной копии');
    }finally{
      setInspectionBusy(false);
      input.value='';
    }
  }

  if(currentUser?.role!==UserRole.CHIEF)
    return <p className="text-red-200">Управление сотрудниками доступно начальнику производства.</p>;

  const all=users??[];
  const filtered=all.filter(u=>
    (roleFilter==='all'||u.role===roleFilter) &&
    (u.login.toLowerCase().includes(search.toLowerCase()) ||
     u.fullName.toLowerCase().includes(search.toLowerCase())));
  const activeChiefCount=all.filter(u=>u.isActive&&u.role===UserRole.CHIEF).length;
  async function toggleUser(user:User){
    if(user.id===currentUser!.id){setError('Нельзя отключить собственную учётную запись');return;}
    if(user.isActive && user.role===UserRole.CHIEF && activeChiefCount<=1){
      setError('Нельзя отключить последнего начальника');return;
    }
    if(!window.confirm(user.isActive
      ? 'Отключить локальный доступ сотрудника '+user.fullName+'?'
      : 'Восстановить локальный доступ сотрудника '+user.fullName+'?'))return;
    setError('');setBusy(true);
    try{
      await AuthService.updateUser(user.id,{isActive:!user.isActive});
    }catch(cause){setError(cause instanceof Error?cause.message:'Ошибка изменения сотрудника');}
    finally{setBusy(false);}
  }
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-white">Сотрудники</h1>
        <p className="text-sm text-slate-400">Локальные профили на устройстве · {all.length} записей</p>
      </div>
      <button type="button" className="flex items-center gap-2 rounded-lg bg-blue-600 p-2.5 text-white"
        onClick={()=>{setError('');setEditing('new');}}>
        <Plus size={18}/> Добавить сотрудника
      </button>
    </div>
    <div className="rounded-xl border border-amber-600/40 bg-slate-800 p-3 space-y-2">
      <p className="text-sm font-semibold text-white">Резервная копия данных этого устройства</p>
      <p className="text-xs text-slate-300">
        Экспорт всех локальных таблиц для восстановления на чистой установке той же версии.
        Копия не защищена отдельным паролем: храните её в закрытом месте.
        Импорт серверных заданий и действующих разрешений заблокирован.
      </p>
      <button type="button" disabled={backupBusy} onClick={()=>void saveBackup()}
        className="rounded-lg bg-amber-700 px-4 py-2 text-sm text-white disabled:opacity-40">
        {backupBusy?'Подготовка архива…':'Создать резервную копию'}
      </button>
      {backupNote&&<p role="status" className="text-xs text-amber-200">{backupNote}</p>}
      <div className="border-t border-slate-600 pt-3 space-y-2">
        <label className="block text-sm font-semibold text-slate-100" htmlFor="verify-local-backup">
          Проверить сохранённый файл резервной копии
        </label>
        <p className="text-xs text-slate-300">
          Выберите ранее сохранённый JSON-файл. Приложение проверит его формат,
          целостность и совместимость, не изменяя текущие записи.
        </p>
        <input id="verify-local-backup" type="file" accept=".json,application/json"
          disabled={inspectionBusy||backupBusy} onChange={event=>void inspectSavedBackup(event)}
          className="block w-full text-sm text-white file:mr-3 file:rounded-lg file:border-0 file:bg-slate-600 file:px-3 file:py-2 file:text-white disabled:opacity-50" />
        {inspectionBusy&&<p role="status" className="text-xs text-slate-300">Проверяем архив…</p>}
        {inspectionError&&<p role="alert" className="text-xs text-red-200">Проверка не пройдена: {inspectionError}</p>}
        {inspection&&<p role="status" className="text-xs text-green-200">
          Файл прошёл проверку целостности и формата. Создан: {new Date(inspection.createdAt).toLocaleString('ru-RU')}.
          Таблиц: {inspection.tableCount}; записей: {inspection.recordCount}; пользователей: {inspection.userCount}.
        </p>}
        <p className="text-xs text-slate-400">
          Это проверка файла, а не пробное восстановление. Перенос данных всё равно
          нужно проверить на отдельной пустой установке.
        </p>
      </div>
    </div>
    <p className="text-xs text-slate-400">Профили здесь не создают пользователей PostgreSQL и не
      назначают права на серверные производственные партии.</p>
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <label className="flex-1 min-w-[12rem]">
        <span className="sr-only">Поиск сотрудников</span>
        <span className="relative block">
          <Search size={17} className="absolute left-3 top-3 text-slate-400"/>
          <input className={inputClass+' pl-9'} placeholder="Поиск сотрудников"
            value={search} onChange={e=>setSearch(e.target.value)}/>
        </span>
      </label>
      <select aria-label="Роль сотрудника" className={inputClass+' w-auto'}
        value={roleFilter} onChange={e=>setRoleFilter(e.target.value as UserRole|'all')}>
        <option value="all">Все роли</option>
        {Object.values(UserRole).map(role=><option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
      </select>
    </div>
    {users===undefined && <p className="text-sm text-slate-400">Загружаем сотрудников…</p>}
    {users!==undefined && all.length===0 &&
      <p className="text-slate-400">Пользователей пока нет.</p>}
    {users!==undefined && filtered.length===0 && all.length>0 &&
      <p className="text-slate-400">По фильтру ничего не найдено.</p>}
    <div className="grid gap-3 md:grid-cols-2">
      {filtered.map(user=><article key={user.id} className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`rounded-lg p-2 text-white ${ROLE_COLORS[user.role]}`}>
              {user.fullName.slice(0,1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{user.fullName}</p>
              <p className="truncate text-xs text-slate-400">@{user.login}</p>
              <p className="text-xs text-slate-400">{ROLE_LABELS[user.role]} · {user.isActive?'Активен':'Отключён'}</p>
            </div>
          </div>
          <div className="flex gap-1">
            <button type="button" aria-label={'Редактировать '+user.login} title="Редактировать"
              className="rounded p-2 text-slate-200 hover:bg-slate-700"
              onClick={()=>{setError('');setEditing(user);}}><Edit2 size={17}/></button>
            <button type="button" aria-label={(user.isActive?'Отключить ':'Включить ')+user.login}
              disabled={busy || user.id===currentUser.id}
              className="rounded p-2 text-slate-200 hover:bg-slate-700 disabled:opacity-30"
              onClick={()=>void toggleUser(user)}>
              {user.isActive?<UserX size={17}/>:<UserCheck size={17}/>}
            </button>
          </div>
        </div>
      </article>)}
    </div>
    {editing!==null && <UserEditor user={editing==='new'?null:editing}
      actorId={currentUser.id} activeChiefCount={activeChiefCount}
      onClose={()=>setEditing(null)}/>}
  </section>;
}

function UserEditor({user,actorId,activeChiefCount,onClose}:{
  user:User|null;actorId:string;activeChiefCount:number;onClose:()=>void;
}){
  const [draft,setDraft]=useState<Draft>(user?{
    fullName:user.fullName,login:user.login,password:'',role:user.role,
  }:emptyDraft);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy)return;
    if(user?.id===actorId && draft.role!==UserRole.CHIEF){
      setError('Нельзя изменить свою роль');return;
    }
    if(user?.role===UserRole.CHIEF && draft.role!==UserRole.CHIEF && activeChiefCount<=1){
      setError('Нельзя изменить роль последнего начальника');return;
    }
    if(!user && draft.password.length<10){
      setError('Пароль должен содержать не менее 10 символов');return;
    }
    setBusy(true);setError('');
    try{
      if(user)await AuthService.updateUser(user.id,{
        fullName:draft.fullName,login:draft.login,role:draft.role,
        ...(draft.password?{password:draft.password}:{}),
      });
      else await AuthService.createUser({
        fullName:draft.fullName,login:draft.login,role:draft.role,
        password:draft.password,isActive:true,
      });
      onClose();
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Не удалось сохранить сотрудника');
    }finally{setBusy(false);}
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <section className="w-full max-w-lg space-y-4 rounded-xl border border-slate-600 bg-slate-800 p-4">
      <h2 className="text-lg font-semibold text-white">{user?'Редактировать сотрудника':'Новый сотрудник'}</h2>
      <form className="space-y-3" onSubmit={event=>void submit(event)}>
        <label className="block text-sm text-slate-200">Имя
          <input required minLength={2} maxLength={120} className={inputClass+' mt-1'}
            value={draft.fullName} onChange={e=>setDraft(previous=>({...previous,fullName:e.target.value}))}/>
        </label>
        <label className="block text-sm text-slate-200">Логин
          <input required minLength={3} maxLength={40} className={inputClass+' mt-1'}
            value={draft.login} autoComplete="off"
            onChange={e=>setDraft(previous=>({...previous,login:e.target.value}))}/>
        </label>
        <label className="block text-sm text-slate-200">{user?'Новый пароль (необязательно)':'Пароль (от 10 символов)'}
          <input type="password" minLength={10} required={!user}
            className={inputClass+' mt-1'} value={draft.password}
            autoComplete="new-password" onChange={e=>setDraft(previous=>({...previous,password:e.target.value}))}/>
        </label>
        <label className="block text-sm text-slate-200">Роль
          <select className={inputClass+' mt-1'} value={draft.role}
            onChange={e=>setDraft(previous=>({...previous,role:e.target.value as UserRole}))}>
            {Object.values(UserRole).map(role=><option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onClose}
            className="flex-1 rounded-lg bg-slate-700 p-2 text-white">Отмена</button>
          <button type="submit" disabled={busy}
            className="flex-1 rounded-lg bg-blue-600 p-2 text-white disabled:opacity-40">
            {busy?'Сохраняем…':'Сохранить'}
          </button>
        </div>
      </form>
    </section>
  </div>;
}

export default UsersModule;
