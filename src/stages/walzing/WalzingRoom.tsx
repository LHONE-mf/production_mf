// Комната «Вальцовка» — обжим (вальцевание) залитых цилиндрических ячеек.
// Расположена ПОСЛЕ заливки на 7 этаже (к.5): партии приходят пакетом
// walzing-in, результат уходит на формирование/master пакетом walz-run.
// Вкладки: 📥 партии с заливки / ✍️ новая вальцовка / 📒 журнал / 💬 комментарии.
// Параметры станка — первичная структура, будет расширена по описанию процесса.

import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import { WalzingIncoming, WalzRun, SerialRange, FormationIncoming, SyncPacket, StageId, UserRole } from '../../core/types';
import { db } from '../../core/db';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

export function WalzingRoom() {
  const stage = StageId.WALZING;
  const currentUser = useAuthStore((s) => s.currentUser);
  const isMaster = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  // Входящие партии залитых ячеек (из бокса 7 эт./к.5)
  const incoming = useLiveQuery(async () => {
    const all = await db.walzingIncoming.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);
  // Журнал вальцовки (свежие сверху)
  const runs = useLiveQuery(async () => {
    const all = await db.walzRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  // ------- форма записи вальцовки -------
  const emptyForm = {
    batchName: '', machineNo: '', incomingDiameter: '', finalDiameter: '',
    passes: '', pressureKgf: '', speedRpm: '', temperatureC: '',
    cellsIn: '', cellsOut: '', cellsScrap: '', defects: '', comment: '',
  };
  const [form, setForm] = useState(emptyForm);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const [incomingSerial, setIncomingSerial] = useState<{ id: string; sr?: SerialRange } | null>(null);
  const takeIncoming = (wi: WalzingIncoming) => {
    setForm((f) => ({ ...f, batchName: wi.batchName, cellsIn: String(wi.cellsIn) }));
    setIncomingSerial({ id: wi.id, sr: wi.serialRange }); // номера АК мигрируют с заливки
    setTab('new');
  };

  const saveRun = async (sendAfter: boolean) => {
    if (!currentUser || !form.batchName.trim()) return;
    const now = new Date().toISOString();
    const run: WalzRun = {
      id: uuidv4(),
      batchName: form.batchName.trim(),
      serialRange: incomingSerial?.sr,
      machineNo: form.machineNo.trim() || undefined,
      incomingDiameter: form.incomingDiameter ? Number(form.incomingDiameter) : undefined,
      finalDiameter: form.finalDiameter ? Number(form.finalDiameter) : undefined,
      passes: form.passes ? Number(form.passes) : undefined,
      pressureKgf: form.pressureKgf ? Number(form.pressureKgf) : undefined,
      speedRpm: form.speedRpm ? Number(form.speedRpm) : undefined,
      temperatureC: form.temperatureC ? Number(form.temperatureC) : undefined,
      cellsIn: Number(form.cellsIn) || 0,
      cellsOut: Number(form.cellsOut) || 0,
      cellsScrap: Number(form.cellsScrap) || 0,
      defects: form.defects.split(',').map((s) => s.trim()).filter(Boolean),
      comment: form.comment.trim() || undefined,
      workerId: currentUser.id, createdAt: now, updatedAt: now,
    };
    await db.walzRuns.add(run);
    // дублируем в общий журнал комнат (единица учёта для KPI)
    await db.journal.add({
      id: uuidv4(), stage, taskId: undefined, workerId: currentUser.id,
      params: { ...run }, defects: run.defects, createdAt: new Date(),
    } as any);
    if (sendAfter) setOutPacket({
      v: 1, type: 'walz-run', stage, payload: run,
      from: currentUser.id, ts: Date.now(), forced: isMaster || undefined,
    });
    setForm(emptyForm);
    setTab('journal');
  };

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 С заливки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая вальцовка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-2xl">🎡</span>
        <h2 className="text-white font-semibold">Вальцовка (обжим залитых ячеек)</h2>
      </div>
      <p className="text-xs text-slate-400">
        Пост после заливки на 7 этаже (к.5). Ячейки обжимаются на вальцовочном станке
        до итогового диаметра и передаются на формирование.
      </p>

      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`text-xs rounded-lg px-3 py-1.5 ${tab === t.id ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="grid gap-2">
          {(incoming ?? []).length === 0 && (
            <p className="text-slate-500 text-sm">
              Пока нет партий с заливки. Они приходят пакетом «walzing-in» (Bluetooth/QR/текст)
              из бокса «Заливка (7 эт. / к.5)» — кнопка «🎡 На вальцовку ▸» в журнале заливки.
            </p>
          )}
          {incoming!.map((wi) => (
            <div key={wi.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-white font-medium">{wi.batchName}</span>
                <button onClick={() => takeIncoming(wi)}
                  className="text-xs bg-amber-700 hover:bg-amber-600 text-white rounded px-2 py-1">Взять в работу ▸</button>
              </div>
              <div className="text-xs text-slate-300">
                принято <b className="text-emerald-300">{wi.cellsIn}</b> яч. · {wi.electrolyteName ?? 'электролит не указан'}
              </div>
              <div className="text-[11px] text-slate-500">{new Date(wi.receivedAt).toLocaleString('ru-RU')}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'new' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-3">
          <div><label className={labelCls}>Партия (название) *</label>
            <input className={inputCls} value={form.batchName} onChange={set('batchName')} placeholder="напр. ЦЦ-21700 партия №3" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>Станок №</label>
              <input className={inputCls} value={form.machineNo} onChange={set('machineNo')} /></div>
            <div><label className={labelCls}>Кол-во проходов</label>
              <input className={inputCls} type="number" value={form.passes} onChange={set('passes')} /></div>
            <div><label className={labelCls}>Диаметр до, мм</label>
              <input className={inputCls} type="number" step="0.01" value={form.incomingDiameter} onChange={set('incomingDiameter')} /></div>
            <div><label className={labelCls}>Диаметр после, мм</label>
              <input className={inputCls} type="number" step="0.01" value={form.finalDiameter} onChange={set('finalDiameter')} /></div>
            <div><label className={labelCls}>Усилие обжима, кгс</label>
              <input className={inputCls} type="number" value={form.pressureKgf} onChange={set('pressureKgf')} /></div>
            <div><label className={labelCls}>Скорость, об/мин</label>
              <input className={inputCls} type="number" value={form.speedRpm} onChange={set('speedRpm')} /></div>
            <div><label className={labelCls}>Температура, °C</label>
              <input className={inputCls} type="number" value={form.temperatureC} onChange={set('temperatureC')} /></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className={labelCls}>Подано ячеек</label>
              <input className={inputCls} type="number" value={form.cellsIn} onChange={set('cellsIn')} /></div>
            <div><label className={labelCls}>Годных</label>
              <input className={inputCls} type="number" value={form.cellsOut} onChange={set('cellsOut')} /></div>
            <div><label className={labelCls}>Брак</label>
              <input className={inputCls} type="number" value={form.cellsScrap} onChange={set('cellsScrap')} /></div>
          </div>
          <div><label className={labelCls}>Дефекты (через запятую: разрыв, мятость, недобор диаметра…)</label>
            <input className={inputCls} value={form.defects} onChange={set('defects')} /></div>
          <div><label className={labelCls}>Примечание</label>
            <input className={inputCls} value={form.comment} onChange={set('comment')} /></div>
          <div className="flex gap-2">
            <button onClick={() => saveRun(false)} className="bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить в журнал
            </button>
            <button onClick={() => saveRun(true)} className="bg-cyan-700 hover:bg-cyan-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить и передать на формирование ▸
            </button>
          </div>
        </div>
      )}

      {tab === 'journal' && (
        <div className="grid gap-2">
          {(runs ?? []).length === 0 && <p className="text-slate-500 text-sm">Журнал пуст.</p>}
          {runs!.map((r) => (
            <div key={r.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-white font-medium">{r.batchName}</span>
                <button onClick={() => {
                    if (!currentUser) return;
                    const now = new Date().toISOString();
                    const fi: FormationIncoming = {
                      id: r.id, sourceBox: 'walzing', batchName: r.batchName,
                      serialRange: r.serialRange, cellsIn: r.cellsOut,
                      fromWalzRunId: r.id, receivedAt: now, updatedAt: now,
                    };
                    setOutPacket({ v: 1, type: 'formation-in', stage: StageId.FORMATION, payload: fi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                  }}
                    className="text-xs bg-violet-800 hover:bg-violet-700 text-white rounded px-2 py-1"
                    title="Отправить партию (с номерами АК) на формирование">⚡ На формовку ▸</button>
                <button onClick={() => setOutPacket({ v: 1, type: 'walz-run', stage, payload: r, from: currentUser?.id ?? 'unknown', ts: Date.now(), forced: isMaster || undefined })}
                  className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
              </div>
              <div className="text-xs text-slate-300">
                станок {r.machineNo ?? '—'} · ⌀ {num(r.incomingDiameter)} → {num(r.finalDiameter, ' мм')} · проходов {num(r.passes)} · усилие {num(r.pressureKgf, ' кгс')} · {num(r.speedRpm, ' об/мин')} · t {num(r.temperatureC, ' °C')}
              </div>
              <div className="text-xs text-slate-300">
                подано {r.cellsIn} · годных <b className="text-emerald-300">{r.cellsOut}</b> · брак <b className="text-rose-300">{r.cellsScrap}</b>
              </div>
              {r.defects.length > 0 && <div className="text-xs text-rose-300">Дефекты: {r.defects.join(', ')}</div>}
              {r.comment && <div className="text-xs text-slate-400">«{r.comment}»</div>}
              <div className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsSection stage={stage} onAdd={async (text) => {
          if (!currentUser) return;
          await db.stageComments.add({ id: uuidv4(), stage, authorId: currentUser.id, text, createdAt: new Date() } as any);
        }} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
