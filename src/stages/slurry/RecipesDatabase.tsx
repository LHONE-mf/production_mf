// База стандартных замесов (рецепт + режим) комнаты «Замесы».
// Строки рецепта — с выбором компонента из базы; режим — этапы, которые можно добавлять/удалять.
// Редактирование: технолог/мастер/начальник. Отправка на slave — пакет mix-recipe (в т.ч. forced).

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { MixRecipe, MixComponent, MixModeStage, StageId, SyncPacket, UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { calcGrammages, fmtG } from './mixMath';

type Draft = MixRecipe & { id: string };

const newDraft = (userId: string): Draft => ({
  id: uuidv4(), name: '', dryMassKg: 100, lines: [], mode: [],
  note: '', updatedBy: userId, updatedAt: Date.now(),
});

export function RecipesDatabase({ onUse }: { onUse?: (r: MixRecipe) => void }) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const canEdit = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);

  const recipes = useLiveQuery(() => db.mixRecipes.orderBy('name').toArray(), []);
  const components = useLiveQuery(() => db.mixComponents.toArray(), []);
  const compMap = React.useMemo(() => new Map((components ?? []).map((c) => [c.id, c])), [components]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

  // --- строки рецепта ---
  const addLine = () =>
    setDraft((d) => (d ? { ...d, lines: [...d.lines, { componentId: components?.[0]?.id ?? '', pct: 1 }] } : d));
  const setLine = (i: number, patch: Partial<{ componentId: string; pct: number }>) =>
    setDraft((d) => (d ? { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : d));
  const delLine = (i: number) =>
    setDraft((d) => (d ? { ...d, lines: d.lines.filter((_, j) => j !== i) } : d));

  // --- этапы режима ---
  const addStage = () =>
    setDraft((d) => (d ? { ...d, mode: [...d.mode, { id: uuidv4(), name: 'Новый этап', vacuumOn: false, minutes: 10 }] } : d));
  const setStage = (i: number, patch: Partial<MixModeStage>) =>
    setDraft((d) => (d ? { ...d, mode: d.mode.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : d));
  const delStage = (i: number) =>
    setDraft((d) => (d ? { ...d, mode: d.mode.filter((_, j) => j !== i) } : d));

  const save = async () => {
    if (!draft || !draft.name.trim() || draft.lines.length === 0) return;
    const rec: MixRecipe = { ...draft, name: draft.name.trim(), updatedAt: Date.now(), updatedBy: currentUser!.id };
    await db.mixRecipes.put(rec);
    setDraft(null);
  };

  const remove = async (r: MixRecipe) => {
    if (!confirm(`Удалить стандартный замес «${r.name}»?`)) return;
    await db.mixRecipes.delete(r.id);
  };

  const share = (r: MixRecipe, forced = false) => {
    if (!currentUser) return;
    setOutPacket({
      v: 1, type: forced ? 'forced-push' : 'mix-recipe', stage: StageId.SLURRY,
      payload: r, from: currentUser.id, ts: Date.now(), forced: forced || undefined,
    });
  };

  const inputCls = 'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-white font-semibold">📚 База стандартных замесов</h3>
        {canEdit && (
          <button
            onClick={() => setDraft(newDraft(currentUser!.id))}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-medium"
          >
            + Новый замес
          </button>
        )}
      </div>

      {/* Список */}
      <div className="space-y-2">
        {(recipes ?? []).map((r) => {
          const { rows, allTotalG } = calcGrammages(r, compMap, r.dryMassKg);
          return (
            <div key={r.id} className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-white font-medium text-sm">
                  {r.name} <span className="text-slate-400 text-xs">· СВ {r.dryMassKg} кг · замес {fmtG(allTotalG)}</span>
                </p>
                <div className="flex gap-1 flex-wrap">
                  {onUse && (
                    <button onClick={() => onUse(r)} className="text-xs px-2 py-1 bg-green-700 hover:bg-green-600 rounded text-white font-medium">
                      ▶ Взять в расчёт
                    </button>
                  )}
                  <button onClick={() => share(r)} title="Отправить QR/текстом" className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded">📡</button>
                  {canEdit && (
                    <>
                      {currentUser && [UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role) && (
                        <button onClick={() => share(r, true)} title="Принудительно дописать в slave (forced)" className="text-xs px-2 py-1 bg-orange-800/70 hover:bg-orange-700 rounded">⚡ forced</button>
                      )}
                      <button onClick={() => setDraft({ ...r, lines: r.lines.map((l) => ({ ...l })), mode: r.mode.map((m) => ({ ...m })) })} className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded">✏️</button>
                      <button onClick={() => remove(r)} className="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/60 rounded">🗑</button>
                    </>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div className="space-y-1">
                  <p className="text-slate-400 font-semibold">Состав:</p>
                  {rows.map((row) => (
                    <div key={row.componentId} className="flex justify-between text-slate-300">
                      <span>{row.name}{row.isSolvent ? ' (р-тель)' : ''}</span>
                      <span className="font-mono">{row.pct}% → {fmtG(row.grams)}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-slate-400 font-semibold">Режим ({r.mode.length} эт.):</p>
                  {r.mode.map((s, i) => (
                    <div key={s.id} className="text-slate-300">
                      {i + 1}. {s.name}: {s.disperserRpm ? `дисп. ${s.disperserRpm}` : '—'} / {s.paddleRpm ? `лоп. ${s.paddleRpm}` : '—'} об/мин
                      {s.vacuumOn ? `, вакуум ${s.vacuumKpa ?? '—'} кПа` : ''}, {s.tempC ?? '—'}°C, {s.minutes} мин
                    </div>
                  ))}
                </div>
              </div>
              {r.note && <p className="text-xs text-slate-500">💬 {r.note}</p>}
            </div>
          );
        })}
        {recipes?.length === 0 && <p className="text-slate-500 text-sm">База пуста.</p>}
      </div>

      {/* Форма редактирования */}
      {draft && (
        <div className="bg-slate-800 border border-blue-500/40 rounded-lg p-3 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs text-slate-400 space-y-1 sm:col-span-2">
              <span>Название замеса</span>
              <input className={`w-full ${inputCls}`} value={draft.name} placeholder="Катод LFP R-08"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400 space-y-1">
              <span>Базовая масса СВ, кг</span>
              <input type="number" min={1} className={`w-full ${inputCls}`} value={draft.dryMassKg}
                onChange={(e) => setDraft({ ...draft, dryMassKg: Number(e.target.value) || 1 })} />
            </label>
          </div>

          {/* Строки рецепта с выбором компонента */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-200">Компоненты замеса</p>
              <button onClick={addLine} disabled={!components?.length} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white">+ строка</button>
            </div>
            {draft.lines.map((l, i) => {
              const c = compMap.get(l.componentId);
              return (
                <div key={i} className="flex items-center gap-2 flex-wrap">
                  <select
                    className={`flex-1 min-w-[10rem] ${inputCls}`}
                    value={l.componentId}
                    onChange={(e) => setLine(i, { componentId: e.target.value })}
                  >
                    {(components ?? []).map((cc) => (
                      <option key={cc.id} value={cc.id}>{cc.name}{cc.kind === 'solvent' ? ' (р-тель)' : ''}</option>
                    ))}
                  </select>
                  <input type="number" step="any" min={0} className={`w-20 ${inputCls}`} value={l.pct}
                    onChange={(e) => setLine(i, { pct: Number(e.target.value) || 0 })} />
                  <span className="text-xs text-slate-400 w-24">
                    % {c?.kind === 'solvent' ? 'от СВ' : 'сухих'}
                  </span>
                  <button onClick={() => delLine(i)} className="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/60 rounded">✕</button>
                </div>
              );
            })}
            {draft.lines.length === 0 && <p className="text-xs text-slate-500">Добавьте хотя бы одну строку.</p>}
          </div>

          {/* Режим замеса: этапы добавляются/удаляются */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-200">Режим замеса (этапы)</p>
              <button onClick={addStage} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white">+ этап</button>
            </div>
            {draft.mode.map((s, i) => (
              <div key={s.id} className="bg-slate-900/50 border border-slate-700 rounded p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 w-5">{i + 1}.</span>
                  <input className={`flex-1 ${inputCls}`} value={s.name} placeholder="напр. Диспергирование"
                    onChange={(e) => setStage(i, { name: e.target.value })} />
                  <button onClick={() => delStage(i)} className="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/60 rounded">✕</button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs">
                  <label className="text-slate-400 space-y-0.5">Диспергатор, об/мин
                    <input type="number" className={`w-full ${inputCls}`} value={s.disperserRpm ?? ''}
                      onChange={(e) => setStage(i, { disperserRpm: num(e.target.value) })} />
                  </label>
                  <label className="text-slate-400 space-y-0.5">Лопасти, об/мин
                    <input type="number" className={`w-full ${inputCls}`} value={s.paddleRpm ?? ''}
                      onChange={(e) => setStage(i, { paddleRpm: num(e.target.value) })} />
                  </label>
                  <label className="text-slate-400 space-y-0.5">
                    <span className="inline-flex items-center gap-1">
                      <input type="checkbox" checked={s.vacuumOn}
                        onChange={(e) => setStage(i, { vacuumOn: e.target.checked })} /> Вакуум
                    </span>
                    <input type="number" className={`w-full ${inputCls}`} placeholder="кПа (напр. -80)" value={s.vacuumKpa ?? ''} disabled={!s.vacuumOn}
                      onChange={(e) => setStage(i, { vacuumKpa: num(e.target.value) })} />
                  </label>
                  <label className="text-slate-400 space-y-0.5">Термостат, °C
                    <input type="number" className={`w-full ${inputCls}`} value={s.tempC ?? ''}
                      onChange={(e) => setStage(i, { tempC: num(e.target.value) })} />
                  </label>
                  <label className="text-slate-400 space-y-0.5">Время, мин
                    <input type="number" min={1} className={`w-full ${inputCls}`} value={s.minutes}
                      onChange={(e) => setStage(i, { minutes: Number(e.target.value) || 0 })} />
                  </label>
                  <div className="flex items-end">
                    <span className="text-slate-500">{s.vacuumOn ? '🌫 вакуум' : 'без вакуума'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <label className="text-xs text-slate-400 space-y-1 block">
            <span>Примечание</span>
            <textarea rows={2} className={`w-full ${inputCls}`} value={draft.note ?? ''}
              placeholder="Контроль вязкости, порядок загрузки и т.п."
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </label>

          <div className="flex gap-2">
            <button onClick={save} disabled={!draft.name.trim() || draft.lines.length === 0}
              className="px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm text-white font-medium">
              Сохранить замес
            </button>
            <button onClick={() => setDraft(null)} className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-200">Отмена</button>
          </div>
        </div>
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
