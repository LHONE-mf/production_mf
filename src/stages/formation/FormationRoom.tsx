// ============================================================
// КОМНАТА ФОРМИРОВАНИЯ (ЧЦЦ — формовка залитых ячеек).
// Вход: партии из ЗАЛИВКИ В СУХОЙ КОМНАТЕ и с ВАЛЬЦОВКИ (пакет formation-in),
// вместе с партиями мигрируют НОМЕРА АККУМУЛЯТОРОВ (задаются на сборке).
// Журнал формировки: дата начала, режим (ток / напряжение / кол-во циклов),
// кулоновская эффективность, ёмкость 5-го цикла, годные/брак/дефекты.
// Результат уходит на старение/master пакетом formation-run.
// ============================================================
import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  StageId, SyncPacket, UserRole, FormationIncoming, FormationRun, FormationMode,
  serialRangeLabel,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';
const todayISO = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  batchName: '', prefix: '', start: '', end: '',
  currentA: '', voltageV: '', cycles: '5',
  startDate: todayISO(), endDate: '',
  coulombEff: '', capacity5: '',
  cellsIn: '', cellsOut: '', cellsScrap: '', defects: '', comment: '',
};

export function FormationModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isMaster = !!currentUser && [UserRole.MASTER, UserRole.TECHNOLOGIST, UserRole.CHIEF].includes(currentUser.role);
  const stage = StageId.FORMATION;
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [takenFrom, setTakenFrom] = useState<FormationIncoming | null>(null);

  const incoming = useLiveQuery(async () => {
    const all = await db.formationIncoming.toArray();
    return all.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  }, []);
  const runs = useLiveQuery(async () => {
    const all = await db.formationRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // Взять входящую партию в работу: номера АК подхватываются автоматически (миграция)
  const takeIncoming = (fi: FormationIncoming) => {
    setForm((f) => ({
      ...f,
      batchName: fi.batchName,
      cellsIn: String(fi.cellsIn),
      prefix: fi.serialRange?.prefix ?? '',
      start: fi.serialRange ? String(fi.serialRange.start) : '',
      end: fi.serialRange ? String(fi.serialRange.end) : '',
    }));
    setTakenFrom(fi);
    setTab('new');
  };

  const saveRun = async (sendAfter: boolean) => {
    if (!currentUser || !form.batchName.trim()) return;
    const now = new Date().toISOString();
    const ss = Number(form.start); const se = Number(form.end);
    const sr = (Number.isFinite(ss) && Number.isFinite(se) && se >= ss)
      ? { prefix: form.prefix.trim() || undefined, start: ss, end: se } : undefined;
    const mode: FormationMode = {
      currentA: form.currentA ? Number(form.currentA) : undefined,
      voltageV: form.voltageV ? Number(form.voltageV) : undefined,
      cycles: Number(form.cycles) || 0,
    };
    const run: FormationRun = {
      id: uuidv4(),
      batchName: form.batchName.trim(),
      serialRange: sr,
      mode,
      startDate: form.startDate || todayISO(),
      endDate: form.endDate || undefined,
      coulombEfficiencyPct: form.coulombEff ? Number(form.coulombEff) : undefined,
      capacityCycle5Ah: form.capacity5 ? Number(form.capacity5) : undefined,
      cellsIn: Number(form.cellsIn) || 0,
      cellsOut: Number(form.cellsOut) || 0,
      cellsScrap: Number(form.cellsScrap) || 0,
      defects: form.defects.split(',').map((x) => x.trim()).filter(Boolean),
      comment: form.comment.trim() || undefined,
      workerId: currentUser.id, createdAt: now, updatedAt: now,
    };
    await db.formationRuns.add(run);
    // дублируем в общий журнал комнат (единица учёта для KPI)
    await db.journal.add({
      id: uuidv4(), stage, taskId: undefined, workerId: currentUser.id,
      params: { ...run }, defects: run.defects, createdAt: new Date(),
    } as any);
    if (sendAfter) setOutPacket({
      v: 1, type: 'formation-run', stage, payload: run,
      from: currentUser.id, ts: Date.now(), forced: isMaster || undefined,
    });
    setForm(emptyForm);
    setTakenFrom(null);
    setTab('journal');
  };

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 С заливки/вальцовки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая формовка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">⚡ Формирование (ЧЦЦ)</h2>
      <p className="text-xs text-slate-400">
        Номера аккумуляторов приходят вместе с партией (миграция: сборка → заливка → формирование).
        Режим задаёт технолог: ток, напряжение, количество циклов.
      </p>

      <div className="flex gap-1 flex-wrap border-b border-slate-800 pb-2">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-t text-xs ${tab === t.id ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- ВХОДЯЩИЕ ПАРТИИ ---- */}
      {tab === 'incoming' && (
        <div className="space-y-2">
          {(incoming ?? []).length === 0 && (
            <div className="text-sm text-slate-500">Пока нет партий. Придут с заливки (сухая комната) или с вальцовки пакетами QR/BLE/текст.</div>
          )}
          {(incoming ?? []).map((fi) => (
            <div key={fi.id} className="bg-slate-800/60 border border-slate-700 rounded p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm text-white font-semibold">{fi.batchName}</div>
                <button onClick={() => takeIncoming(fi)}
                  className="text-xs bg-violet-700 hover:bg-violet-600 text-white rounded px-2 py-1">Взять в формовку ▸</button>
              </div>
              <div className="text-xs text-slate-300 mt-1">
                Источник: {fi.sourceBox === 'dry-room' ? '💧 Заливка (сухая комната)' : fi.sourceBox === 'floor7-room5' ? '🏭 Заливка (7 эт./к.5)' : '🎡 Вальцовка'} ·
                ячеек: {fi.cellsIn} · №АК: <b>{serialRangeLabel(fi.serialRange)}</b>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- НОВАЯ ФОРМОВКА ---- */}
      {tab === 'new' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl">
          {takenFrom && (
            <div className="md:col-span-2 text-xs bg-violet-900/40 border border-violet-700 rounded p-2">
              Партия «{takenFrom.batchName}» взята с {takenFrom.sourceBox === 'dry-room' ? 'заливки в сухой комнате' : takenFrom.sourceBox === 'floor7-room5' ? 'заливки (7 эт.)' : 'вальцовки'};
              номера АК подставлены автоматически.
            </div>
          )}
          <div><label className={labelCls}>Партия (название)</label>
            <input className={inputCls} value={form.batchName} onChange={set('batchName')} placeholder="напр. ПАРТ-2026-041" /></div>
          <div><label className={labelCls}>Номера АК: префикс / нач. / кон.</label>
            <span className="flex gap-1">
              <input className={inputCls + ' w-20'} value={form.prefix} onChange={set('prefix')} placeholder="MF-" />
              <input className={inputCls + ' w-24'} type="number" value={form.start} onChange={set('start')} placeholder="1001" />
              <input className={inputCls + ' w-24'} type="number" value={form.end} onChange={set('end')} placeholder="1200" />
            </span></div>

          <div className="md:col-span-2 text-xs font-semibold text-slate-300 pt-1">Режим формировки (задаёт технолог)</div>
          <div><label className={labelCls}>Ток, А</label>
            <input className={inputCls} type="number" step="0.1" value={form.currentA} onChange={set('currentA')} placeholder="напр. 1.0" /></div>
          <div><label className={labelCls}>Напряжение (отсечка), В</label>
            <input className={inputCls} type="number" step="0.01" value={form.voltageV} onChange={set('voltageV')} placeholder="напр. 4.25" /></div>
          <div><label className={labelCls}>Количество циклов</label>
            <input className={inputCls} type="number" value={form.cycles} onChange={set('cycles')} /></div>

          <div><label className={labelCls}>Дата начала формировки</label>
            <input className={inputCls} type="date" value={form.startDate} onChange={set('startDate')} /></div>
          <div><label className={labelCls}>Дата окончания (необязательно)</label>
            <input className={inputCls} type="date" value={form.endDate} onChange={set('endDate')} /></div>

          <div><label className={labelCls}>Кулоновская эффективность, %</label>
            <input className={inputCls} type="number" step="0.1" value={form.coulombEff} onChange={set('coulombEff')} placeholder="напр. 98.5" /></div>
          <div><label className={labelCls}>Ёмкость 5-го цикла, А·ч</label>
            <input className={inputCls} type="number" step="0.01" value={form.capacity5} onChange={set('capacity5')} placeholder="напр. 2.6" /></div>

          <div><label className={labelCls}>Подано ячеек</label>
            <input className={inputCls} type="number" value={form.cellsIn} onChange={set('cellsIn')} /></div>
          <div><label className={labelCls}>Годных после формовки</label>
            <input className={inputCls} type="number" value={form.cellsOut} onChange={set('cellsOut')} /></div>
          <div><label className={labelCls}>Брак</label>
            <input className={inputCls} type="number" value={form.cellsScrap} onChange={set('cellsScrap')} /></div>
          <div><label className={labelCls}>Дефекты (через запятую)</label>
            <input className={inputCls} value={form.defects} onChange={set('defects')} placeholder="вздутие, недобор ёмкости" /></div>
          <div className="md:col-span-2"><label className={labelCls}>Комментарий</label>
            <input className={inputCls} value={form.comment} onChange={set('comment')} /></div>

          <div className="md:col-span-2 flex gap-2">
            <button onClick={() => saveRun(false)}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white">💾 Сохранить в журнал</button>
            <button onClick={() => saveRun(true)}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm text-white">💾 И отправить (QR/BLE/текст)</button>
          </div>
        </div>
      )}

      {/* ---- ЖУРНАЛ ---- */}
      {tab === 'journal' && (
        <div className="space-y-2">
          {(runs ?? []).length === 0 && <div className="text-sm text-slate-500">Журнал пуст.</div>}
          {(runs ?? []).map((r) => (
            <div key={r.id} className="bg-slate-800/60 border border-slate-700 rounded p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm text-white font-semibold">{r.batchName}</div>
                <div className="flex gap-1.5">
                  <button onClick={() => setOutPacket({ v: 1, type: 'formation-run', stage, payload: r, from: currentUser?.id ?? 'unknown', ts: Date.now(), forced: isMaster || undefined })}
                    className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
                </div>
              </div>
              <div className="text-xs text-slate-300 mt-1">
                №АК: <b>{serialRangeLabel(r.serialRange)}</b> · начало {r.startDate}{r.endDate ? ` → ${r.endDate}` : ''} ·
                режим: {num(r.mode.currentA, ' А')} / {num(r.mode.voltageV, ' В')} / {r.mode.cycles} цикл.
              </div>
              <div className="text-xs text-slate-300">
                КЭ: {num(r.coulombEfficiencyPct, ' %')} · ёмкость 5-го цикла: {num(r.capacityCycle5Ah, ' А·ч')} ·
                подано {r.cellsIn}, годных {r.cellsOut}, брак {r.cellsScrap}
                {r.defects.length > 0 && <> · дефекты: {r.defects.join(', ')}</>}
              </div>
              {r.comment && <div className="text-xs text-slate-400 mt-1 italic">{r.comment}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ---- КОММЕНТАРИИ ---- */}
      {tab === 'comments' && (
        <CommentsSection stage={stage} onAdd={addComment} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

