import React, { useEffect, useRef, useState } from 'react';
import type { HybridSession } from '../../core/sync/hybridClient';
import type { InventoryScope, ReceivingDraft } from '../../core/sync/inventoryOutbox';
import { inventoryLocationPath, type InventoryMaterial, type InventoryLocation, type WarehouseAccess } from '../../core/sync/inventoryCatalogClient';
import { freezeInventoryAdministration, listInventoryAdministration, sendInventoryAdministration, loadWarehouseUsers, type InventoryAdminDraft, type WarehouseUser } from '../../core/sync/inventoryAdministration';

const control = 'block min-h-11 w-full rounded bg-slate-900 p-2';
const button = 'min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50';
const levels = { chief: 'Chief', manager: 'Менеджер склада', operator: 'Оператор склада' };
const parents: Record<InventoryLocation['kind'], InventoryLocation['kind'][]> = { warehouse: [], cabinet: ['warehouse'], rack: ['warehouse'], shelf: ['cabinet', 'rack'], container_area: ['shelf'] };
function summary(row: ReceivingDraft) {
  try {
    const request = JSON.parse(row.fields.request);
    return row.fields.kind === 'material' ? `Материал: ${request.code} · ${request.name} · ${request.baseUnit}` : row.fields.kind === 'location' ? `Место: ${request.label}` : `Доступ сотрудника ${request.userId}: ${request.level === 'manager' ? 'Менеджер склада' : 'Оператор склада'} · ${request.action === 'grant' ? 'Выдать' : 'Отозвать'}`;
  } catch { return 'Повреждённое предложение сохранено для сверки'; }
}
export function StorageAdministration({ scope, session, localActorId, access, materials, locations, onChanged }: {
  scope: InventoryScope; session: HybridSession; localActorId: string; access: WarehouseAccess;
  materials: InventoryMaterial[]; locations: InventoryLocation[]; onChanged: () => void;
}) {
  const [material, setMaterial] = useState({ code: '', name: '', category: 'raw_material' as InventoryMaterial['category'], baseUnit: 'mg' as InventoryMaterial['baseUnit'] });
  const [place, setPlace] = useState({ label: '', kind: 'warehouse' as InventoryLocation['kind'], parentId: '' });
  const [users, setUsers] = useState<WarehouseUser[]>([]), [after, setAfter] = useState<string | null>(null);
  const [target, setTarget] = useState(''), [level, setLevel] = useState<'manager' | 'operator'>('operator'), [action, setAction] = useState<'grant' | 'revoke'>('grant');
  const [intents, setIntents] = useState<ReceivingDraft[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [search, setSearch] = useState('');
  const running = useRef(false), generation = useRef(0);
  useEffect(() => { const run = ++generation.current; void listInventoryAdministration(scope, localActorId).then(rows => { if (run === generation.current) setIntents(rows); }).catch(() => { if (run === generation.current) setError('Не удалось прочитать сохранённые предложения'); }); return () => { generation.current++; }; }, [scope.serverUrl, scope.organizationId, scope.actorId, scope.deviceId, localActorId]);
  if (!access.canManageCatalog) return null;
  async function work(task: () => Promise<void>) {
    if (running.current) return; running.current = true; setBusy(true); setError(''); const run = generation.current;
    try { await task(); if (run === generation.current) setIntents(await listInventoryAdministration(scope, localActorId)); }
    catch (error) { if (run === generation.current) setError(String(error)); }
    finally { running.current = false; if (run === generation.current) setBusy(false); }
  }
  const prepare = (draft: InventoryAdminDraft) => work(async () => { await freezeInventoryAdministration(session, scope, localActorId, draft); });
  const selected = users.find(user => user.id === target);
  return <details className="space-y-3 rounded border border-slate-600 p-3">
    <summary className="min-h-11 cursor-pointer py-2">Администрирование склада · {levels[access.level]}</summary>
    <p>Создание справочников и изменение доступа доступны онлайн после проверки устройства. Проверка сохраняет отдельное предложение; отправка требует отдельного подтверждения. Неизвестный ответ повторяется с тем же ID.</p>
    <label className="block">Поиск по загруженным справочникам<input aria-label="Поиск по загруженным справочникам" className={control} value={search} onChange={event => setSearch(event.target.value)} /></label>
    <details><summary className="min-h-11 cursor-pointer py-2">Материалы ({materials.length})</summary>{materials.filter(row => `${row.code} ${row.name} ${row.category}`.toLowerCase().includes(search.toLowerCase())).map(row => <p key={row.id}>{row.code} · {row.name} · {row.category} · {row.baseUnit} · {row.id}</p>)}</details>
    <details><summary className="min-h-11 cursor-pointer py-2">Места ({locations.length})</summary>{locations.filter(row => inventoryLocationPath(locations, row.id).toLowerCase().includes(search.toLowerCase())).map(row => <p key={row.id}>{inventoryLocationPath(locations, row.id)} · {row.active ? 'Активно' : 'Неактивно'} · {row.id}</p>)}</details>
    <form aria-label="Новый материал" className="space-y-2" onSubmit={event => { event.preventDefault(); void prepare({ resource: 'material', ...material, code: material.code.trim(), name: material.name.trim() }); }}>
      <h4>Новый материал</h4><p>Код и базовая единица задают отдельную идентичность. Повторный код не создаёт другой материал.</p>
      <fieldset disabled={busy} className="space-y-2">
        <label>Код материала<input aria-label="Код материала" required maxLength={100} className={control} value={material.code} onChange={event => setMaterial({ ...material, code: event.target.value })} /></label>
        <label>Название материала<input aria-label="Название материала" required maxLength={200} className={control} value={material.name} onChange={event => setMaterial({ ...material, name: event.target.value })} /></label>
        <label>Категория материала<select aria-label="Категория материала" className={control} value={material.category} onChange={event => setMaterial({ ...material, category: event.target.value as InventoryMaterial['category'] })}>{[['raw_material', 'Сырьё'], ['component', 'Компонент'], ['electrode', 'Электрод'], ['cell', 'Ячейка']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Базовая единица<select aria-label="Базовая единица" className={control} value={material.baseUnit} onChange={event => setMaterial({ ...material, baseUnit: event.target.value as InventoryMaterial['baseUnit'] })}>{['mg', 'ul', 'mm', 'pieces'].map(unit => <option key={unit}>{unit}</option>)}</select></label>
        <button className={button}>Проверить новый материал</button>
      </fieldset>
    </form>
    <form aria-label="Новое место" className="space-y-2" onSubmit={event => { event.preventDefault(); void prepare({ resource: 'location', ...place, label: place.label.trim(), parentId: place.kind === 'warehouse' ? null : place.parentId }); }}>
      <h4>Новое место</h4><fieldset disabled={busy} className="space-y-2">
        <label>Название места<input aria-label="Название места" required maxLength={200} className={control} value={place.label} onChange={event => setPlace({ ...place, label: event.target.value })} /></label>
        <label>Тип места<select aria-label="Тип места" className={control} value={place.kind} onChange={event => setPlace({ ...place, kind: event.target.value as InventoryLocation['kind'], parentId: '' })}>{[['warehouse', 'Склад'], ['cabinet', 'Шкаф'], ['rack', 'Стеллаж'], ['shelf', 'Полка'], ['container_area', 'Место упаковки']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {place.kind !== 'warehouse' && <label>Родительское место<select aria-label="Родительское место" required className={control} value={place.parentId} onChange={event => setPlace({ ...place, parentId: event.target.value })}><option value="">Выберите место</option>{locations.filter(row => row.active && parents[place.kind].includes(row.kind)).map(row => <option key={row.id} value={row.id}>{inventoryLocationPath(locations, row.id)}</option>)}</select></label>}
        <button className={button}>Проверить новое место</button>
      </fieldset>
    </form>
    {access.level === 'chief' && <section aria-label="Доступ к складу" className="space-y-2">
      <h4>Доступ к складу — Chief</h4><p>Роль Master в производстве сама по себе не даёт полномочий менеджера склада.</p>
      <button type="button" className={button} disabled={busy} onClick={() => void work(async () => { const page = await loadWarehouseUsers(session, scope); setUsers(page.items); setAfter(page.nextAfter); })}>Загрузить сотрудников</button>
      {after && <button type="button" className={button} disabled={busy} onClick={() => void work(async () => { const page = await loadWarehouseUsers(session, scope, after); setUsers(rows => [...rows, ...page.items]); setAfter(page.nextAfter); })}>Следующие сотрудники</button>}
      {users.map(user => <p key={user.id}>{user.login} · {user.active ? 'Активен' : 'Неактивен'} · {user.warehouseLevel ? levels[user.warehouseLevel] : 'Нет доступа к складу'}</p>)}
      <label>Сотрудник склада<select aria-label="Сотрудник склада" className={control} value={target} onChange={event => setTarget(event.target.value)}><option value="">Выберите сотрудника</option>{users.filter(user => user.active && user.role !== 'chief').map(user => <option key={user.id} value={user.id}>{user.login} · {user.warehouseLevel ? levels[user.warehouseLevel] : 'Нет доступа'}</option>)}</select></label>
      <label>Уровень склада<select aria-label="Уровень склада" className={control} value={level} onChange={event => setLevel(event.target.value as typeof level)}><option value="operator">Оператор склада</option><option value="manager">Менеджер склада</option></select></label>
      <label>Изменение доступа<select aria-label="Изменение доступа" className={control} value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="grant">Выдать доступ</option><option value="revoke">Отозвать доступ</option></select></label>
      <button type="button" className={button} disabled={busy || !selected || (action === 'revoke' && selected.warehouseLevel !== level)} onClick={() => void prepare({ resource: 'access', userId: target, level, action })}>Проверить изменение доступа</button>
    </section>}
    <section aria-label="Сохранённые административные предложения" className="space-y-2">
      <h4>Сохранённые административные предложения</h4>
      {!intents.length && <p>Предложений нет.</p>}
      {intents.map(row => <article key={row.key} className="rounded border border-slate-600 p-2"><p>{summary(row)}</p><p>ID: {row.operationId} · {row.fields.state === 'accepted' ? 'Сервер подтвердил' : 'Не подтверждено; исходный запрос сохранён'}</p>{row.fields.state === 'pending' && <button type="button" className={button} disabled={busy} onClick={() => void work(async () => { await sendInventoryAdministration(session, scope, localActorId, row.key); onChanged(); })}>Подтвердить отправку предложения {row.operationId?.slice(0, 8)}</button>}</article>)}
    </section>
    {error && <p role="alert">{error}</p>}
  </details>;
}
