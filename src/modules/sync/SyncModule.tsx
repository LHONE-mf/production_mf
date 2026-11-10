import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { androidDevicePublicKey, authenticateAndroidDevice } from '../../core/sync/androidDeviceProof';
import { requireFreshDeviceProof } from '../../core/sync/deviceProofClient';
import { useLiveQuery } from 'dexie-react-hooks';
import { RefreshCw, ShieldCheck, AlertCircle, WifiOff } from 'lucide-react';
import { IngestPanel } from '../../transfer/IngestPanel';
import { db } from '../../core/db';
import { pushAtomicTasks, pullAtomicTasks } from '../../core/sync/atomicClient';
import { archiveConflictAndUseServer, archiveRejectedTaskAndUseServer } from '../../core/sync/taskConflictResolution';
import type { TaskPayloadV1 } from '../../core/sync/taskDto';
import type { HybridSession } from '../../core/sync/hybridClient';
import { assertSyncTenant } from '../../core/sync/tenantGuard';

function serverEndpoint(origin: string, path: string) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Для сервера требуется HTTPS (кроме localhost)');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Введите только адрес сервера без пути и параметров');
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
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [myDevices, setMyDevices] = useState<string[]>([]);
  const [serverRole, setServerRole] = useState('');
  const [remoteTasks, setRemoteTasks] = useState<Record<string, { revision: number; payload: TaskPayloadV1 }>>({});
  const [inspectingTask, setInspectingTask] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useLiveQuery(() => db.hybridTaskOutbox.where('state').equals('pending').count(), []);
  const conflictOperations = useLiveQuery(() => db.hybridTaskOutbox.where('state').equals('conflict').toArray(), []);
  const conflicts = conflictOperations?.length;
  const rejectedOperations = useLiveQuery(() => db.hybridTaskOutbox.where('state').equals('rejected').toArray(), []);
  const rejected = rejectedOperations?.length;
  const archivedConflicts = useLiveQuery(() => db.hybridTaskResolutions.count(), []);
  const archiveHistory = useLiveQuery(() => db.hybridTaskResolutions.orderBy('archivedAt').reverse().limit(10).toArray(), []);
  const conflictingTasks = useLiveQuery(async () => {
    const operations = await db.hybridTaskOutbox.where('state').anyOf('conflict', 'rejected').toArray();
    return Promise.all(operations.map(async operation => ({ operation, task: await db.tasks.get(operation.entityId) })));
  }, []);

  async function connect() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(serverEndpoint(serverUrl, '/auth/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: organizationId.trim(), login: login.trim(), password }),
      });
      if (!response.ok) throw new Error('Вход не выполнен: HTTP ' + response.status);
      const data: { accessToken?: string; user?: { role?: string; organizationId?: string } } = await response.json();
      if (typeof data.accessToken !== 'string' || !data.accessToken.trim()) throw new Error('Сервер не вернул корректный токен доступа');
      if (typeof data.user?.organizationId !== 'string' ||
          data.user.organizationId.toLowerCase() !== organizationId.trim().toLowerCase()) {
        throw new Error('Организация в ответе сервера не совпадает с выбранной');
      }
      await assertSyncTenant(serverUrl, data.user.organizationId);
      const devicesResponse = await fetch(serverEndpoint(serverUrl, '/devices/mine'), {
        headers: { Authorization: 'Bearer ' + data.accessToken },
      });
      let deviceIds: string[] = [];
      if (!devicesResponse.ok) throw new Error('Не удалось получить устройства: HTTP ' + devicesResponse.status);
      {
        const enrolled: { devices?: Array<{ id: string }> } = await devicesResponse.json();
        if (!Array.isArray(enrolled.devices) || !enrolled.devices.every(device => typeof device?.id === 'string')) {
          throw new Error('Сервер вернул некорректный список устройств');
        }
        deviceIds = enrolled.devices.map(device => device.id);
      }
      // Commit the UI session only after all required login checks succeed.
      // A failed device-list response must not leave a half-initialized session.
      setSession({ serverUrl, accessToken: data.accessToken });
      setServerRole(data.user?.role ?? '');
      setEnrolledDeviceId('');
      setSelectedDeviceId('');
      setMyDevices(deviceIds);
      setPassword('');
      setMessage('Подключено. Теперь можно синхронизировать серверные задания.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка подключения'); }
    finally { setBusy(false); }
  }

  async function enrollDevice() {
    if (!session) return;
    setBusy(true); setError(''); setMessage('');
    try {
      // Enrollment is chief-authorized. Only the public key crosses the network.
      const response = await fetch(serverEndpoint(session.serverUrl, '/devices'), {
        method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: devicePublicKey.trim() }),
      });
      if (!response.ok) throw new Error('Регистрация устройства: HTTP ' + response.status);
      const data: { id?: string } = await response.json();
      if (!data.id) throw new Error('Сервер не вернул ID устройства');
      setEnrolledDeviceId(data.id);
      setSelectedDeviceId(data.id);
      setMyDevices(previous => previous.includes(data.id!) ? previous : [...previous, data.id!]);
      setMessage('Устройство зарегистрировано. Для отправки заданий подтвердите владение ключом.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка регистрации устройства'); }
    finally { setBusy(false); }
  }

  async function prepareAndroidKey() {
    setBusy(true); setError(''); setMessage('');
    try {
      if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') throw new Error('Доступно только в Android-приложении');
      setDevicePublicKey(await androidDevicePublicKey());
      setMessage('Публичный ключ получен. Закрытый ключ остаётся в AndroidKeyStore. Администратор может зарегистрировать устройство.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'AndroidKeyStore недоступен'); }
    finally { setBusy(false); }
  }

  async function proveAndroidDevice() {
    if (!session || !selectedDeviceId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') throw new Error('Подтверждение устройства доступно только в Android');
      const proven = await authenticateAndroidDevice(session, selectedDeviceId);
      setSession(proven);
      setMessage('Устройство подтверждено. Можно отправлять задания в течение 5 минут.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Подтверждение устройства не удалось'); }
    finally { setBusy(false); }
  }

  async function inspectConflict(taskId: string) {
    if (!session) { setError('Сначала подключитесь к серверу'); return; }
    setBusy(true); setError('');
    try {
      const proof = requireFreshDeviceProof(session);
      const response = await fetch(serverEndpoint(session.serverUrl, '/sync/task/' + encodeURIComponent(taskId) + '?deviceId=' + encodeURIComponent(proof.deviceId)), {
        headers: { Authorization: 'Bearer ' + session.accessToken, 'x-device-proof': proof.token },
      });
      if (!response.ok) throw new Error('Не удалось получить серверную версию: HTTP ' + response.status);
      const data: { revision: number; payload: TaskPayloadV1 } = await response.json();
      if (!Number.isSafeInteger(data.revision) || data.revision < 1 || !data.payload) throw new Error('Некорректная серверная версия задания');
      setRemoteTasks(previous => ({ ...previous, [taskId]: data }));
      setInspectingTask(taskId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка получения задания'); }
    finally { setBusy(false); }
  }

  async function chooseServerVersion(taskId: string, recovery: 'conflict' | 'rejected' = 'conflict') {
    const inspected = remoteTasks[taskId];
    if (!session || !inspected) { setError('Сначала сравните изменения с сервером'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const proof = requireFreshDeviceProof(session);
      // Fetch the authoritative snapshot again: never accept a stale preview.
      const response = await fetch(serverEndpoint(session.serverUrl, '/sync/task/' +
        encodeURIComponent(taskId) + '?deviceId=' + encodeURIComponent(proof.deviceId)), {
        headers: { Authorization: 'Bearer ' + session.accessToken, 'x-device-proof': proof.token },
      });
      if (!response.ok) throw new Error('Серверная версия недоступна: HTTP ' + response.status);
      const fresh: { revision: number; payload: TaskPayloadV1 } = await response.json();
      if (fresh.revision !== inspected.revision ||
          JSON.stringify(fresh.payload) !== JSON.stringify(inspected.payload)) {
        setRemoteTasks(previous => ({ ...previous, [taskId]: fresh }));
        throw new Error('Задание на сервере изменилось. Сравните версии заново.');
      }
      if (recovery === 'rejected') await archiveRejectedTaskAndUseServer(taskId, fresh.revision, fresh.payload);
      else await archiveConflictAndUseServer(taskId, fresh.revision, fresh.payload);
      setInspectingTask(null);
      setRemoteTasks(previous => {
        const next = { ...previous };
        delete next[taskId];
        return next;
      });
      setMessage('Серверная версия принята. Локальные правки и все операции сохранены в архиве конфликтов на этом устройстве.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка разрешения конфликта'); }
    finally { setBusy(false); }
  }

  async function synchronize() {
    if (!session) return;
    setBusy(true); setError(''); setMessage('');
    try {
      requireFreshDeviceProof(session); // Read-only pulls also require a verified device.
      // One manual tap should drain dependent edits in order, rather than
      // requiring a separate tap for every revision of the same task.
      // Bound network requests to avoid an indefinitely busy screen.
      const pushed = { accepted: 0, conflicts: 0, rejected: 0 };
      for (let batch = 0; batch < 20; batch++) {
        const result = await pushAtomicTasks(session);
        pushed.accepted += result.accepted;
        pushed.conflicts += result.conflicts;
        pushed.rejected += result.rejected;
        if (result.accepted > 0) setMessage('Синхронизация: отправлено ' + pushed.accepted + ' изменений...');
        if (result.accepted === 0) break;
      }
      const outstanding = await db.hybridTaskOutbox.count();
      if (outstanding > 0) {
        // A pull cannot safely overwrite tasks with local queued edits. Finish
        // acknowledged revisions first, or inspect conflicts and rejections.
        setMessage('Отправлено: ' + pushed.accepted + ', конфликты: ' + pushed.conflicts +
          ', отклонено сервером: ' + pushed.rejected + '. Осталось локальных изменений: ' +
          outstanding + '. Получение с сервера отложено: повторите ручную синхронизацию или разрешите конфликт.');
        return;
      }
      let received = 0;
      let hasMore = false;
      for (let page = 0; page < 20; page++) {
        const pulled = await pullAtomicTasks(session);
        received += pulled.received;
        hasMore = pulled.hasMore;
        if (hasMore) setMessage('Синхронизация: отправлено ' + pushed.accepted +
          ', получено ' + received + '. Загружаем следующую страницу...');
        if (!hasMore) break;
        if (pulled.received === 0) {
          throw new Error('Сервер сообщил о дополнительных изменениях, но не вернул ни одного задания');
        }
      }
      setMessage('Отправлено: ' + pushed.accepted + ', получено: ' + received + ', конфликты: ' + pushed.conflicts + ', отклонено сервером: ' + pushed.rejected +
        (hasMore ? '. Есть дополнительные изменения — повторите синхронизацию.' : '.'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка синхронизации'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!session) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(serverEndpoint(session.serverUrl, '/auth/logout'), {
        method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken },
      });
      if (!response.ok) throw new Error('Сервер не подтвердил выход: HTTP ' + response.status);
      setMessage('Серверная сессия завершена');
    } catch (cause) {
      // Never retain a usable bearer token merely because the network is offline.
      setError((cause instanceof Error ? cause.message : 'Ошибка выхода') + '. Локальные учётные данные очищены, но серверная сессия может оставаться активной до истечения срока.');
    } finally {
      setRemoteTasks({}); setInspectingTask(null); setSession(null); setServerRole('');
      setEnrolledDeviceId(''); setSelectedDeviceId(''); setMyDevices([]);
      setDevicePublicKey(''); setPassword(''); setBusy(false);
    }
  }

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
            <div className="rounded-xl border border-slate-600 p-3 space-y-1">
              <p className="text-slate-200 text-sm font-medium">Устройства вашей учётной записи</p>
              {myDevices.length ? myDevices.map(id => <p key={id} className="text-slate-300 text-xs break-all">{id}</p>) : <p className="text-amber-200 text-xs">Активные зарегистрированные устройства не обнаружены.</p>}
              <p className="text-slate-400 text-xs">Регистрация не подтверждает владение закрытым ключом. Перед отправкой заданий требуется отдельная проверка подписи.</p>
              {Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && myDevices.length > 0 && <div className="space-y-2 pt-2">
                <label className="block text-slate-300 text-xs">Устройство для подтверждения
                  <select aria-label="Устройство для подтверждения" value={selectedDeviceId} onChange={event => { setSelectedDeviceId(event.target.value); setSession(previous => previous ? { serverUrl: previous.serverUrl, accessToken: previous.accessToken } : null); }} className="mt-1 w-full bg-slate-700 text-white rounded-lg p-2">
                    <option value="">Выберите устройство</option>
                    {myDevices.map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>
                <button type="button" disabled={busy || !selectedDeviceId} onClick={() => void proveAndroidDevice()} className="px-3 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">Подтвердить устройство</button>
                {session.deviceProofToken && session.deviceProofDeviceId === selectedDeviceId && (session.deviceProofExpiresAt ?? 0) > Date.now() + 5000 && <p className="text-green-300 text-xs">Подпись подтверждена (до 5 минут).</p>}
              </div>}
            </div>
            {serverRole === 'chief' && <div className="space-y-2 rounded-xl border border-slate-600 p-3">
              <p className="text-slate-200 text-sm font-medium">Регистрация устройства (администратор)</p>
              <p className="text-slate-400 text-xs">Зарегистрируйте публичный ключ устройства. Android-приложение может создать ключ в AndroidKeyStore, если провайдер поддерживает Ed25519.</p>
              {Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && <button type="button" disabled={busy} onClick={() => void prepareAndroidKey()} className="px-3 py-2 bg-slate-700 text-white rounded-lg disabled:opacity-50">Получить ключ Android</button>}
              <textarea aria-label="Публичный ключ устройства" value={devicePublicKey} onChange={event => setDevicePublicKey(event.target.value)} placeholder="Публичный ключ устройства" className="w-full rounded-lg bg-slate-700 text-white p-2 text-sm" rows={3} />
              <button type="button" disabled={busy || devicePublicKey.trim().length < 32} onClick={() => void enrollDevice()} className="px-3 py-2 bg-slate-700 text-white rounded-lg disabled:opacity-50">Зарегистрировать устройство</button>
              {enrolledDeviceId && <p className="text-green-300 text-xs break-all">ID устройства: {enrolledDeviceId}</p>}
            </div>}
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={() => void synchronize()} className="flex items-center gap-2 px-4 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-xl">
                <RefreshCw className="w-4 h-4" /> {busy ? 'Синхронизация...' : 'Синхронизировать'}
              </button>
              <button disabled={busy} onClick={() => void disconnect()} className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-xl">Отключиться</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="flex items-start gap-2 text-red-300 text-sm"><AlertCircle className="w-4 h-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="text-green-300 text-sm">{message}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-900/50 rounded-xl p-3"><p className="text-xl text-white font-semibold">{pending ?? '—'}</p><p className="text-slate-400 text-xs">Ожидают отправки</p></div>
          <div className="bg-slate-900/50 rounded-xl p-3"><p className="text-xl text-white font-semibold">{conflicts ?? '—'}</p><p className="text-slate-400 text-xs">Конфликты</p></div>
        </div>
        <p className="text-slate-400 text-sm">Отклонено сервером: {rejected ?? '—'} · Архив конфликтов (сохранено на устройстве): {archivedConflicts ?? '—'}</p>
        {(archiveHistory?.length ?? 0) > 0 && (
          <div className="rounded-xl border border-slate-700 p-3 space-y-2">
            <h3 className="text-white text-sm font-semibold">Архив локальных изменений (только на устройстве)</h3>
            {archiveHistory?.map(record => (
              <details key={record.id} className="rounded-lg bg-slate-900/50 p-3 text-sm">
                <summary className="cursor-pointer text-amber-200">{record.localTask.title} · {new Date(record.archivedAt).toLocaleString()} · {record.localOperations.length} изменений</summary>
                <p className="text-slate-400 text-xs mt-2">Версия сервера: {record.serverRevision} · локальные изменения сохранены, но не отправлены</p>
                <p className="text-slate-300 text-xs mt-2">Локальная версия: {record.localTask.title} · {record.localTask.status}</p>
                <p className="text-slate-400 text-xs whitespace-pre-wrap">{record.localTask.description}</p>
                {record.localOperations.map(operation => (
                  <div key={operation.operationId} className="mt-2 border-l border-slate-600 pl-2">
                    <p className="text-slate-300 text-xs">Локальная правка: {operation.payload.title} · {operation.payload.status}</p>
                    <p className="text-slate-400 text-xs whitespace-pre-wrap">{operation.payload.description}</p>
                  </div>
                ))}
                <p className="text-green-300 text-xs mt-2">Принято с сервера: {record.serverPayload.title} · {record.serverPayload.status}</p>
                <p className="text-slate-400 text-xs whitespace-pre-wrap">{record.serverPayload.description}</p>
              </details>
            ))}
          </div>
        )}
        {(conflictingTasks?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <h3 className="text-white font-semibold text-sm">Задания, требующие внимания</h3>
            {conflictingTasks?.map(({ operation, task }) => (
              <div key={operation.operationId} className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-1">
                <p className="text-white text-sm font-medium">{task?.title || operation.payload.title || operation.entityId}</p>
                <p className="text-amber-200 text-xs">{operation.state === 'rejected' ? 'Сервер отклонил изменение. Исправьте указанную причину перед повторной отправкой.' : 'Конфликт версий. Сравните изменения с сервером.'} Локальная копия сохранена.</p>
                {operation.rejectionReason && <p className="text-red-300 text-xs">Причина отказа: {operation.rejectionReason}</p>}
                <p className="text-slate-400 text-xs">Ожидаемая версия: {operation.expectedRevision ?? '—'} · Версия на сервере: {operation.actualRevision ?? 'неизвестна'}</p>
                <p className="text-slate-500 text-xs break-all">ID операции: {operation.operationId}</p>
                {session && <button disabled={busy} type="button" onClick={() => void inspectConflict(operation.entityId)} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-white disabled:opacity-50">Сравнить с сервером</button>}
                {inspectingTask === operation.entityId && remoteTasks[operation.entityId] && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    <div className="rounded-lg bg-slate-900/60 p-3 space-y-1"><p className="text-blue-300 text-xs font-semibold">На устройстве</p><p className="text-white text-sm">{task?.title}</p><p className="text-slate-300 text-xs whitespace-pre-wrap">{task?.description}</p><p className="text-slate-400 text-xs">{task?.status} · {task?.priority}</p></div>
                    <div className="rounded-lg bg-slate-900/60 p-3 space-y-1"><p className="text-green-300 text-xs font-semibold">На сервере · версия {remoteTasks[operation.entityId].revision}</p><p className="text-white text-sm">{remoteTasks[operation.entityId].payload.title}</p><p className="text-slate-300 text-xs whitespace-pre-wrap">{remoteTasks[operation.entityId].payload.description}</p><p className="text-slate-400 text-xs">{remoteTasks[operation.entityId].payload.status} · {remoteTasks[operation.entityId].payload.priority}</p></div>
                    {operation.state === 'rejected' && <button
                      type="button" disabled={busy}
                      onClick={() => void chooseServerVersion(operation.entityId, 'rejected')}
                      className="rounded-lg border border-amber-400 px-3 py-2 text-xs text-amber-100 disabled:opacity-50"
                    >Архивировать отклонённые правки и принять серверную версию</button>}
                    {operation.state === 'conflict' && <button
                      type="button" disabled={busy}
                      onClick={() => void chooseServerVersion(operation.entityId)}
                      className="rounded-lg border border-amber-400 px-3 py-2 text-xs text-amber-100 disabled:opacity-50"
                    >Принять серверную версию (сохранить все локальные правки в архиве)</button>}
                  </div>
                )}
              </div>
            ))}
            <p className="text-slate-400 text-xs">Автоматическое разрешение конфликтов пока отключено, чтобы не потерять изменения.</p>
          </div>
        )}
        <p className="flex gap-2 text-slate-400 text-xs"><WifiOff className="w-4 h-4 shrink-0" /> Локальные задания не отправляются автоматически. Для серверных заданий требуется зарегистрированное устройство и действующая учётная запись. Подключение к серверу не заменяет офлайн-передачу.</p>
      </div>
      <IngestPanel />
    </div>
  );
}

export { SyncModule as default };
