// Каркас комнаты «Сборка» (AssemblyRoom). Полностью офлайн.
// Структура: сверху выбор партии (AssemblyRun), ниже — вкладки-подсекции, каждая
// станция живёт в СВОЁМ файле (LiElectrodesStation, ZStackingStation, ...), чтобы
// любую можно было переписать независимо.
// Вкладки: 📥 Партии с сортировки · 🔘 B-с1 Литиевые электроды · 📚 B-с2 Z-стэкинг ·
//          🌀 B-с3 Скрутка · 🔩 B-с4 Зиговка+УЗ (цил.) · 🔊 B-с5 УЗ (призм.) ·
//          🔦 B-с6 Лазер (призм.) · 📒 Журнал · 💬 Комментарии
// Станции B-с3..B-с6 подключим в шаге Б2b отдельными файлами.

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  AssemblyOp, AssemblyRun, AssemblySubstation, CellType, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { LiElectrodesStation } from './LiElectrodesStation';
import { ZStackingStation } from './ZStackingStation';

type Tab = 'incoming' | AssemblySubstation | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export function AssemblyModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isTechManager = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  const runs = useLiveQuery(async () => {
    const all = await db.assemblyRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  // Партии, готовые принять в сборку: результаты сортировки ещё не взятые в работу
  const sortRuns = useLiveQuery(() => db.sortRuns.toArray(), []);

  const selected = useMemo(
    () => (runs ?? []).find((r) => r.id === selectedId) ?? null,
    [runs, selectedId],
  );

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.ASSEMBLY, authorId: currentUser.id,
      text: text.trim(), createdAt: new Date(),
    });
  };

  // Взять партию с сортировки в работу: создаём AssemblyRun по названию партии
  const takeBatch = async (srId: string) => {
    if (!currentUser) return;
    const sr = (sortRuns ?? []).find((x) => x.id === srId);
    if (!sr) return;
    const spec = await db.sortSpecs.get(sr.specId);
    const run: AssemblyRun = {
      id: uuidv4(),
      batchName: sr.batchName,
      cellType: (spec?.electrodeType === 'strip' ? 'cylindrical' : 'prismatic') as CellType,
      electrodeType: spec?.electrodeType,
      coatingType: spec?.coatingType,
      ops: [],
      cellsOut: 0,
      cellsScrap: 0,
      defects: [],
      workerId: currentUser.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.assemblyRuns.put(run);
    setSelectedId(run.id);
    setTab('li-electrodes');
  };

  // Станция добавляет операцию в партию + пересчитывает итоги
  const addOp = async (op: AssemblyOp) => {
    if (!selected || !currentUser) return;
    const ops = [...selected.ops, op];
    const lastBySub = ops.filter((o) => o.substation === op.substation).slice(-1)[0];
    void lastBySub;
    const updated: AssemblyRun = {
      ...selected,
      ops,
      cellsOut: op.qtyOut,           // упрощённо: последняя операция задаёт итог годных
      cellsScrap: (selected.cellsScrap ?? 0) + op.qtyScrap,
      defects: [...selected.defects, ...op.defects],
      updatedAt: new Date().toISOString(),
    };
    await db.assemblyRuns.put(updated);
  };

  const sendToMaster = (run: AssemblyRun, forced: boolean) => {
    if (!currentUser) return;
    const fresh = { ...run, workerId: currentUser.id, updatedAt: new Date().toISOString() };
    db.assemblyRuns.put(fresh);
    setOutPacket({
      v: 1, type: 'assembly-run', stage: StageId.ASSEMBLY,
      payload: fresh, from: currentUser.id, ts: Date.now(), forced,
    });
  };

  const stationTabs: { id: Tab; label: string }[] = [
    { id: 'incoming', label: `📥 Партии с сортировки (${(sortRuns ?? []).length})` },
    { id: 'li-electrodes', label: '🔘 B-с1 Литиевые электроды' },
    { id: 'z-stacking', label: '📚 B-с2 Z-стэкинг' },
    { id: 'winding', label: '🌀 B-с3 Скрутка (Б2b)' },
    { id: 'crimp-cyl', label: '🔩 B-с4 Зиговка+УЗ цил. (Б2b)' },
    { id: 'us-prismatic', label: '🔊 B-с5 УЗ призм. (Б2b)' },
    { id: 'laser-prismatic', label: '🔦 B-с6 Лазер призм. (Б2b)' },
    { id: 'journal', label: `📒 Журнал партий (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-bold text-white">🔋 Сборка элементов и батареек</h2>
      <p className="text-xs text-slate-400">
        Каждая подсекция — отдельный файл в <code>src/stages/assembly/</code>. Данные приходят
        с сортировки (название партии), результат уходит на формовку / master-устройства.
      </p>

      {/* Выбор активной партии для станций */}
      {(runs ?? []).length > 0 && tab !== 'incoming' && tab !== 'journal' && tab !== 'comments' && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-slate-400">Активная партия:</label>
          <select className={inputCls + ' max-w-xs'} value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}>
            <option value="">— выберите —</option>
            {(runs ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.batchName} ({r.cellType === 'cylindrical' ? 'цилиндрич.' : 'призмат.'}, операций: {r.ops.length})
              </option>
            ))}
          </select>
          {selected && (
            <button onClick={() => sendToMaster(selected, false)}
              className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">
              📤 Отправить результат (QR/BLE/текст)
            </button>
          )}
        </div>
      )}

      <div className="flex gap-1 flex-wrap border-b border-slate-800 pb-2">
        {stationTabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-t text-xs ${tab === t.id ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">Результаты сортировки (партии годных электродов). Нажмите «Взять в сборку».</p>
          {(sortRuns ?? []).length === 0 && <p className="text-xs text-slate-500">Пока нет партий с сортировки.</p>}
          {(sortRuns ?? []).map((sr) => (
            <div key={sr.id} className="bg-slate-900 border border-slate-800 rounded p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-slate-300">
                <span className="text-white font-semibold">{sr.batchName}</span>
                {' '}· годных с нарезки: {sr.goodCount}, отсортировано:{' '}
                {sr.buckets.reduce((s, b) => s + b.count, 0)}, отбраковано: {sr.rejected}
                <br /><span className="text-slate-500">{new Date(sr.createdAt).toLocaleString()}</span>
              </div>
              <button onClick={() => takeBatch(sr.id)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">
                ➡️ Взять в сборку
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'li-electrodes' && (selected ? (
        <LiElectrodesStation run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'z-stacking' && (selected ? (
        <ZStackingStation run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {['winding', 'crimp-cyl', 'us-prismatic', 'laser-prismatic'].includes(tab) && (
        <div className="bg-slate-900 border border-dashed border-slate-700 rounded p-6 text-center">
          <p className="text-sm text-slate-400">Станция будет добавлена шагом <b>Б2b</b> отдельным файлом.</p>
          <p className="text-xs text-slate-600 mt-1">id: {tab}</p>
        </div>
      )}

      {tab === 'journal' && (
        <div className="space-y-2">
          {(runs ?? []).length === 0 && <p className="text-xs text-slate-500">Журнал пуст.</p>}
          {(runs ?? []).map((r) => (
            <div key={r.id} className="bg-slate-900 border border-slate-800 rounded p-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="text-xs text-slate-300">
                  <span className="text-white font-semibold">🔋 {r.batchName}</span>
                  {' '}· {r.cellType === 'cylindrical' ? 'цилиндрическая' : 'призматическая'}
                  {r.coatingType && <> · покрытие: {r.coatingType}</>}
                  <br />операций: {r.ops.length} · ячеек годных: <b className="text-emerald-400">{r.cellsOut}</b> · брак: <span className="text-red-400">{r.cellsScrap}</span>
                  {r.defects.length > 0 && <><br /><span className="text-red-400">⚠ {r.defects.join(', ')}</span></>}
                  <br /><span className="text-slate-500">{new Date(r.updatedAt).toLocaleString()}</span>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { setSelectedId(r.id); setTab('li-electrodes'); }}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs text-white">Открыть</button>
                  <button onClick={() => sendToMaster(r, false)}
                    className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">📤 Отправить</button>
                  {isTechManager && (
                    <button onClick={() => sendToMaster(r, true)}
                      className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-xs text-white" title="forced → slave">📌 Принудительно</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsSection stage={StageId.ASSEMBLY} onAdd={addComment} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

function NoBatch() {
  return (
    <div className="bg-slate-900 border border-dashed border-slate-700 rounded p-6 text-center">
      <p className="text-sm text-slate-400">Сначала выберите активную партию вверху (или возьмите партию с сортировки).</p>
    </div>
  );
}
