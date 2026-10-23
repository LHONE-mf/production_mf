// База компонентов замеса (справочник комнаты «Замесы»).
// Параметры: плотность утряски, истинная плотность, ёмкость, SSA, D50.
// Редактирование — технолог/мастер/начальник; работник только смотрит.
// Каждую запись можно отправить офлайн (QR/текст) как пакет mix-component.

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { MixComponent, StageId, SyncPacket, UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from './_ui/PacketOutModal';

const KIND_LABELS: Record<MixComponent['kind'], string> = {
  active: 'Активный материал',
  binder: 'Связующее',
  conductive: 'Проводящая добавка',
  solvent: 'Растворитель',
  additive: 'Добавка',
};

const emptyDraft = (): Omit<MixComponent, 'id' | 'updatedAt'> => ({
  name: '', kind: 'active',
  densitySettled: undefined, densityTrue: undefined, capacity: undefined, ssa: undefined, d50: undefined,
  viscosity: undefined,
});

export function ComponentsDatabase() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const canEdit = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);

  const components = useLiveQuery(() => db.mixComponents.orderBy('name').toArray(), []);
  const [draft, setDraft] = useState<(Omit<MixComponent, 'id' | 'updatedAt'> & { id?: string }) | null>(null);
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    const now = Date.now();
    const rec: MixComponent = {
      id: draft.id ?? uuidv4(),
      name: draft.name.trim(),
      kind: draft.kind,
      densitySettled: draft.densitySettled, densityTrue: draft.densityTrue,
      capacity: draft.capacity, ssa: draft.ssa, d50: draft.d50,
      viscosity: draft.viscosity,
      updatedAt: now,
    };
    await db.mixComponents.put(rec);
    setDraft(null);
  };

  const remove = async (c: MixComponent) => {
    if (!confirm(`Удалить компонент «${c.name}»?`)) return;
    await db.mixComponents.delete(c.id);
  };

  const share = (c: MixComponent) => {
    setOutPacket({ v: 1, type: 'mix-component', stage: StageId.SLURRY, payload: c, from: currentUser!.id, ts: Date.now() });
  };

  const field = (label: string, key: 'densitySettled' | 'densityTrue' | 'capacity' | 'ssa' | 'd50' | 'viscosity', hint: string) => (
    <label className="text-xs text-slate-400 space-y-1">
      <span>{label} <span className="text-slate-600">({hint})</span></span>
      <input
        type="number" step="any"
        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
        value={(draft as any)?.[key] ?? ''}
        onChange={(e) => setDraft((d) => (d ? { ...d, [key]: num(e.target.value) } : d))}
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-white font-semibold">🧱 База компонентов замеса</h3>
        {canEdit && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-medium"
          >
            + Новый компонент
          </button>
        )}
      </div>
      {!canEdit && <p className="text-xs text-slate-500">Просмотр справочника. Редактирование — технолог и выше.</p>}

      {/* Форма редактирования */}
      {draft && (
        <div className="bg-slate-800 border border-blue-500/40 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-slate-400 space-y-1">
              <span>Название компонента</span>
              <input
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="например, LFP (LiFePO4)"
              />
            </label>
            <label className="text-xs text-slate-400 space-y-1">
              <span>Тип</span>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as MixComponent['kind'] })}
              >
                {Object.entries(KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {field('Плотн. утряски', 'densitySettled', 'г/см³')}
            {field('Истинная плотн.', 'densityTrue', 'г/см³')}
            {field('Ёмкость', 'capacity', 'мАч/г')}
            {field('SSA', 'ssa', 'м²/г')}
            {field('D50', 'd50', 'мкм')}
            {field('Вязкость', 'viscosity', 'мПа·с, для р-телей')}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={!draft.name.trim()} className="px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm text-white font-medium">
              Сохранить
            </button>
            <button onClick={() => setDraft(null)} className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-200">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Таблица */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700 text-xs">
              <th className="py-2 pr-2">Компонент</th>
              <th className="py-2 pr-2">Тип</th>
              <th className="py-2 pr-2">ρ утр.</th>
              <th className="py-2 pr-2">ρ ист.</th>
              <th className="py-2 pr-2">C, мАч/г</th>
              <th className="py-2 pr-2">SSA</th>
              <th className="py-2 pr-2">D50</th>
              <th className="py-2 pr-2">η, мПа·с</th>
              <th className="py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {(components ?? []).map((c) => (
              <tr key={c.id} className="border-b border-slate-800 text-slate-200">
                <td className="py-2 pr-2">{c.name}</td>
                <td className="py-2 pr-2 text-xs text-slate-400">{KIND_LABELS[c.kind]}</td>
                <td className="py-2 pr-2 text-xs">{c.densitySettled ?? '—'}</td>
                <td className="py-2 pr-2 text-xs">{c.densityTrue ?? '—'}</td>
                <td className="py-2 pr-2 text-xs">{c.capacity ?? '—'}</td>
                <td className="py-2 pr-2 text-xs">{c.ssa ?? '—'}</td>
                <td className="py-2 pr-2 text-xs">{c.d50 ?? '—'}</td>
                <td className="py-2 pr-2 text-xs">{c.viscosity ?? '—'}</td>
                <td className="py-2 whitespace-nowrap">
                  <button onClick={() => share(c)} title="Отправить QR/текстом" className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded mr-1">📡</button>
                  {canEdit && (
                    <>
                      <button
                        onClick={() => setDraft({ ...c })}
                        className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded mr-1"
                      >✏️</button>
                      <button onClick={() => remove(c)} className="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/60 rounded">🗑</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {components?.length === 0 && <p className="text-slate-500 text-sm">База пуста.</p>}
      </div>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
