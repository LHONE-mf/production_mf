// Комната «Каландрирование» (prokatka). Полностью офлайн.
// Вкладки: 📥 Рулоны с намазки · ⚙️ Параметры прокатки (технолог/master) · 📒 Журнал прокатки · 💬 Комментарии
// Цепочка данных: намазка → (roll-spec) технологу (master) → оператор каландра фиксирует
// зазоры/длину/дефекты → (calender-result) результат доступен для нарезки.

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  CalenderParams, CalenderRun, RollSpec, RollToTechPacket, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';

// Параметры прокатки по рулону хранятся локально (мастер назначает их сам; на slave
// они приходят пакетом roll-spec и пишутся apply.ts прямо в calenderRuns).
const CAL_PARAMS_KEY = 'lip_calender_params_v1';

function loadLocalCalParams(): Record<string, CalenderParams> {
  try {
    return JSON.parse(localStorage.getItem(CAL_PARAMS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveLocalCalParam(rollId: string, p: CalenderParams) {
  const all = loadLocalCalParams();
  all[rollId] = p;
  localStorage.setItem(CAL_PARAMS_KEY, JSON.stringify(all));
}

type Tab = 'rolls' | 'params' | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export function CalendaringModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isTechManager = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('rolls');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [selectedRollId, setSelectedRollId] = useState<string | null>(null);

  const rolls = useLiveQuery(async () => {
    const all = await db.rollSpecs.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const runs = useLiveQuery(async () => {
    const all = await db.calenderRuns.toArray();
    // подставляем параметры: из записи прокатки, иначе локальное назначение мастера
    const localParams = loadLocalCalParams();
    return all
      .map((r) => ({
        ...r,
        gapsMm: Array.isArray(r.gapsMm) ? r.gapsMm : [],
        params: r.params ?? localParams[r.rollId],
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const tasks = useLiveQuery(() => db.tasks.where('stage').equals(StageId.CALENDARING).toArray(), []);

  const users = useLiveQuery(() => db.users.toArray(), []);
  const userName = (id?: string) => users?.find((u) => u.id === id)?.fullName ?? 'неизвестен';

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.CALENDARING, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'rolls', label: `📥 Рулоны (${rolls?.length ?? 0})` },
    { id: 'params', label: '⚙️ Параметры прокатки' },
    { id: 'journal', label: `📒 Журнал прокатки (${runs?.length ?? 0})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm ${tab === t.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rolls' && (
        <RollsTab rolls={rolls ?? []} onSelect={(id) => { setSelectedRollId(id); setTab('params'); }} canSendToCutting={isTechManager}
          onSendResult={(run, forced) => {
            const fresh = { ...run, updatedAt: Date.now() };
            db.calenderRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'calender-result', stage: StageId.CALENDARING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
          runs={runs ?? []} userName={userName}
        />
      )}

      {tab === 'params' && (
        <ParamsTab
          rolls={rolls ?? []}
          selectedRollId={selectedRollId}
          canEdit={isTechManager}
          onSaved={(roll, p) => {
            // технолог (master) уточнил параметры → сохраняем локально и формируем пакет
            // roll-spec с параметрами: slave применит их безусловно (forced от master'а)
            saveLocalCalParam(roll.id, p);
            const rp: RollToTechPacket = { roll, calenderParams: p };
            setOutPacket({
              v: 1, type: 'roll-spec', stage: StageId.CALENDARING,
              payload: rp, from: currentUser!.id, ts: Date.now(), forced: true,
            });
          }}
        />
      )}

      {tab === 'journal' && (
        <JournalTab
          rolls={rolls ?? []}
          runs={runs ?? []}
          userName={userName}
          canForce={isTechManager}
          onNew={() => setTab('params')}
          onSend={(r, forced) => {
            const fresh = { ...r, updatedAt: Date.now() };
            db.calenderRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'calender-result', stage: StageId.CALENDARING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
        />
      )}

      {tab === 'comments' && <CommentsSection stage={StageId.CALENDARING} onAdd={addComment} />}

      <details className="bg-slate-800/60 border border-slate-700 rounded-lg p-3">
        <summary className="text-white text-sm font-medium cursor-pointer">📋 Задания этапа ({(tasks ?? []).length})</summary>
        <div className="mt-2 space-y-2">
          {(tasks ?? []).map((t) => (
            <div key={t.id} className="text-xs text-slate-300 border-b border-slate-700/50 pb-1">
              <span className="font-medium text-white">{t.title}</span> · статус: {t.status} · исполнитель: {userName(t.assignedTo)}
            </div>
          ))}
          {(tasks ?? []).length === 0 && <p className="text-xs text-slate-500">Заданий по этапу пока нет.</p>}
        </div>
      </details>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

// ── Вкладка: входящие рулоны с намазки ──────────────────────────────
function RollsTab({
  rolls, onSelect, runs, userName, canSendToCutting, onSendResult,
}: {
  rolls: RollSpec[];
  onSelect: (id: string) => void;
  runs: CalenderRun[];
  userName: (id?: string) => string;
  canSendToCutting: boolean;
  onSendResult: (r: CalenderRun, forced: boolean) => void;
}) {
  const runByRoll = new Map(runs.map((r) => [r.rollId, r]));
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Рулоны приходят пакетами «roll-spec» с участка нанесения (QR/текст/Bluetooth). Сначала технологу (master)
        — для уточнения параметров прокатки, затем оператор выполняет прокатку. Готовые результаты без дефектов
        отправляются дальше — на нарезку электродов.
      </p>
      {rolls.length === 0 && (
        <div className="bg-slate-800 border border-dashed border-slate-600 rounded-lg p-6 text-center text-sm text-slate-400">
          Пока нет рулонов с намазки. Примите пакет «roll-spec» на вкладке «Синхронизация».
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        {rolls.map((r) => {
          const run = runByRoll.get(r.id);
          const totalA = (r.segLengthsM ?? []).reduce((s, x) => s + (Number(x) || 0), 0);
          return (
            <div key={r.id} className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2">
              <div className="flex justify-between items-start">
                <p className="text-white text-sm font-semibold">🔄 {r.mixName}</p>
                <span className="text-[10px] text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-xs text-slate-300">
                <span>До прокатки: <b className="text-white">{r.thicknessBeforeUm ?? '—'} мкм</b></span>
                <span>Фольга: <b className="text-white">{r.foilType ?? '—'}</b></span>
                <span>Участки A: <b className="text-white">{totalA} м</b></span>
                <span>Сторона B: <b className="text-white">{r.sideBLengthM ?? '—'} м</b></span>
              </div>
              <div className="flex items-center justify-between pt-1">
                {run ? (
                  <span className={`text-[11px] ${run.hasDefects ? 'text-red-400' : 'text-emerald-400'}`}>
                    {run.hasDefects ? '⚠ прокатано с дефектами' : `✔ прокатано: ${run.thicknessAfterUm ?? '—'} мкм, ${run.totalLengthM ?? '—'} м`}
                  </span>
                ) : (
                  <span className="text-[11px] text-amber-400">ждёт параметров / прокатки</span>
                )}
                <div className="flex gap-2">
                  {!run && (
                    <button onClick={() => onSelect(r.id)} className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">
                      К параметрам →
                    </button>
                  )}
                  {run && canSendToCutting && !run.hasDefects && (
                    <button onClick={() => onSendResult(run, false)} className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white" title="Результат прокатки → нарезка (QR/текст/Bluetooth)">
                      ✂️ На нарезку
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Вкладка: параметры прокатки (технолог/master назначает) ─────────
function ParamsTab({
  rolls, selectedRollId, canEdit, onSaved,
}: {
  rolls: RollSpec[];
  selectedRollId: string | null;
  canEdit: boolean;
  onSaved: (roll: RollSpec, p: CalenderParams) => void;
}) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [rollId, setRollId] = useState<string>(selectedRollId ?? rolls[0]?.id ?? '');
  const roll = rolls.find((r) => r.id === rollId);

  const [targetThickness, setTargetThickness] = useState<number | ''>(18);
  const [heating, setHeating] = useState(true);
  const [heatTemp, setHeatTemp] = useState<number | ''>(80);
  const [pressure, setPressure] = useState<number | ''>(60);
  const [edgeTrim, setEdgeTrim] = useState(false);
  const [notes, setNotes] = useState('');

  // Расчётная подсказка: обжатие
  const reduction = useMemo(() => {
    if (!roll?.thicknessBeforeUm || !targetThickness) return null;
    const before = Number(roll.thicknessBeforeUm);
    const after = Number(targetThickness);
    if (before <= 0 || after <= 0 || after >= before) return null;
    return Math.round(((before - after) / before) * 1000) / 10; // %
  }, [roll, targetThickness]);

  const saveAndPush = async () => {
    if (!roll || !currentUser) return;
    const p: CalenderParams = {
      targetThicknessUm: numOrUndef(targetThickness),
      heating,
      heatTempC: heating ? numOrUndef(heatTemp) : undefined,
      pressureTons: numOrUndef(pressure),
      edgeTrim,
      notes: notes.trim() || undefined,
    };
    // Сохраняем параметры у себя (master): локально + заводим запись прокатки «в работе»,
    // чтобы оператор видел назначение
    saveLocalCalParam(roll.id, p);
    const existing = await db.calenderRuns.get(roll.id);
    if (!existing) {
      const run: CalenderRun = {
        id: roll.id, rollId: roll.id, params: p, gapsMm: [], hasDefects: false,
        workerId: currentUser.id, createdAt: Date.now(), updatedAt: Date.now(),
      };
      await db.calenderRuns.put(run);
    } else {
      await db.calenderRuns.put({ ...existing, params: p, updatedAt: Date.now() });
    }
    onSaved(roll, p);
  };

  if (rolls.length === 0) {
    return <p className="text-sm text-slate-400">Нет рулонов — дождитесь пакета «roll-spec» с участка нанесения.</p>;
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        <h3 className="text-white font-semibold text-sm">Назначение параметров прокатки (технолог / master)</h3>
        <div>
          <label className={labelCls}>Рулон с намазки</label>
          <select className={inputCls} value={rollId} onChange={(e) => setRollId(e.target.value)}>
            {rolls.map((r) => (
              <option key={r.id} value={r.id}>{r.mixName} · {new Date(r.createdAt).toLocaleDateString('ru-RU')}</option>
            ))}
          </select>
        </div>
        {roll && (
          <div className="text-xs text-slate-400 bg-slate-900/60 rounded p-2">
            До прокатки: <b className="text-white">{roll.thicknessBeforeUm ?? '—'} мкм</b> · участков A: {(roll.segLengthsM ?? []).join(' + ')} м · B: {roll.sideBLengthM ?? '—'} м
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Толщина после прокатки, мкм</label>
            <input type="number" step="0.5" className={inputCls} value={targetThickness} onChange={(e) => setTargetThickness(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Давление, тс</label>
            <input type="number" step="1" className={inputCls} value={pressure} onChange={(e) => setPressure(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Нагрев валков</label>
            <button onClick={() => setHeating(!heating)} className={`w-full px-2 py-1.5 rounded text-sm ${heating ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
              {heating ? '🔥 Нагрев: да' : 'Нагрев: нет'}
            </button>
          </div>
          <div>
            <label className={labelCls}>Температура нагрева, °C</label>
            <input type="number" className={inputCls} disabled={!heating} value={heatTemp} onChange={(e) => setHeatTemp(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={edgeTrim} onChange={(e) => setEdgeTrim(e.target.checked)} className="accent-blue-500" />
          Обрезка кромок электродов (облегчает прокатку)
        </label>
        <div>
          <label className={labelCls}>Примечание технолога</label>
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="напр.: 2 прохода, контроль толщины каждые 50 м" />
        </div>
        {reduction !== null && (
          <p className="text-xs text-blue-300">Обжатие: ~{reduction}% ({roll?.thicknessBeforeUm} → {targetThickness} мкм)</p>
        )}
        <button
          onClick={saveAndPush}
          disabled={!canEdit || !roll}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-sm text-white"
        >
          {canEdit ? '💾 Назначить и отправить на устройство каландра (QR/текст/BT)' : 'Только технолог/мастер/начальник может назначать параметры'}
        </button>
      </div>

      {/* Справка по цепочке */}
      <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 text-xs text-slate-400 space-y-2">
        <h4 className="text-white text-sm font-semibold">Как идёт поток данных</h4>
        <p>1️⃣ Участок нанесения формирует пакет «рулон технологу»: название замеса, толщина до прокатки, длины участков (стороны A/B).</p>
        <p>2️⃣ Технолог (master) принимает его офлайн (QR/текст/Bluetooth) и назначает здесь: толщина после прокатки, нагрев и температура, давление (тс), обрезка кромки.</p>
        <p>3️⃣ Пакет возвращается на устройство каландра (slave) — задание с параметрами появляется у оператора.</p>
        <p>4️⃣ Оператор прокатывает и вносит в журнал фактические зазоры валков, общую длину, толщину после прокатки, дефекты.</p>
        <p>5️⃣ Результат («calender-result») передаётся на участок нарезки электродов.</p>
      </div>
    </div>
  );
}

// ── Вкладка: журнал прокатки (оператор каландра) ────────────────────
function JournalTab({
  rolls, runs, userName, canForce, onSend, onNew,
}: {
  rolls: RollSpec[];
  runs: CalenderRun[];
  userName: (id?: string) => string;
  canForce: boolean;
  onSend: (r: CalenderRun, forced: boolean) => void;
  onNew: () => void;
}) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { gaps: string; totalLen: string; thickAfter: string; defects: string; hasDef: boolean; notes: string }>>({});

  const draftFor = (r: CalenderRun) =>
    drafts[r.id] ?? {
      gaps: (r.gapsMm ?? []).join(', '),
      totalLen: r.totalLengthM != null ? String(r.totalLengthM) : '',
      thickAfter: r.thicknessAfterUm != null ? String(r.thicknessAfterUm) : '',
      defects: r.defects ?? '',
      hasDef: !!r.hasDefects,
      notes: r.notes ?? '',
    };

  const setDraft = (id: string, patch: Partial<ReturnType<typeof draftFor>>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {} as any), ...patch } }));

  const save = async (r: CalenderRun) => {
    const d = draftFor(r);
    const gaps = d.gaps.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
    const updated: CalenderRun = {
      ...r,
      gapsMm: gaps,
      totalLengthM: d.totalLen === '' ? undefined : Number(d.totalLen),
      thicknessAfterUm: d.thickAfter === '' ? undefined : Number(d.thickAfter),
      hasDefects: d.hasDef || !!d.defects.trim(),
      defects: d.defects.trim() || undefined,
      notes: d.notes.trim() || undefined,
      workerId: currentUser?.id ?? r.workerId,
      updatedAt: Date.now(),
    };
    await db.calenderRuns.put(updated);
    // дубль в общий журнал работ комнаты (для KPI)
    const roll = rolls.find((x) => x.id === r.rollId);
    await db.journal.add({
      id: uuidv4(), stage: StageId.CALENDARING, workerId: currentUser?.id ?? 'unknown',
      summary: `Прокатка: ${roll?.mixName ?? r.rollId}${updated.hasDefects ? ' ⚠ дефекты' : ''}`,
      params: {
        'Зазоры, мм': updated.gapsMm.join('/'),
        'Длина, м': updated.totalLengthM ?? '',
        'Толщина после, мкм': updated.thicknessAfterUm ?? '',
        'Давление, тс': r.params?.pressureTons ?? '',
        'Нагрев, °C': r.params?.heatTempC ?? '',
      },
      defects: updated.defects ?? '', createdAt: new Date(),
    });
    setDrafts((d) => { const c = { ...d }; delete c[r.id]; return c; });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Журнал прокатки: фактические зазоры валков, общая длина, толщина после прокатки, дефекты. Отправка результата
        на нарезку — офлайн (QR/текст/Bluetooth). Если параметров ещё нет — назначьте их на вкладке «Параметры прокатки».
      </p>
      {runs.length === 0 && (
        <div className="text-sm text-slate-400">
          Записей пока нет. Дождитесь рулон →{' '}
          <button onClick={onNew} className="text-blue-400 underline">назначить параметры прокатки</button>.
        </div>
      )}
      {runs.map((r) => {
        const open = openId === r.id;
        const roll = rolls.find((x) => x.id === r.rollId);
        const d = draftFor(r);
        return (
          <div key={r.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <button onClick={() => setOpenId(open ? null : r.id)} className="w-full px-3 py-2 flex items-center justify-between text-left">
              <div>
                <p className="text-sm text-white font-medium">🔄 {roll?.mixName ?? r.rollId}</p>
                <p className="text-[11px] text-slate-400">
                  {new Date(r.createdAt).toLocaleString('ru-RU')} · {userName(r.workerId)} ·{' '}
                  цель {r.params?.targetThicknessUm ?? '—'} мкм{r.params?.heating ? ` · 🔥 ${r.params.heatTempC ?? '—'}°C` : ''}
                  {r.params?.pressureTons ? ` · ${r.params.pressureTons} тс` : ''}{r.params?.edgeTrim ? ' · обрезка кромки' : ''}
                </p>
              </div>
              <span className="text-slate-400 text-xs">{r.hasDefects ? '⚠ ' : ''}{open ? '▲' : '▼'}</span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-2 border-t border-slate-700/60 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Зазоры валков по проходам, мм (через запятую)</label>
                    <input className={inputCls} value={d.gaps} onChange={(e) => setDraft(r.id, { gaps: e.target.value })} placeholder="0,35, 0,28, 0,25" />
                  </div>
                  <div>
                    <label className={labelCls}>Общая длина прокатанного полотна, м</label>
                    <input type="number" className={inputCls} value={d.totalLen} onChange={(e) => setDraft(r.id, { totalLen: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Фактическая толщина после прокатки, мкм</label>
                    <input type="number" step="0.5" className={inputCls} value={d.thickAfter} onChange={(e) => setDraft(r.id, { thickAfter: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Дефекты прокатки</label>
                    <input className={inputCls} value={d.defects} onChange={(e) => setDraft(r.id, { defects: e.target.value })} placeholder="разрыв, полосность, налип…" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={d.hasDef} onChange={(e) => setDraft(r.id, { hasDef: e.target.checked })} className="accent-red-500" />
                  Наличие дефектов в ходе прокатки
                </label>
                <div>
                  <label className={labelCls}>Примечание оператора</label>
                  <input className={inputCls} value={d.notes} onChange={(e) => setDraft(r.id, { notes: e.target.value })} />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => save(r)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">💾 Сохранить результат</button>
                  <button onClick={() => { save(r); setTimeout(() => onSend({ ...r, updatedAt: Date.now() }, false), 50); }} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">
                    ✂️ Результат на нарезку (QR/текст/BT)
                  </button>
                  {canForce && (
                    <button onClick={() => onSend(r, true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-xs text-white">⚡ Принудительно (forced)</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function numOrUndef(v: number | ''): number | undefined {
  return v === '' ? undefined : Number(v);
}
