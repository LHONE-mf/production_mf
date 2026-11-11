import {appendAssemblyOperation} from '../../core/manufacturing/assemblyOperations';
import {takeAssemblySource} from '../../core/manufacturing/assemblyIntake';
// Каркас комнаты «Сборка» (AssemblyRoom). Полностью офлайн.
// Структура: сверху выбор партии (AssemblyRun), ниже — вкладки-подсекции, каждая
// станция живёт в СВОЁМ файле (LiElectrodesStation, ZStackingStation, ...), чтобы
// любую можно было переписать независимо.
// Вкладки: 📥 Партии с сортировки · 🔘 B-с1 Литиевые электроды · 📚 B-с2 Z-стэкинг ·
//          🌀 B-с3 Скрутка · 🔩 B-с4 Зиговка+УЗ (цил.) · 🔊 B-с5 УЗ (призм.) ·
//          🔦 B-с6 Лазер (призм.) · 📒 Журнал · 💬 Комментарии
// Станции B-с3..B-с6 подключим в шаге Б2b отдельными файлами.

import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  SerialRange,
  AssemblyOp, AssemblyRun, AssemblySubstation, CellType, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { LiElectrodesStation } from './LiElectrodesStation';
import { ZStackingStation } from './ZStackingStation';
import { WindingStation } from './WindingStation';
import { CrimpCylStation } from './CrimpCylStation';
import { UsPrismaticStation } from './UsPrismaticStation';
import { LaserPrismaticStation } from './LaserPrismaticStation';

