import React, { useState } from 'react';
import { AuthService } from '../services/AuthService';
import { useAuthStore } from '../../../core/store/authStore';
import { restoreLocalBackup } from '../../../core/db/localBackup';

/** Local-only setup: shared accounts and workshop membership require
 * independent server provisioning before M1/M2 can be used online. */
export function FirstRunSetup(){
  const [fullName,setFullName]=useState('');
  const [login,setLogin]=useState('');
  const [password,setPassword]=useState('');
  const [repeat,setRepeat]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const restore=async(event:React.ChangeEvent<HTMLInputElement>)=>{
    const input=event.currentTarget;
    const file=input.files?.[0];
    if(!file||busy)return;
    setBusy(true);setError('');
    try{
      if(file.size>80_000_000)throw new Error('Файл слишком велик');
      await restoreLocalBackup(await file.text());
      // Restored profiles must authenticate with their original local password.
      useAuthStore.getState().logout();
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Не удалось восстановить резервную копию');
    }finally{setBusy(false);input.value='';}
  };
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(busy)return;
    if(password!==repeat){setError('Пароли не совпадают');return;}
    setBusy(true);setError('');
    try{
      const user=await AuthService.createFirstLocalAdmin({fullName,login,password});
      useAuthStore.getState().login(user);
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Не удалось создать пользователя');
    }finally{setBusy(false);}
  };
  return <main className="min-h-screen bg-slate-900 p-4 flex items-center justify-center">
    <section className="w-full max-w-md space-y-4 rounded-xl border border-slate-700 bg-slate-800 p-5">
      <h1 className="text-xl font-semibold text-white">Первый запуск Production MF</h1>
      <p className="text-sm text-slate-300">
        Локальная база пуста. Создайте первого начальника производства.
        Это учётная запись только на данном устройстве, не серверный пользователь.
        Реальные партии, рецепты и задания будут появляться по мере их внесения.
      </p>
      <form className="space-y-3" onSubmit={event=>void save(event)}>
        <label className="block text-sm text-slate-200">Имя
          <input required minLength={2} maxLength={120} autoComplete="name"
            className="mt-1 w-full rounded-lg bg-slate-900 p-3 text-white"
            value={fullName} onChange={event=>setFullName(event.target.value)} />
        </label>
        <label className="block text-sm text-slate-200">Логин (латиница, цифры, ._-)
          <input required minLength={3} maxLength={40} autoComplete="username"
            className="mt-1 w-full rounded-lg bg-slate-900 p-3 text-white"
            value={login} onChange={event=>setLogin(event.target.value)} />
        </label>
        <label className="block text-sm text-slate-200">Пароль (от 10 символов)
          <input required type="password" minLength={10} autoComplete="new-password"
            className="mt-1 w-full rounded-lg bg-slate-900 p-3 text-white"
            value={password} onChange={event=>setPassword(event.target.value)} />
        </label>
        <label className="block text-sm text-slate-200">Повторите пароль
          <input required type="password" minLength={10} autoComplete="new-password"
            className="mt-1 w-full rounded-lg bg-slate-900 p-3 text-white"
            value={repeat} onChange={event=>setRepeat(event.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
        <button type="submit" disabled={busy}
          className="w-full rounded-lg bg-blue-600 p-3 font-medium text-white disabled:opacity-40">
          {busy?'Создаём профиль…':'Создать локальный профиль'}
        </button>
      </form>
      <details className="border-t border-slate-700 pt-4 text-sm text-slate-200">
        <summary className="cursor-pointer font-medium">Восстановить локальные данные из файла</summary>
        <p className="mt-2 text-slate-300">
          Только для полностью пустой базы этой же версии приложения.
          Выберите собственный JSON-архив Production MF. Учетные записи и записи
          восстановятся вместе; войдите со старым локальным паролем.
          Серверные задания и разрешения синхронизации автоматически не восстанавливаются.
        </p>
        <input aria-label="Выбрать резервную копию" type="file" accept=".json,application/json"
          disabled={busy} onChange={event=>void restore(event)}
          className="mt-3 block w-full text-sm text-white file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:p-2 file:text-white disabled:opacity-50"/>
      </details>
    </section>
  </main>;
}
