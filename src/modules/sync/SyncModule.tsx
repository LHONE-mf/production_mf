import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw, ShieldCheck, AlertCircle, WifiOff } from 'lucide-react';
import { IngestPanel } from '../../transfer/IngestPanel';
import { db } from '../../core/db';
import { pushAtomicTasks, pullAtomicTasks } from '../../core/sync/atomicClient';
import type { HybridSession } from '../../core/sync/hybridClient';

function serverEndpoint(origin: string, path: string) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Для сервера требуется HTTPS (кроме localhost)');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Введите только адрес сервера');
  return new URL(path, url).toString();
}

export function SyncModule() {
  const [serverUrl, setServerUrl] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<HybridSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [devicePublicKey, setDevicePublicKey] = useState('');
  const [enrolledDeviceId, setEnrolledDeviceId] = useState('');
  const [serverRole, setServerRole] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useLiveQuery(() => db.hybridTaskOutbox.where('state').equals('pending').count(), []);
  const conflicts = useLiveQuery(() => db.hybridTaskOutbox.where('state').equals('conflict').count(), []);

  async function connect() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(serverEndpoint(serverUrl, '/auth/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: organizationId.trim(), login: login.trim(), password }),
      });
      if (!response.ok) throw new Error('Вход не выполнен: HTTP ' + response.status);
      const data: { accessToken?: string; user?: { role?: string } } = await response.json();
      if (!data.accessToken) throw new Error('Сервер не вернул токен доступа');
      setSession({ serverUrl, accessToken: data.accessToken });
      setServerRole(data.user?.role ?? '');
      setEnrolledDeviceId('');
      setPassword('');
      setMessage('Подключено. Теперь можно синхронизировать серверные задания.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка подключения'); }
    finally { setBusy(false); }
  }

  async function enrollDevice() {
    if (!session) return;
    setBusy(true); setError(''); setMessage('');
    try {
      // The server currently accepts a supplied public key; device signing is not yet implemented.
      // Do not generate a throwaway key that would imply cryptographic device ownership.
      const response = await fetch(serverEndpoint(session.serverUrl, '/devices'), {
        method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: devicePublicKey.trim() }),
      });
      if (!response.ok) throw new Error('Регистрация устройства: HTTP ' + response.status);
      const data: { id?: string } = await response.json();
      if (!data.id) throw new Error('Сервер не вернул ID устройства');
      setEnrolledDeviceId(data.id);
      setMessage('Устройство зарегистрировано. Сохраните его ID и соответствующий закрытый ключ в защищённом хранилище. Автоматическая привязка пока не реализована.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка регистрации устройства'); }
    finally { setBusy(false); }
  }

  async function synchronize() {
    if (!session) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const pushed = await pushAtomicTasks(session);
      const pulled = await pullAtomicTasks(session);
      setMessage('Отправлено: ' + pushed.accepted + ', получено: ' + pulled.received + ', конфликты: ' + pushed.conflicts + ', отклонено сервером: ' + pushed.rejected +
        (pulled.hasMore ? '. Есть дополнительные изменения — повторите синхронизацию.' : '.'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка синхронизации'); }
    finally { setBusy(false); }
  }

  function disconnect() { setSession(null); setServerRole(''); setEnrolledDeviceId(''); setPassword(''); setMessage('Соединение отключено'); setError(''); }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Синхронизация</h1>
        <p className="text-slate-400 text-sm mt-1">Серверная синхронизация заданий — ручное подключение</p>
      </div>
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-white font-semibold"><ShieldCheck className="w-5 h-5 text-blue-400" /> Подключение к серверу</div>
        {!session ? (
          <form onSubmit={event => { event.preventDefault(); void connect(); }} className="space-y-3">
            <label className="block text-sm text-slate-300">Адрес сервера
              <input required type="url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://server.example.com" autoComplete="url" className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-xl p-3 text-white" />
            </label>
            <label className="block text-sm text-slate-300">ID организации (UUID)
              <input required value={organizationId} onChange={event => setOrganizationId(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-xl p-3 text-white" />
            </label>
            <label className="block text-sm text-slate-300">Логин
              <input required value={login} onChange={event => setLogin(event.target.value)} autoComplete="username" className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-xl p-3 text-white" />
            </label>
            <label className="block text-sm text-slate-300">Пароль
              <input required type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" className="mt-1 w-full bg-slate-700 border border-slate-600 rounded-xl p-3 text-white" />
            </label>
            <button disabled={busy} type="submit" className="px-4 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-xl">Подключиться</button>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-green-300 text-sm">Подключено к {new URL(session.serverUrl).host}. Токен хранится только до закрытия экрана.</p>
            {serverRole === 'chief' && <div className="space-y-2 rounded-xl border border-slate-600 p-3">
              <p className="text-slate-200 text-sm font-medium">Регистрация устройства (администратор)</p>
              <p className="text-slate-400 text-xs">Введите публичный ключ существующей пары ключей. Генерация и безопасное хранение закрытого ключа в приложении пока не реализованы.</p>
              <textarea aria-label="Публичный ключ устройства" value={devicePublicKey} onChange={event => setDevicePublicKey(event.target.value)} placeholder="Публичный ключ устройства" className="w-full rounded-lg bg-slate-700 text-white p-2 text-sm" rows={3} />
              <button type="button" disabled={busy || devicePublicKey.trim().length < 32} onClick={() => void enrollDevice()} className="px-3 py-2 bg-slate-700 text-white rounded-lg disabled:opacity-50">Зарегистрировать устройство</button>
              {enrolledDeviceId && <p className="text-green-300 text-xs break-all">ID устройства: {enrolledDeviceId}</p>}
            </div>}
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={() => void synchronize()} className="flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-xl">
                <RefreshCw className="w-4 h-4" /> {busy ? 'Синхронизация...' : 'Синхронизировать'}
              </button>
              <button disabled={busy} onClick={disconnect} className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-xl">Отключиться</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="flex items-start gap-2 text-red-300 text-sm"><AlertCircle className="w-4 h-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="text-green-300 text-sm">{message}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-900/50 rounded-xl p-3"><p className="text-xl text-white font-semibold">{pending ?? '—'}</p><p className="text-slate-400 text-xs">Ожидают отправки</p></div>
          <div className="bg-slate-900/50 rounded-xl p-3"><p className="text-xl text-white font-semibold">{conflicts ?? '—'}</p><p className="text-slate-400 text-xs">Конфликты / отклонённые операции</p></div>
        </div>
        <p className="flex gap-2 text-slate-400 text-xs"><WifiOff className="w-4 h-4 shrink-0" /> Локальные задания не отправляются автоматически. Для серверных заданий требуется зарегистрированное устройство и действующая учётная запись. Подключение к серверу не заменяет офлайн-передачу.</p>
      </div>
      <IngestPanel />
    </div>
  );
}

export { SyncModule as default };
