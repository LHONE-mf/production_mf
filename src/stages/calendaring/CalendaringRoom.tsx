// Комната «Каландрирование» (prokatka). Полностью офлайн.
// Вкладки: 📥 Рулоны с намазки · ⚙️ Параметры прокатки (технолог/master) · 📒 Журнал прокатки · 💬 Комментарии
// Цепочка данных: намазка → (roll-spec) технологу (master) → оператор каландра фиксирует
// зазоры/длину/дефекты → (calender-result) результат доступен для нарезки.

import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import {
  CalenderParams, CalenderRun, CuttingIncoming, RollSpec, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { CuttingInstructionPanel } from './CuttingInstructionPanel';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { saveCalenderAssignment, saveCalenderResult, validateCalenderResult, hasCalenderResult } from './calenderJournal';
import { measuredDryThicknessUm, plannedThicknessReductionPct } from '../_common/rollThickness';
import { RoomWorkspaceHeader } from '../_common/RoomWorkspaceHeader';

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


type Tab = 'rolls' | 'params' | 'journal' | 'comments' | 'cutting';

const inputCls =
  'w-full min-h-11 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
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

  const tasks = useLiveQuery(async () => (await listVisibleTasks()).filter(task => task.stage === StageId.CALENDARING), []);

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
    ...(isTechManager?[{id:'cutting' as const,label:'✂️ Задание на нарезку'}]:[]),
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-4">
      <RoomWorkspaceHeader icon="🔄" title="Каландрирование"
        description="Выберите рулон с нанесения, сохраните назначение параметров отдельно от фактических измерений прокатки и передайте только записанный результат."/>
      <nav aria-label="Разделы каландрирования" className="flex flex-wrap min-w-0 gap-2 rounded-lg bg-slate-800 p-2">
        {tabs.map(t => (
          <button key={t.id} type="button" aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`min-h-11 rounded-md px-3 py-2 text-sm font-medium ${tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'rolls' && (
        <RollsTab rolls={rolls ?? []} onSelect={(id) => { setSelectedRollId(id); setTab('params'); }} canSendToCutting={isTechManager}
          onSendResult={(run) => {
            try{validateCalenderResult(run);}catch{return;}
            const fresh = run;
            setOutPacket({
              v: 1, type: 'calender-result', stage: StageId.CALENDARING,
              payload: fresh, from: currentUser!.id, ts: Date.now(),
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
        />
      )}

      {tab === 'journal' && (
        <JournalTab
          rolls={rolls ?? []}
          runs={runs ?? []}
          userName={userName}
          onNew={() => setTab('params')}
          onSend={(run) => {
            setOutPacket({
              v: 1, type: 'calender-result', stage: StageId.CALENDARING,
              payload: run, from: currentUser!.id, ts: Date.now(),
            });
          }}
        />
      )}

      {tab==='cutting'&&isTechManager&&<CuttingInstructionPanel runs={runs??[]} onPrepared={payload=>setOutPacket({v:1,type:'cutting-roll',stage:StageId.CUTTING,payload,from:currentUser!.id,ts:Date.now()})}/>}
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
  onSendResult: (r: CalenderRun) => void;
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
                <span>Полная сухая толщина с фольгой до прокатки (замер): <b className="text-white">{measuredDryThicknessUm(r) ?? '—'} мкм</b></span>
                {measuredDryThicknessUm(r)!==null && <span>Замер записал: {userName(r.thicknessBeforeMeasurement!.recordedBy)} · {new Date(r.thicknessBeforeMeasurement!.recordedAt).toLocaleString('ru-RU')}</span>}
                {measuredDryThicknessUm(r)===null && typeof r.thicknessBeforeUm==='number' && Number.isFinite(r.thicknessBeforeUm) && <span>Ранее указано {r.thicknessBeforeUm} мкм; источник не подтверждён.</span>}
                <span>Фольга: <b className="text-white">{r.foilType ?? '—'}</b></span>
                <span>Участки A: <b className="text-white">{totalA} м</b></span>
                <span>Сторона B: <b className="text-white">{r.sideBLengthM ?? '—'} м</b></span>
              </div>
              <div className="flex items-center justify-between pt-1">
                {run ? (
                  <span className={`text-[11px] ${run.hasDefects ? 'text-red-400' : 'text-emerald-400'}`}>
                    {!hasCalenderResult(run) ? 'Назначение сохранено; результат не записан' : run.hasDefects ? '⚠ прокатано с дефектами' : `✔ прокатано: ${run.thicknessAfterUm ?? '—'} мкм, ${run.totalLengthM ?? '—'} м`}
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
                  {run && hasCalenderResult(run) && canSendToCutting && !run.hasDefects && (
                    <button onClick={() => onSendResult(run)} className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white" title="Результат прокатки → нарезка (QR/текст/Bluetooth)">
                      Передать результат (без задания)
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
  rolls, selectedRollId, canEdit,
}: {
  rolls: RollSpec[];
  selectedRollId: string | null;
  canEdit: boolean;

}) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [rollId, setRollId] = useState<string>(selectedRollId ?? rolls[0]?.id ?? '');
  const roll = rolls.find((r) => r.id === rollId);

  const [saveError,setSaveError]=useState('');
  const [savedNote,setSavedNote]=useState('');
  const [saving,setSaving]=useState(false);
  const assignmentRef=useRef(false);
  const [targetThickness, setTargetThickness] = useState<number | ''>('');
  const [heating, setHeating] = useState<boolean|null>(null);
  const [heatTemp, setHeatTemp] = useState<number | ''>('');
  const [pressure, setPressure] = useState<number | ''>('');
  const [edgeTrim, setEdgeTrim] = useState(false);
  const [notes, setNotes] = useState('');

  // Расчётная подсказка: обжатие
  const reduction=roll?plannedThicknessReductionPct(roll,Number(targetThickness)):null;
  const validTarget=targetThickness!==''&&Number.isFinite(targetThickness)&&targetThickness>0;
  const validParams=validTarget&&heating!==null&&(pressure===''||Number.isFinite(pressure)&&pressure>0)&&
    (!heating||heatTemp!==''&&Number.isFinite(heatTemp)&&heatTemp>=0);

  const saveAssignment = async () => {
    if (!roll || !currentUser || !validParams || heating===null || !canEdit || assignmentRef.current) return;
    assignmentRef.current=true;setSaving(true);setSaveError('');setSavedNote('');
    try{
    const p: CalenderParams = {
      targetThicknessBasis:'dry-electrode-including-foil',
      targetThicknessUm: numOrUndef(targetThickness),
      heating,
      heatTempC: heating ? numOrUndef(heatTemp) : undefined,
      pressureTons: numOrUndef(pressure),
      edgeTrim,
      notes: notes.trim() || undefined,
    };
    await saveCalenderAssignment(roll,p,currentUser.id);
    setSavedNote('Параметры сохранены локально. Отправка назначений по общему QR/Bluetooth ключу заблокирована: он не подтверждает права технолога.');
    }catch(cause){setSaveError(cause instanceof Error?cause.message:'Назначение не сохранено');}
    finally{assignmentRef.current=false;setSaving(false);}

  };

  if (rolls.length === 0) {
    return <p className="text-sm text-slate-400">Нет рулонов — дождитесь пакета «roll-spec» с участка нанесения.</p>;
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        <h3 className="text-white font-semibold">Назначение параметров прокатки</h3>
        <p className="text-xs text-slate-300">Целевые параметры здесь не являются фактическими показаниями оборудования. Результат прокатки оператор записывает отдельно.</p>
        <section aria-label="Источник и замер до прокатки" className="space-y-2 rounded border border-slate-600 p-3">
          <h4 className="text-sm font-semibold text-white">1. Источник и замер до прокатки</h4>
        <div>
          <label className={labelCls}>Рулон с намазки</label>
          <select aria-label="Рулон для каландрирования" className={inputCls} value={rollId} onChange={(e) => {
            setRollId(e.target.value);setTargetThickness('');setPressure('');setHeatTemp('');setHeating(null);setEdgeTrim(false);setNotes('');
          }}>
            {rolls.map((r) => (
              <option key={r.id} value={r.id}>{r.mixName} · {new Date(r.createdAt).toLocaleDateString('ru-RU')}</option>
            ))}
          </select>
        </div>
        {roll && (
          <div className="text-xs text-slate-400 bg-slate-900/60 rounded p-2">
            Полная сухая толщина с фольгой до прокатки (замер): <b className="text-white">{measuredDryThicknessUm(roll) ?? '—'} мкм</b> · участков A: {(roll.segLengthsM ?? []).join(' + ')} м · B: {roll.sideBLengthM ?? '—'} м
          </div>
        )}
        {roll && measuredDryThicknessUm(roll)===null && <p className="text-xs text-amber-200">Атрибутированный замер сухого электрода не указан. Ранее записанные значения сохранены, но источник не подтверждён; оценка обжатия недоступна.</p>}
        </section>
        <section aria-label="Назначенные параметры прокатки" className="space-y-3 rounded border border-slate-600 p-3">
          <h4 className="text-sm font-semibold text-white">2. Назначенные параметры (план)</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Целевая полная толщина сухого электрода с фольгой, мкм *</label>
            <input aria-label="Целевая полная толщина, мкм" type="number" min="0" step="any" className={inputCls} value={targetThickness} onChange={(e) => setTargetThickness(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Усилие прокатки, тс</label>
            <input type="number" step="1" className={inputCls} value={pressure} onChange={(e) => setPressure(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Нагрев валков</label>
            <select aria-label="Назначение нагрева валков" className={inputCls} value={heating===null?'':heating?'yes':'no'}
              onChange={event=>setHeating(event.target.value===''?null:event.target.value==='yes')}>
              <option value="">Выберите режим</option><option value="no">Без нагрева</option><option value="yes">С нагревом</option>
            </select>
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
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Основание назначения, без предполагаемых измерений" />
        </div>
        </section>
        {saveError && <p role="alert" className="text-red-200 text-sm">{saveError}</p>}
         {savedNote && <p role="status" className="text-emerald-200 text-sm">{savedNote}</p>}
        {!validParams && <p className="text-xs text-amber-200">Для назначения укажите положительную цель и явно выберите нагрев. При нагреве нужна температура; указанное усилие должно быть больше нуля. Это назначение параметров, не показания оборудования.</p>}
        <h4 className="text-sm font-semibold text-white">3. Плановое сравнение и сохранение</h4>
        {reduction !== null && (
          <p className="text-xs text-blue-300">Плановое уменьшение полной толщины: ~{reduction}% ({roll && measuredDryThicknessUm(roll)} → {targetThickness} мкм). Это сравнение с целью, не фактическое обжатие, пористость или настройка зазора.</p>
        )}
        <button
          onClick={saveAssignment}
          disabled={!canEdit || !roll || !validParams || saving}
          className="w-full min-h-11 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-sm text-white"
        >
          {canEdit ? '💾 Сохранить параметры локально' : 'Только технолог/мастер/начальник может назначать параметры'}
        </button>
      </div>

      {/* Справка по цепочке */}
      <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 text-xs text-slate-400 space-y-2">
        <h4 className="text-white text-sm font-semibold">Как идёт поток данных</h4>
        <p>1️⃣ Участок нанесения формирует пакет «рулон технологу»: название замеса, толщина до прокатки, длины участков (стороны A/B).</p>
        <p>2️⃣ Технолог (master) принимает его офлайн (QR/текст/Bluetooth) и назначает здесь: толщина после прокатки, нагрев и температура, давление (тс), обрезка кромки.</p>
        <p>3️⃣ Назначение доступно на этом устройстве после сохранения; передача этих параметров через общий QR/Bluetooth ключ заблокирована. Для другого устройства нужен авторизованный канал.</p>
        <p>4️⃣ Оператор прокатывает и вносит в журнал фактические зазоры валков, общую длину, толщину после прокатки, дефекты.</p>
        <p>5️⃣ Результат («calender-result») передаётся на участок нарезки электродов.</p>
      </div>
    </div>
  );
}

// ── Вкладка: журнал прокатки (оператор каландра) ────────────────────
function JournalTab({
  rolls, runs, userName, onSend, onNew,
}: {
  rolls: RollSpec[];
  runs: CalenderRun[];
  userName: (id?: string) => string;
  onSend: (r: CalenderRun) => void;
  onNew: () => void;
}) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [openId, setOpenId] = useState<string | null>(null);
  const [resultError,setResultError]=useState('');
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const revisions=useRef<Record<string,number>>({});
  const journalIds=useRef<Record<string,string>>({});
  const [drafts, setDrafts] = useState<Record<string, { gaps: string; totalLen: string; thickAfter: string; defects: string; hasDef: boolean; notes: string }>>({});

  const draftFor = (r: CalenderRun) =>
    drafts[r.id] ?? {
      gaps: (r.gapsMm ?? []).join(' '),
      totalLen: r.totalLengthM != null ? String(r.totalLengthM) : '',
      thickAfter: r.thicknessAfterUm != null ? String(r.thicknessAfterUm) : '',
      defects: r.defects ?? '',
      hasDef: !!r.hasDefects,
      notes: r.notes ?? '',
    };

  const setDraft = (id: string, patch: Partial<ReturnType<typeof draftFor>>) => {
    const run=runs.find(row=>row.id===id)!;
    revisions.current[id]??=run.updatedAt;
    setDrafts(d=>({...d,[id]:{...draftFor(run),...d[id],...patch}}));
  };
  const resetDraft=(id:string)=>{
    delete revisions.current[id];delete journalIds.current[id];
    setDrafts(d=>{const copy={...d};delete copy[id];return copy;});setResultError('');
  };
  const save = async (r: CalenderRun,send=false) => {
    if(!currentUser||busyRef.current)return;
    busyRef.current=true;setBusy(true);setResultError('');
    try{
      journalIds.current[r.id]??=uuidv4();
      const updated=await saveCalenderResult({...r,updatedAt:revisions.current[r.id]??r.updatedAt},
        draftFor(r),currentUser.id,journalIds.current[r.id]);
      resetDraft(r.id);
      if(send)onSend(updated);
    }catch(cause){setResultError(cause instanceof Error?cause.message:'Результат не сохранён');}
    finally{busyRef.current=false;setBusy(false);}
  };

  return (
    <div className="space-y-3">
      {resultError && <p role="alert" className="text-red-200 text-sm">{resultError}</p>}
      <p className="text-sm text-slate-300">
        Записывайте фактически измеренные зазоры, длину полотна и толщину после прокатки. Назначенные параметры и наблюдения не взаимозаменяемы. Передача результатов доступна отдельно; это не QA-допуск.
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
                  цель {r.params?.targetThicknessUm ?? '—'} мкм ({r.params?.targetThicknessBasis==='dry-electrode-including-foil'?'сухой электрод с фольгой':'основа не указана'}){r.params?.heating ? ` · 🔥 ${r.params.heatTempC ?? '—'}°C` : ''}
                  {r.params?.pressureTons ? ` · ${r.params.pressureTons} тс` : ''}{r.params?.edgeTrim ? ' · обрезка кромки' : ''}
                </p>
                <p className={`mt-1 text-xs ${hasCalenderResult(r) ? 'text-emerald-300' : 'text-amber-200'}`}>
                  {hasCalenderResult(r) ? 'Фактический результат записан (без QA-допуска)' : 'Есть назначение; измеренный результат ещё не записан'}
                </p>
              </div>
              <span className="text-slate-400 text-xs">{r.hasDefects ? '⚠ ' : ''}{open ? '▲' : '▼'}</span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-2 border-t border-slate-700/60 space-y-3">
                <section aria-label="Фактические измерения прокатки" className="space-y-3 rounded border border-slate-600 p-3">
                  <h4 className="text-sm font-semibold text-white">1. Фактические измерения прокатки</h4>
                  <p className="text-xs text-slate-300">Пустые значения неизвестны, а не равны нулю. Для сохранения нужны положительные фактические зазоры, длина и толщина.</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Зазоры валков, мм (проходы через пробел или ;) (через запятую)</label>
                    <input disabled={busy} className={inputCls} aria-label="Зазоры по проходам, мм" value={d.gaps} onChange={(e) => setDraft(r.id, { gaps: e.target.value })} placeholder="0.35 0.28 0.25" />
                  </div>
                  <div>
                    <label className={labelCls}>Общая длина прокатанного полотна, м</label>
                    <input type="number" className={inputCls} aria-label="Измеренная длина, м" value={d.totalLen} onChange={(e) => setDraft(r.id, { totalLen: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Фактическая толщина после прокатки, мкм</label>
                    <input type="number" step="0.5" className={inputCls} aria-label="Измеренная толщина после, мкм" value={d.thickAfter} onChange={(e) => setDraft(r.id, { thickAfter: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Дефекты прокатки</label>
                    <input disabled={busy} className={inputCls} value={d.defects} onChange={(e) => setDraft(r.id, { defects: e.target.value })} placeholder="разрыв, полосность, налип…" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input disabled={busy} type="checkbox" checked={d.hasDef} onChange={(e) => setDraft(r.id, { hasDef: e.target.checked })} className="accent-red-500" />
                  Наличие дефектов в ходе прокатки
                </label>
                </section>
                <div>
                  <label className={labelCls}>Примечание оператора</label>
                  <input disabled={busy} className={inputCls} value={d.notes} onChange={(e) => setDraft(r.id, { notes: e.target.value })} />
                </div>
                <p className="text-xs text-slate-300">2. Проверьте записываемые наблюдения. Не является подтверждением QA или физической приёмки следующим участком.</p>
                <div className="flex gap-2 flex-wrap">
                  <button disabled={busy} onClick={() => void save(r)} className="min-h-11 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">💾 Сохранить результат</button>
                  <button disabled={busy} onClick={() => void save(r,true)} className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white">
                    Сохранить и передать результат (без задания)
                  </button>
                  <button disabled={busy} onClick={()=>resetDraft(r.id)} className="min-h-11 px-3 text-sm text-slate-300">Сбросить черновик</button>

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