type Tab = 'incoming' | AssemblySubstation | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export function AssemblyModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isTechManager = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const intakeRef=useRef(false);const [intakeBusy,setIntakeBusy]=useState(false);
  const [intakeError,setIntakeError]=useState('');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  const runs = useLiveQuery(async () => {
    const all = await db.assemblyRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  // Партии, готовые принять в сборку: результаты сортировки ещё не взятые в работу
  const sortRuns = useLiveQuery(async()=> (await db.sortRuns.toArray()).filter(row=>row.buckets?.some(bucket=>Number.isSafeInteger(bucket.count)&&bucket.count>0)), []);

  const selected = useMemo(
    () => (runs ?? []).find((r) => r.id === selectedId) ?? null,
    [runs, selectedId],
  );

  // Номера аккумуляторов партии: вводятся на сборке, мигрируют со сборки → заливка → формовка
  const [serialForm, setSerialForm] = useState({ prefix: '', start: '', end: '' });

  const saveSerialRange = async () => {
    if (!selected || selected.intake || selected.operationLedger) return;
    const start = Number(serialForm.start);
    const end = Number(serialForm.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    const sr: SerialRange = { prefix: serialForm.prefix.trim() || undefined, start, end };
    try{
      await db.transaction('rw',db.assemblyRuns,async()=>{
        const current=await db.assemblyRuns.get(selected.id);
        if(!current||current.intake||current.operationLedger||JSON.stringify(current)!==JSON.stringify(selected))throw new Error('Партия изменена. Проверьте журнал перед заданием номеров.');
        await db.assemblyRuns.put({...current,serialRange:sr,updatedAt:new Date().toISOString()});
      });
    }catch(cause){setIntakeError(cause instanceof Error?cause.message:'Номера не сохранены');}
  };

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.ASSEMBLY, authorId: currentUser.id,
      text: text.trim(), createdAt: new Date(),
    });
  };

  // Принять полный положительный выход конкретной записи сортировки
  const takeBatch = async (srId: string) => {
    if (!currentUser) return;
    const sr = (sortRuns ?? []).find((x) => x.id === srId);
    if (!sr) return;
    if(intakeRef.current)return;
    intakeRef.current=true;setIntakeBusy(true);setIntakeError('');
    try{
      const run=await takeAssemblySource(sr,currentUser.id,uuidv4());
      setSelectedId(run.id);setTab('journal');
    }catch(cause){setIntakeError(cause instanceof Error?cause.message:'Приёмка не сохранена');}
    finally{intakeRef.current=false;setIntakeBusy(false);}

  };

  // New entries are observations; their units are not converted into cell release.
  const addOp = async (op: AssemblyOp) => {
    if (!selected || !currentUser) throw new Error('Выберите доступную партию и войдите в профиль');
    await appendAssemblyOperation(selected,op,currentUser.id);
  };

  const sendToMaster = (run: AssemblyRun, forced: boolean) => {
    if (!currentUser) return;
    const fresh = run;
    setOutPacket({
      v: 1, type: 'assembly-run', stage: StageId.ASSEMBLY,
      payload: fresh, from: currentUser.id, ts: Date.now(), forced,
    });
  };

  const stationTabs: { id: Tab; label: string }[] = [
    { id: 'incoming', label: `📥 Партии с сортировки (${(sortRuns ?? []).length})` },
    { id: 'li-electrodes', label: '🔘 B-с1 Литиевые электроды' },
    { id: 'z-stacking', label: '📚 B-с2 Z-стэкинг' },
    { id: 'winding', label: '🌀 B-с3 Скрутка' },
    { id: 'crimp-cyl', label: '🔩 B-с4 Зиговка+точка+УЗ цил.' },
    { id: 'us-prismatic', label: '🔊 B-с5 УЗ призм.' },
    { id: 'laser-prismatic', label: '🔦 B-с6 Лазер призм.' },
    { id: 'journal', label: `📒 Журнал партий (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-bold text-white">🔋 Сборка элементов и батареек</h2>
      <p className="text-xs text-slate-400">
        Принимается весь годный выход одной записи сортировки без разделения. Электроды не пересчитываются в ячейки.
        Для каждой операции явно укажите полный источник или предшественника. Выпуск ячеек и серийные номера отдельно не подтверждены.
      </p>

      {intakeError && <p role="alert" className="text-red-300 text-sm">{intakeError}</p>}

      {/* Выбор активной партии для станций */}
      {(runs ?? []).length > 0 && tab !== 'incoming' && tab !== 'journal' && tab !== 'comments' && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-slate-400">Активная партия:</label>
          <select className={inputCls + ' max-w-xs'} value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}>
            <option value="">— выберите —</option>
            {(runs ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.batchName} ({r.intake?'тип ячейки не задан':r.cellType === 'cylindrical' ? 'цилиндрич.' : 'призмат.'}, операций: {r.ops.length})
              </option>
            ))}
          </select>
          {selected && !selected.intake && !selected.operationLedger && (() => {
            const sr = selected.serialRange;
            return (
              <span className="flex items-center gap-1.5 flex-wrap">
                <input className={inputCls + ' w-20'} placeholder="префикс" value={serialForm.prefix}
                  onChange={(e) => setSerialForm((f) => ({ ...f, prefix: e.target.value }))} />
                <input className={inputCls + ' w-24'} placeholder="№ нач." type="number" value={serialForm.start}
                  onChange={(e) => setSerialForm((f) => ({ ...f, start: e.target.value }))} />
                <input className={inputCls + ' w-24'} placeholder="№ кон." type="number" value={serialForm.end}
                  onChange={(e) => setSerialForm((f) => ({ ...f, end: e.target.value }))} />
                <button onClick={saveSerialRange}
                  className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded text-xs text-white">🔢 Задать номера</button>
                <span className="text-xs text-slate-300" title="Диапазон номеров аккумуляторов партии — уходит на заливку и формирование">
                  № {sr ? `${sr.prefix ?? ''}${sr.start}…${sr.prefix ?? ''}${sr.end}` : 'не заданы'}
                </span>
                <button onClick={() => sendToMaster(selected, false)}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">
                  📤 Отправить результат (QR/BLE/текст)
                </button>
              </span>
            );
          })()}
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
          {(sortRuns ?? []).length === 0 && <p className="text-xs text-slate-500">Нет партий с электродами для сборки. Полностью отбракованные результаты остаются в журнале сортировки.</p>}
          {(sortRuns ?? []).map((sr) => (
            <div key={sr.id} className="bg-slate-900 border border-slate-800 rounded p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-slate-300">
                <span className="text-white font-semibold">{sr.batchName}</span>
                {' '}· годных с нарезки: {sr.goodCount}, отсортировано:{' '}
                {sr.buckets.reduce((s, b) => s + b.count, 0)}, отбраковано: {sr.rejected}
                <br /><span className="text-slate-500">{new Date(sr.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-xs text-slate-400 break-all">Источник: {sr.id}</p>
              <button disabled={intakeBusy} onClick={() => void takeBatch(sr.id)}
                className="min-h-11 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">
                ➡️ Взять в сборку
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'li-electrodes' && (selected ? (
        <LiElectrodesStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'z-stacking' && (selected ? (
        <ZStackingStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'winding' && (selected ? (
        <WindingStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'crimp-cyl' && (selected ? (
        <CrimpCylStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'us-prismatic' && (selected ? (
        <UsPrismaticStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'laser-prismatic' && (selected ? (
        <LaserPrismaticStation key={selected.id} run={selected} workerId={currentUser?.id ?? ''} onAddOp={addOp} />
      ) : <NoBatch />)}

      {tab === 'journal' && (
        <div className="space-y-2">
          {(runs ?? []).length === 0 && <p className="text-xs text-slate-500">Журнал пуст.</p>}
          {(runs ?? []).map((r) => (
            <div key={r.id} className="bg-slate-900 border border-slate-800 rounded p-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="text-xs text-slate-300">
                  <span className="text-white font-semibold">🔋 {r.batchName}</span>
                  {' '}· {r.intake?'тип ячейки не задан':r.cellType === 'cylindrical' ? 'цилиндрическая' : 'призматическая'}
                  {r.coatingType && <> · покрытие: {r.coatingType}</>}
                  {r.intake&&<p className="break-all">Источник сортировки: {r.intake.sortRunId} · принято {r.intake.electrodeCount} электродов · {r.intake.recordedBy} · {new Date(r.intake.recordedAt).toLocaleString()}</p>}
                  <br />операций: {r.ops.length} · ячеек годных: <b className="text-emerald-400">{r.intake||r.operationLedger?'не определён':r.cellsOut}</b> · брак: <span className="text-red-400">{r.intake||r.operationLedger?'не определён':r.cellsScrap}</span>
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
