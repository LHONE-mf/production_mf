// Комната «Нарезка электродов». Полностью офлайн.
// Вкладки: 📥 Рулоны с каландра · ✂️ Нарезка (расчёт выхода + журнал) · 📒 Журнал · 💬 Комментарии
// Цепочка данных: каландр/технолог → (cutting-roll) сюда → оператор режет и фиксирует
// результат (годные/дефекты) → (cut-run) на участок сортировки / master.

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  CutRun, CuttingIncoming, ElectrodeShape, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';

type Tab = 'incoming' | 'cut' | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

const shapeLabel = (s: ElectrodeShape) =>
  s === 'strip' ? '📏 Полосы (цилиндрические)' : '▭ Призматические пластины';

export function CuttingModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isTechManager = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const incoming = useLiveQuery(async () => {
    const all = await db.cuttingRolls.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const runs = useLiveQuery(async () => {
    const all = await db.cuttingRuns.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const tasks = useLiveQuery(async () => {
    const all = await db.tasks.toArray();
    return all.filter((t) => t.stage === StageId.SORTING || t.stage === StageId.CALENDARING);
  }, []);

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.SORTING, authorId: currentUser.id,
      text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'incoming', label: `📥 Рулоны с каландра (${(incoming ?? []).length})` },
    { id: 'cut', label: '✂️ Нарезка' },
    { id: 'journal', label: `📒 Журнал нарезки (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <IncomingTab items={incoming ?? []} onOpen={(id) => { setSelectedId(id); setTab('cut'); }} />
      )}

      {tab === 'cut' && (
        <CutTab
          incoming={incoming ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          canForce={isTechManager}
          hasUser={!!currentUser}
          onSave={(run, forced) => {
            const fresh = { ...run, workerId: currentUser!.id, updatedAt: Date.now() };
            db.cuttingRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'cut-run', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
        />
      )}

      {tab === 'journal' && (
        <JournalTab
          runs={runs ?? []}
          incoming={incoming ?? []}
          canForce={isTechManager}
          onSend={(r, forced) => {
            const fresh = { ...r, updatedAt: Date.now() };
            db.cuttingRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'cut-run', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
        />
      )}

      {tab === 'comments' && <CommentsSection stage={StageId.SORTING} onAdd={addComment} />}

      <details className="bg-slate-800/60 border border-slate-700 rounded-lg p-3">
        <summary className="text-white text-sm font-medium cursor-pointer">📋 Задания этапа ({(tasks ?? []).length})</summary>
        <div className="mt-2 space-y-2">
          {(tasks ?? []).map((t) => (
            <div key={t.id} className="text-xs text-slate-300 border-b border-slate-700/50 pb-1">
              <span className="font-medium text-white">{t.title}</span> · статус: {t.status}
            </div>
          ))}
          {(tasks ?? []).length === 0 && <p className="text-xs text-slate-500">Заданий по этапу пока нет.</p>}
        </div>
      </details>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

// ---------- 📥 Входящие рулоны ----------
function IncomingTab({ items, onOpen }: { items: CuttingIncoming[]; onOpen: (id: string) => void }) {
  if (items.length === 0) {
    return (
      <div className="bg-slate-800/60 border border-dashed border-slate-700 rounded-lg p-6 text-center">
        <p className="text-slate-400 text-sm">Пока нет рулонов с каландра.</p>
        <p className="text-slate-500 text-xs mt-2">
          Рулон приходит пакетом «cutting-roll» (QR / текст / Bluetooth) от технолога или с участка прокатки.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {items.map((ci) => (
        <div key={ci.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-white font-semibold">
                🧻 {ci.roll.mixName}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  от {new Date(ci.createdAt).toLocaleString('ru-RU')}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
                <span className="px-2 py-0.5 rounded bg-indigo-900/60 text-indigo-200">{shapeLabel(ci.electrodeType)}</span>
                {ci.coatingType && <span>Покрытие: <b className="text-white">{ci.coatingType}</b></span>}
                {ci.electrodeLengthMm ? <span>L электрода: <b className="text-white">{ci.electrodeLengthMm} мм</b></span> : null}
                {ci.webWidthMm ? <span>Ширина полотна: <b className="text-white">{ci.webWidthMm} мм</b></span> : null}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                До прокатки: {ci.roll.thicknessBeforeUm ?? '—'} мкм · После: {ci.thicknessAfterUm ?? '—'} мкм ·
                Длина A: {ci.roll.sideALengthM ?? '—'} м · B: {ci.roll.sideBLengthM ?? '—'} м
                {ci.calender?.hasDefects ? <span className="text-amber-400"> · ⚠ дефекты прокатки</span> : null}
              </div>
              {ci.techNotes && <div className="mt-1 text-xs text-emerald-300">📝 Технолог: {ci.techNotes}</div>}
            </div>
            <button
              onClick={() => onOpen(ci.id)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white shrink-0"
            >
              ✂️ Резать
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- ✂️ Нарезка: калькулятор выхода + форма результата ----------
interface CalcResult {
  perMeter: number;   // пластин/полос с 1 м ленты
  usableM: number;    // доступная длина, м
  expected: number;   // ожидаемое количество
  kerfNote: string;
}

function calcYield(ci: CuttingIncoming, kerfMm: number): CalcResult {
  const lenMm = ci.electrodeLengthMm ?? 0;
  const totalM = (ci.roll.sideALengthM ?? 0) + (ci.roll.sideBLengthM ?? 0);
  const kerf = Math.max(kerfMm, 0);
  if (lenMm <= 0 || totalM <= 0) return { perMeter: 0, usableM: totalM, expected: 0, kerfNote: '' };
  if (ci.electrodeType === 'strip') {
    // полосы: лента режется поперёк, шаг = длина электрода + ширина ножа
    const pitch = lenMm + kerf;
    const perMeter = 1000 / pitch;
    return {
      perMeter, usableM: totalM, expected: Math.floor(totalM * perMeter),
      kerfNote: `шаг реза ${pitch.toFixed(1)} мм`,
    };
  }
  // призматические: сколько пластин влазит в ширину полотна + резы по длине
  const w = ci.webWidthMm ?? 0;
  if (w <= 0) return { perMeter: 0, usableM: totalM, expected: 0, kerfNote: '' };
  const cols = Math.floor((w + kerf) / (lenMm + kerf));
  const perMeter = Math.max(cols, 0) * (1000 / (lenMm + kerf));
  return {
    perMeter, usableM: totalM, expected: Math.floor(totalM * perMeter),
    kerfNote: `${Math.max(cols, 0)} шт в ряду по ширине полотна`,
  };
}

function CutTab({
  incoming, selectedId, onSelect, onSave, canForce, hasUser,
}: {
  incoming: CuttingIncoming[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSave: (run: CutRun, forced: boolean) => void;
  canForce: boolean;
  hasUser: boolean;
}) {
  const ci = incoming.find((i) => i.id === selectedId) ?? incoming[0] ?? null;
  const [kerfMm, setKerfMm] = useState(1);
  const [actualLen, setActualLen] = useState('');
  const [goodCount, setGoodCount] = useState('');
  const [defectCount, setDefectCount] = useState('');
  const [breaks, setBreaks] = useState('');
  const [defects, setDefects] = useState('');
  const [notes, setNotes] = useState('');

  const calc = useMemo(() => (ci ? calcYield(ci, Number(kerfMm) || 0) : null), [ci, kerfMm]);

  if (!ci) {
    return <p className="text-slate-400 text-sm">Нет входящих рулонов — дождитесь пакет «cutting-roll».</p>;
  }

  const save = (forced: boolean) => {
    if (!hasUser) return;
    const run: CutRun = {
      id: uuidv4(),
      incomingId: ci.id,
      electrodeType: ci.electrodeType,
      coatingType: ci.coatingType,
      electrodeLengthMm: actualLen ? Number(actualLen) : ci.electrodeLengthMm,
      goodCount: Number(goodCount) || 0,
      defectCount: Number(defectCount) || 0,
      breaks: breaks ? Number(breaks) : undefined,
      defects: defects.trim() || undefined,
      notes: notes.trim() || undefined,
      workerId: '', // заполняется в onSave из текущего пользователя
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    onSave(run, forced);
    setGoodCount(''); setDefectCount(''); setBreaks(''); setDefects(''); setNotes(''); setActualLen('');
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* Левая колонка: выбор рулона + расчёт */}
      <div className="space-y-3">
        <div className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-2">
          <label className={labelCls}>Рулон с каландра</label>
          <select className={inputCls} value={ci.id} onChange={(e) => onSelect(e.target.value)}>
            {incoming.map((i) => (
              <option key={i.id} value={i.id}>
                {i.roll.mixName} · {shapeLabel(i.electrodeType)} · {new Date(i.createdAt).toLocaleDateString('ru-RU')}
              </option>
            ))}
          </select>
          <div className="text-xs text-slate-400 leading-5">
            Покрытие: <b className="text-white">{ci.coatingType ?? '—'}</b><br />
            L электрода (задание): <b className="text-white">{ci.electrodeLengthMm ?? '—'} мм</b> ·
            Ширина полотна: <b className="text-white">{ci.webWidthMm ?? '—'} мм</b><br />
            Толщина после прокатки: <b className="text-white">{ci.thicknessAfterUm ?? '—'} мкм</b> ·
            Длина A+B: <b className="text-white">{(ci.roll.sideALengthM ?? 0) + (ci.roll.sideBLengthM ?? 0)} м</b>
            {ci.calender?.hasDefects && <span className="text-amber-400"> · ⚠ дефекты прокатки</span>}
          </div>
        </div>

        <div className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-2">
          <div className="text-white text-sm font-semibold">🧮 Расчёт выхода</div>
          <div>
            <label className={labelCls}>Ширина ножа / реза, мм</label>
            <input type="number" min={0} step={0.1} className={inputCls} value={kerfMm}
              onChange={(e) => setKerfMm(Number(e.target.value))} />
          </div>
          {calc && (
            <div className="rounded bg-slate-900 border border-slate-700 p-3 text-sm">
              <div className="flex justify-between text-slate-300"><span>С 1 метра ленты:</span><b className="text-white">{calc.perMeter.toFixed(1)} шт</b></div>
              <div className="flex justify-between text-slate-300"><span>Доступная длина:</span><b className="text-white">{calc.usableM.toFixed(1)} м</b></div>
              <div className="flex justify-between mt-1 pt-1 border-t border-slate-700"><span className="text-slate-200">Ожидаемо электродов:</span><b className="text-emerald-400 text-lg">{calc.expected} шт</b></div>
              {calc.kerfNote && <div className="text-xs text-slate-500 mt-1">{calc.kerfNote}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Правая колонка: фактический результат */}
      <div className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-3">
        <div className="text-white text-sm font-semibold">📝 Фактический результат нарезки</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Факт. длина, мм</label>
            <input type="number" className={inputCls} placeholder={String(ci.electrodeLengthMm ?? '')}
              value={actualLen} onChange={(e) => setActualLen(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Обрывы ленты</label>
            <input type="number" min={0} className={inputCls} placeholder="0"
              value={breaks} onChange={(e) => setBreaks(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Годных электродов *</label>
            <input type="number" min={0} className={inputCls} placeholder={calc ? String(calc.expected) : ''}
              value={goodCount} onChange={(e) => setGoodCount(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>С дефектами</label>
            <input type="number" min={0} className={inputCls} placeholder="0"
              value={defectCount} onChange={(e) => setDefectCount(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Виды дефектов</label>
          <textarea rows={2} className={inputCls} placeholder="Бахромка кромки, заусенцы, скол покрытия…"
            value={defects} onChange={(e) => setDefects(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Примечание</label>
          <textarea rows={2} className={inputCls} placeholder="Партия, номер станка…"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={() => save(false)}
            disabled={!hasUser || !goodCount}
            className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 rounded text-sm text-white"
          >
            💾 Сохранить и отправить на сортировку (QR/текст/BLE)
          </button>
          {canForce && (
            <button
              onClick={() => save(true)}
              disabled={!hasUser || !goodCount}
              className="px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-40 rounded text-sm text-white"
              title="Принудительная запись master'ом во все slave-устройства"
            >
              👑 Принудительно (master)
            </button>
          )}
        </div>
        {!hasUser && <p className="text-xs text-amber-400">Войдите в профиль, чтобы сохранить результат.</p>}
      </div>
    </div>
  );
}

// ---------- 📒 Журнал нарезки ----------
function JournalTab({
  runs, incoming, canForce, onSend,
}: {
  runs: CutRun[];
  incoming: CuttingIncoming[];
  canForce: boolean;
  onSend: (r: CutRun, forced: boolean) => void;
}) {
  const mixNameOf = (run: CutRun) =>
    incoming.find((i) => i.id === run.incomingId)?.roll.mixName ?? 'рулон не принят';

  if (runs.length === 0) {
    return <p className="text-slate-400 text-sm">Записей журнала пока нет. Нарежьте рулон на вкладке «✂️ Нарезка».</p>;
  }
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <div key={r.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="text-sm">
              <div className="text-white font-semibold">✂️ {mixNameOf(r)}</div>
              <div className="text-xs text-slate-400 mt-0.5">
                {new Date(r.createdAt).toLocaleString('ru-RU')} · {shapeLabel(r.electrodeType)}
                {r.coatingType ? ` · ${r.coatingType}` : ''}
                {r.electrodeLengthMm ? ` · L=${r.electrodeLengthMm} мм` : ''}
              </div>
              <div className="mt-1 text-xs">
                <span className="text-emerald-400 font-semibold">Годных: {r.goodCount}</span>{' '}
                <span className={r.defectCount ? 'text-rose-400 font-semibold' : 'text-slate-500'}>Дефектных: {r.defectCount}</span>{' '}
                {r.breaks ? <span className="text-amber-400">· Обрывов: {r.breaks}</span> : null}
              </div>
              {r.defects && <div className="mt-1 text-xs text-rose-300">⚠ {r.defects}</div>}
              {r.notes && <div className="mt-1 text-xs text-slate-400">📝 {r.notes}</div>}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => onSend(r, false)}
                className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white"
                title="Партия нарезки → сортировка (QR/текст/Bluetooth)"
              >
                📤 На сортировку
              </button>
              {canForce && (
                <button
                  onClick={() => onSend(r, true)}
                  className="px-2.5 py-1 bg-purple-700 hover:bg-purple-600 rounded text-xs text-white"
                  title="Принудительная рассылка master → slave"
                >
                  👑 Master
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
