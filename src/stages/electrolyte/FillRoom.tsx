// Комната «Заливка электролита» — ОДНО помещение (боксы).
// Инстанцируется дважды в StageRouter:
//   <FillRoom box="dry-room" />     — бокс сухой комнаты;
//   <FillRoom box="floor7-room5" /> — бокс на 7 этаже, комната 5.
// Вход: партии ячеек со СБОРКИ (assembly-run → кнопка «Отправить в заливку»,
// пакет electrolyte-in). Журнал: FillRun (дозировка, вакуум, давление,
// выдержка, температура, влажность) + дефекты. Результат уходит master'у /
// на формирование пакетом fill-run. Детали помещений будут расширены позже.

import React, { useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ElectrolyteBox, ElectrolyteIncoming, FillRun, FormationIncoming, SyncPacket, StageId, UserRole,
  WalzingIncoming,
} from '../../core/types';
import { db } from '../../core/db';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export const BOX_META: Record<ElectrolyteBox, { title: string; icon: string; stage: StageId }> = {
  'dry-room':      { title: 'Заливка электролита · сухая комната', icon: '💧', stage: StageId.ELECTROLYTE },
  'floor7-room5':  { title: 'Заливка электролита · 7 этаж, к.5',   icon: '🏭', stage: StageId.ELECTROLYTE_705 },
};

interface Props { box: ElectrolyteBox; }

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

