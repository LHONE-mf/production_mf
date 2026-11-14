import React, { useState } from 'react';
import { inventoryLocationPath, type InventoryMaterial, type InventoryLocation } from '../../core/sync/inventoryCatalogClient';
import type { InventoryAdminDraft } from '../../core/sync/inventoryAdministration';
const control = 'block min-h-11 w-full rounded bg-slate-900 p-2';
const button = 'min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50';
const parents: Record<InventoryLocation['kind'], InventoryLocation['kind'][]> = { warehouse: [], cabinet: ['warehouse'], rack: ['warehouse'], shelf: ['cabinet', 'rack'], container_area: ['shelf'] };
export function StorageCatalogEditor({ materials, locations, busy, onPrepare }: { materials: InventoryMaterial[]; locations: InventoryLocation[]; busy: boolean; onPrepare: (draft: InventoryAdminDraft) => void }) {
  const [material, setMaterial] = useState<InventoryMaterial | null>(null), [place, setPlace] = useState<InventoryLocation | null>(null);
  const [materialReason, setMaterialReason] = useState(''), [locationReason, setLocationReason] = useState('');
  return <details className="space-y-3 rounded border border-slate-600 p-2">
    <summary className="min-h-11 cursor-pointer py-2">Изменить справочники</summary>
    <p>Выберите исходную серверную версию. Изменение сохраняется отдельным предложением. Обновление склада не заменяет выбранную версию автоматически; при конфликте сверяйте исходное предложение и выбирайте актуальную версию заново.</p>
    <form aria-label="Изменение материала" className="space-y-2" onSubmit={event => { event.preventDefault(); if (material?.revision) onPrepare({ resource: 'material_change', id: material.id, expectedRevision: material.revision, name: material.name.trim(), supplierReference: material.supplierReference?.trim() || null, active: material.active !== false, reason: materialReason.trim() }); }}>
      <label>Материал для изменения<select aria-label="Материал для изменения" className={control} value={material?.id ?? ''} onChange={event => { setMaterial(materials.find(row => row.id === event.target.value) ?? null); setMaterialReason(''); }}><option value="">Выберите материал</option>{materials.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name} · {row.active === false ? 'Неактивен' : 'Активен'}</option>)}</select></label>
      {material && <fieldset disabled={busy || !material.revision} className="space-y-2">
        <p>Исходная версия: {material.revision ?? 'Сервер не поддерживает изменение'}. Код {material.code}, категория {material.category} и единица {material.baseUnit} сохраняются.</p>
        <label>Новое название материала<input aria-label="Новое название материала" required maxLength={200} className={control} value={material.name} onChange={event => setMaterial({ ...material, name: event.target.value })} /></label>
        <label>Артикул поставщика<input aria-label="Артикул поставщика" maxLength={200} className={control} value={material.supplierReference ?? ''} onChange={event => setMaterial({ ...material, supplierReference: event.target.value })} /></label>
        <label className="flex min-h-11 items-center gap-3"><input aria-label="Материал активен для новых приёмок" type="checkbox" checked={material.active !== false} onChange={event => setMaterial({ ...material, active: event.target.checked })} />Материал активен для новых приёмок</label>
        <label>Основание изменения материала<input aria-label="Основание изменения материала" required maxLength={2000} className={control} value={materialReason} onChange={event => setMaterialReason(event.target.value)} /></label>
        <button className={button}>Проверить изменение материала</button>
      </fieldset>}
    </form>
    <form aria-label="Изменение места" className="space-y-2" onSubmit={event => { event.preventDefault(); if (place?.revision) onPrepare({ resource: 'location_change', id: place.id, expectedRevision: place.revision, label: place.label.trim(), parentId: place.parentId, active: place.active, reason: locationReason.trim() }); }}>
      <label>Место для изменения<select aria-label="Место для изменения" className={control} value={place?.id ?? ''} onChange={event => { setPlace(locations.find(row => row.id === event.target.value) ?? null); setLocationReason(''); }}><option value="">Выберите место</option>{locations.map(row => <option key={row.id} value={row.id}>{inventoryLocationPath(locations, row.id)} · {row.active ? 'Активно' : 'Неактивно'}</option>)}</select></label>
      {place && <fieldset disabled={busy || !place.revision} className="space-y-2">
        <p>Исходная версия: {place.revision ?? 'Сервер не поддерживает изменение'}. Тип {place.kind} сохраняется. Занятые и исторические пути защищены; сервер отклонит изменение такого места и его предков. Активное дочернее место препятствует отключению родителя.</p>
        <label>Новое название места<input aria-label="Новое название места" required maxLength={200} className={control} value={place.label} onChange={event => setPlace({ ...place, label: event.target.value })} /></label>
        {place.kind !== 'warehouse' && <label>Новый родитель места<select aria-label="Новый родитель места" required className={control} value={place.parentId ?? ''} onChange={event => setPlace({ ...place, parentId: event.target.value })}><option value="">Выберите место</option>{locations.filter(row => row.active && row.id !== place.id && parents[place.kind].includes(row.kind)).map(row => <option key={row.id} value={row.id}>{inventoryLocationPath(locations, row.id)}</option>)}</select></label>}
        <label className="flex min-h-11 items-center gap-3"><input aria-label="Место активно" type="checkbox" checked={place.active} onChange={event => setPlace({ ...place, active: event.target.checked })} />Место активно</label>
        <label>Основание изменения места<input aria-label="Основание изменения места" required maxLength={2000} className={control} value={locationReason} onChange={event => setLocationReason(event.target.value)} /></label>
        <button className={button}>Проверить изменение места</button>
      </fieldset>}
    </form>
  </details>;
}