export function FillRoom({ box }: Props) {
  const meta = BOX_META[box];
  const currentUser = useAuthStore((s) => s.currentUser);
  const isMaster = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  // Входящие партии именно этого помещения
  const incoming = useLiveQuery(
    () => db.electrolyteIncoming.where('box').equals(box).toArray(),
    [box],
  );
  // Журнал заливки этого помещения (свежие сверху)
  const runs = useLiveQuery(async () => {
    const all = await db.fillRuns.where('box').equals(box).toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [box]);

  // Ячейки со сборки, ещё не отправленные ни в один бокс заливки
  const assemblyRuns = useLiveQuery(() => db.assemblyRuns.toArray(), []);
  const notSentYet = useMemo(() => {
    const sentNames = new Set((incoming ?? []).map((i) => i.batchName));
    return (assemblyRuns ?? []).filter((r) => r.cellsOut > 0 && !sentNames.has(r.batchName));
  }, [assemblyRuns, incoming]);

  const sendToBox = (arId: string) => {
    if (!currentUser) return;
    const ar = (assemblyRuns ?? []).find((x) => x.id === arId);
    if (!ar) return;
    const ei: ElectrolyteIncoming = {
      id: uuidv4(), box, batchName: ar.batchName, cellType: ar.cellType,
      serialRange: ar.serialRange,   // номера аккумуляторов мигрируют со сборки
      cellsIn: ar.cellsOut, fromAssemblyRunId: ar.id,
      receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const packet: SyncPacket = {
      v: 1, type: 'electrolyte-in', stage: meta.stage, payload: ei,
      from: currentUser.id, ts: Date.now(), forced: isMaster || undefined,
    };
    setOutPacket(packet);
  };

  // ------- форма записи заливки -------
  const [form, setForm] = useState({
    batchName: '', serialPrefix: '', serialStart: '', serialEnd: '',
    electrolyteName: '', doseMin: '', doseActual: '',
    vacuumKpa: '', pressureKpa: '', dwellMin: '', temperatureC: '', humidityPpm: '',
    cellsFilled: '', cellsScrap: '', defects: '', comment: '',
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const saveRun = async (sendAfter: boolean) => {
    if (!currentUser || !form.batchName.trim()) return;
    const now = new Date().toISOString();
    const ss = Number(form.serialStart); const se = Number(form.serialEnd);
    const sr = (Number.isFinite(ss) && Number.isFinite(se) && se >= ss)
      ? { prefix: form.serialPrefix.trim() || undefined, start: ss, end: se } : undefined;
    const run: FillRun = {
      id: uuidv4(), box, batchName: form.batchName.trim(),
      serialRange: sr,
      electrolyteName: form.electrolyteName.trim() || undefined,
      doseMin: form.doseMin ? Number(form.doseMin) : undefined,
      doseActual: form.doseActual ? Number(form.doseActual) : undefined,
      vacuumKpa: form.vacuumKpa ? Number(form.vacuumKpa) : undefined,
      pressureKpa: form.pressureKpa ? Number(form.pressureKpa) : undefined,
      dwellMin: form.dwellMin ? Number(form.dwellMin) : undefined,
      temperatureC: form.temperatureC ? Number(form.temperatureC) : undefined,
      humidityPpm: form.humidityPpm ? Number(form.humidityPpm) : undefined,
      cellsFilled: Number(form.cellsFilled) || 0,
      cellsScrap: Number(form.cellsScrap) || 0,
      defects: form.defects.split(',').map((s) => s.trim()).filter(Boolean),
      comment: form.comment.trim() || undefined,
      workerId: currentUser.id, createdAt: now, updatedAt: now,
    };
    await db.fillRuns.add(run);
    // дублируем в общий журнал комнат (единица учёта для KPI)
    await db.journal.add({
      id: uuidv4(), stage: meta.stage, taskId: undefined, workerId: currentUser.id,
      params: { ...run }, defects: run.defects, createdAt: new Date(),
    } as any);
    if (sendAfter) setOutPacket({
      v: 1, type: 'fill-run', stage: meta.stage, payload: run,
      from: currentUser.id, ts: Date.now(), forced: isMaster || undefined,
    });
    setForm({ batchName: '', serialPrefix: '', serialStart: '', serialEnd: '', electrolyteName: '', doseMin: '', doseActual: '', vacuumKpa: '', pressureKpa: '', dwellMin: '', temperatureC: '', humidityPpm: '', cellsFilled: '', cellsScrap: '', defects: '', comment: '' });
    setTab('journal');
  };

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 Принято со сборки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая заливка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-2xl">{meta.icon}</span>
        <h2 className="text-white font-semibold">{meta.title}</h2>
      </div>

      <div className="flex flex-wrap gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${tab === t.id ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">Партии со сборки можно отправить в этот бокс прямо здесь (офлайн-пакет electrolyte-in через Bluetooth/QR/текст).</p>
          {notSentYet.length > 0 && (
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <h3 className="text-white text-sm font-medium">🔋 Готовы на сборке (ещё не отправлены):</h3>
              {notSentYet.map((ar) => (
                <div key={ar.id} className="flex items-center justify-between gap-2 bg-slate-900 rounded-lg px-3 py-2">
                  <span className="text-slate-200 text-sm truncate">{ar.batchName} · {ar.cellsOut} яч.</span>
                  <button onClick={() => sendToBox(ar.id)}
                    className="shrink-0 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded px-2 py-1">
                    Отправить в этот бокс ▸
                  </button>
                </div>
              ))}
            </div>
          )}
          {(incoming ?? []).length === 0 ? (
            <p className="text-slate-500 text-sm">Пока ничего не принято в этот бокс.</p>
          ) : (
            <div className="grid gap-2">
              {incoming!.map((i) => (
                <div key={i.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-white font-medium">{i.batchName}</span>
                    <span className="text-cyan-300">{i.cellsIn} ячеек</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {i.cellType === 'cylindrical' ? 'цилиндрические' : i.cellType === 'prismatic' ? 'призматические' : 'тип не указан'} · принято {new Date(i.receivedAt).toLocaleString('ru-RU')}
                  </div>
                  <button onClick={() => { setForm((f) => ({ ...f, batchName: i.batchName, cellsFilled: String(i.cellsIn) })); setTab('new'); }}
                    className="mt-2 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded px-2 py-1">
                    Взять в заливку ✍️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'new' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Партия (название)</label>
              <input className={inputCls} value={form.batchName} onChange={set('batchName')} placeholder="напр. ПАРТ-2026-041" /></div>
            <div><label className={labelCls}>Номера АК: префикс / нач. / кон.</label>
              <span className="flex gap-1">
                <input className={inputCls + ' w-20'} value={form.serialPrefix} onChange={set('serialPrefix')} placeholder="MF-" />
                <input className={inputCls + ' w-24'} type="number" value={form.serialStart} onChange={set('serialStart')} placeholder="1001" />
                <input className={inputCls + ' w-24'} type="number" value={form.serialEnd} onChange={set('serialEnd')} placeholder="1200" />
              </span></div>
            <div><label className={labelCls}>Марка электролита</label>
              <input className={inputCls} value={form.electrolyteName} onChange={set('electrolyteName')} placeholder="напр. LiPF6 EC/DMC" /></div>
            <div><label className={labelCls}>Доза целевая, мг</label>
              <input className={inputCls} type="number" value={form.doseMin} onChange={set('doseMin')} /></div>
            <div><label className={labelCls}>Доза фактическая, мг</label>
              <input className={inputCls} type="number" value={form.doseActual} onChange={set('doseActual')} /></div>
            <div><label className={labelCls}>Вакуум пропитки, кПа</label>
              <input className={inputCls} type="number" value={form.vacuumKpa} onChange={set('vacuumKpa')} /></div>
            <div><label className={labelCls}>Давление впрыска, кПа</label>
              <input className={inputCls} type="number" value={form.pressureKpa} onChange={set('pressureKpa')} /></div>
            <div><label className={labelCls}>Выдержка, мин</label>
              <input className={inputCls} type="number" value={form.dwellMin} onChange={set('dwellMin')} /></div>
            <div><label className={labelCls}>Температура, °C</label>
              <input className={inputCls} type="number" value={form.temperatureC} onChange={set('temperatureC')} /></div>
            <div><label className={labelCls}>Влажность бокса (точка росы/ppm)</label>
              <input className={inputCls} type="number" value={form.humidityPpm} onChange={set('humidityPpm')} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={labelCls}>Залито годных</label>
                <input className={inputCls} type="number" value={form.cellsFilled} onChange={set('cellsFilled')} /></div>
              <div><label className={labelCls}>Брак</label>
                <input className={inputCls} type="number" value={form.cellsScrap} onChange={set('cellsScrap')} /></div>
            </div>
          </div>
          <div><label className={labelCls}>Дефекты (через запятую: недолив, пузыри, подтекание…)</label>
            <input className={inputCls} value={form.defects} onChange={set('defects')} /></div>
          <div><label className={labelCls}>Примечание</label>
            <input className={inputCls} value={form.comment} onChange={set('comment')} /></div>
          <div className="flex gap-2">
            <button onClick={() => saveRun(false)} className="bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить в журнал
            </button>
            <button onClick={() => saveRun(true)} className="bg-cyan-700 hover:bg-cyan-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить и передать ▸
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
                <div className="flex gap-1">
                  {/* только бокс 7 эт./к.5 передаёт залитые ячейки на вальцовку */}
                  {box === 'floor7-room5' && r.cellsFilled > 0 && (
                    <button onClick={() => {
                      if (!currentUser) return;
                      const now = new Date().toISOString();
                      const wi: WalzingIncoming = {
                        id: r.id, batchName: r.batchName, cellType: undefined,
                        serialRange: r.serialRange,
                        cellsIn: r.cellsFilled, electrolyteName: r.electrolyteName,
                        fromFillRunId: r.id, receivedAt: now, updatedAt: now,
                      };
                      setOutPacket({ v: 1, type: 'walzing-in', stage: StageId.WALZING, payload: wi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                    }}
                      className="text-xs bg-amber-800 hover:bg-amber-700 text-white rounded px-2 py-1"
                      title="Отправить партию залитых ячеек на вальцовку">🎡 На вальцовку ▸</button>
                  )}
                  {box === 'dry-room' && r.cellsFilled > 0 && (
                    <button onClick={() => {
                      if (!currentUser) return;
                      const now = new Date().toISOString();
                      const fi: FormationIncoming = {
                        id: r.id, sourceBox: box, batchName: r.batchName,
                        serialRange: r.serialRange, cellsIn: r.cellsFilled,
                        fromFillRunId: r.id, receivedAt: now, updatedAt: now,
                      };
                      setOutPacket({ v: 1, type: 'formation-in', stage: StageId.FORMATION, payload: fi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                    }}
                      className="text-xs bg-violet-800 hover:bg-violet-700 text-white rounded px-2 py-1"
                      title="Отправить партию (с номерами АК) на формирование">⚡ На формовку ▸</button>
                  )}
                  <button onClick={() => setOutPacket({ v: 1, type: 'fill-run', stage: meta.stage, payload: r, from: currentUser?.id ?? 'unknown', ts: Date.now(), forced: isMaster || undefined })}
                    className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
                </div>
              </div>
              <div className="text-xs text-slate-300">
                {r.electrolyteName ?? 'электролит не указан'} · доза {num(r.doseActual)} / {num(r.doseMin, ' мг')} · вакуум {num(r.vacuumKpa, ' кПа')} · давление {num(r.pressureKpa, ' кПа')}
              </div>
              <div className="text-xs text-slate-300">
                выдержка {num(r.dwellMin, ' мин')} · t {num(r.temperatureC, ' °C')} · влажн. {num(r.humidityPpm)} · залито <b className="text-emerald-300">{r.cellsFilled}</b> · брак <b className="text-rose-300">{r.cellsScrap}</b>
              </div>
              {r.defects.length > 0 && <div className="text-xs text-rose-300">Дефекты: {r.defects.join(', ')}</div>}
              {r.comment && <div className="text-xs text-slate-400">«{r.comment}»</div>}
              <div className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsSection stage={meta.stage} onAdd={async (text) => {
          if (!currentUser) return;
          await db.stageComments.add({ id: uuidv4(), stage: meta.stage, authorId: currentUser.id, text, createdAt: new Date() } as any);
        }} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
