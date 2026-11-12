import {hasMeasuredSlurryBatch,hasSlurryHandover} from '../../core/manufacturing/slurryBatch';
// Комната «Нанесение покрытия» (coating). Полностью офлайн.
// Вкладки: 📥 Данные замесов · ⚙️ Намазка (расчёты) · 📒 Журнал нанесения · 💬 Комментарии
// Данные замесов приходят пакетами LIP: (QR/текст, позже Bluetooth) — type 'coating-mix'.

import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { CoatingMixSnapshot, CoatRun, RollToTechPacket, StageId, SyncPacket, UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { saveCoatingRun, saveCoatingRollHandover } from './coatingJournal';
import { requiredScrewFlowLpm, screwRpmFromFlow, wetThicknessUm, intermittentCoverage } from './coatMath';

type Tab = 'mixes' | 'setup' | 'journal' | 'comments';

const inputCls =
  'w-full min-h-11 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export function CoatingModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isManager = !!currentUser && [UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('mixes');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [handoverBusy,setHandoverBusy]=useState(false);
  const handoverRef=useRef(false);
  const [handoverError,setHandoverError]=useState('');

  // ── Данные для вкладок ────────────────────────────────────────────
  const incomingMixes = useLiveQuery(async () => {
    const all = await db.coatIncomingMixes.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const localBatches = useLiveQuery(() => db.mixBatches.toArray(), []);

  const runs = useLiveQuery(async () => {
    const all = await db.coatRuns.toArray();
    return all
      .map((r) => ({ ...r, segLengthsM: Array.isArray(r.segLengthsM) ? r.segLengthsM : [], ovenTempsC: Array.isArray(r.ovenTempsC) ? r.ovenTempsC : [] }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const users = useLiveQuery(() => db.users.toArray(), []);
  const tasks = useLiveQuery(
    async () => (await listVisibleTasks()).filter(task => task.stage === StageId.COATING)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [],
  );

  // Все доступные замесы: принятые пакетом + локальные из журнала замесов (одна комната цеха)
  const availableMixes: CoatingMixSnapshot[] = useMemo(() => {
    const fromPackets = incomingMixes ?? [];
    const fromLocal = (localBatches ?? []).filter(batch=>!hasMeasuredSlurryBatch(batch)).map((b) => ({
      mixBatchId: b.id,
      recipeName: b.recipeName,
      viscosity: b.viscosity,
      fineness: b.fineness,
      solidsPctMass: b.pasteCalc?.solidsPctMass,
      solidsPctVol: b.pasteCalc?.solidsPctVol,
      pasteDensity: b.pasteCalc?.pasteDensity,
      batchKg: b.batchKg,
      createdAt: b.createdAt,
    }));
    const map = new Map<string, CoatingMixSnapshot>();
    for (const m of [...fromLocal, ...fromPackets]) map.set(m.mixBatchId, m);
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [incomingMixes, localBatches]);

  const userName = (id: string) => users?.find((u) => u.id === id)?.fullName ?? id;

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.COATING, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'mixes', label: `📥 Данные замесов${availableMixes.length ? ` (${availableMixes.length})` : ''}` },
    { id: 'setup', label: '⚙️ Подстройка линии' },
    { id: 'journal', label: `📒 Журнал нанесения${runs?.length ? ` (${runs.length})` : ''}` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">🖌️ Нанесение покрытия</h2>
        <span className="text-xs text-slate-400">Офлайн · данные замесов по QR/тексту (позже Bluetooth)</span>
      </div>

      <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-sm transition ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {handoverError && <p role="alert" className="text-sm text-red-200">{handoverError}</p>}
      {handoverBusy && <p role="status" className="text-sm text-slate-300">Сохраняем данные рулона…</p>}
      {tab === 'mixes' && <MixesTab mixes={availableMixes} />}
      {tab === 'setup' && <SetupTab mixes={availableMixes} onSaved={() => setTab('journal')} />}
      {tab === 'journal' && (
        <JournalTab
          runs={runs ?? []}
          userName={userName}
          canForce={isManager}
          onSend={(r, forced) => {
            const fresh = { ...r, updatedAt: Date.now() };
            db.coatRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'coat-run', stage: StageId.COATING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
          handoverBusy={handoverBusy}
          onSendRoll={async (r) => {
            if(handoverRef.current||!currentUser)return;
            handoverRef.current=true;setHandoverBusy(true);setHandoverError('');
            try{
              const spec=await saveCoatingRollHandover(r);
              const rp: RollToTechPacket = { roll: spec };
              setOutPacket({
                v: 1, type: 'roll-spec', stage: StageId.CALENDARING,
                payload: rp, from: currentUser!.id, ts: Date.now(),
              });
            }catch(cause){setHandoverError(cause instanceof Error?cause.message:'Передача не сохранена. Повторите попытку.');}
            finally{handoverRef.current=false;setHandoverBusy(false);}
          }}
        />
      )}
      {tab === 'comments' && <CommentsSection stage={StageId.COATING} onAdd={addComment} />}

      {/* Задания этапа */}
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

// ── Вкладка: входящие данные замесов ────────────────────────────────
function MixesTab({ mixes }: { mixes: CoatingMixSnapshot[] }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Данные замесов поступают с участка замесов офлайн-пакетом (QR / текст, позже Bluetooth): вязкость,
        степень перетира, содержание СВ и плотность пасты — из них оцениваются мокрая толщина и расход. Механический зазор вводится отдельно; оценка оборотов требует калибровки насоса.
        Новые измеренные замесы появляются после явной сохранённой передачи из журнала замесов. Неизмеренные свойства остаются неизвестными.
      </p>
      {mixes.length === 0 && (
        <div className="bg-slate-800 border border-dashed border-slate-600 rounded-lg p-6 text-center text-sm text-slate-400">
          Пока нет данных замесов. Передайте журнал замеса пакетом или сделайте замес на этом устройстве.
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        {mixes.map((m) => (
          <div key={m.mixBatchId} className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-1">
            <div className="flex justify-between items-start">
              <p className="text-white text-sm font-semibold">{m.recipeName}</p>
              <span className="text-[10px] text-slate-500">{new Date(m.createdAt).toLocaleString('ru-RU')}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 text-xs text-slate-300">
              <span>Вязкость: <b className="text-white">{m.viscosity ?? '—'} сП</b></span>
              <span>Перетир: <b className="text-white">{m.fineness ?? '—'} мкм</b></span>
              <span>СВ (масс.): <b className="text-white">{m.solidsPctMass!==undefined ? `${m.solidsPctMass}%` : '—'}</b></span>
              <span>СВ (объём φ): <b className="text-white">{m.solidsPctVol ? `${m.solidsPctVol}%` : '—'}</b></span>
              <span>ρ пасты: <b className="text-white">{m.pasteDensity ? `${m.pasteDensity} г/см³` : '—'}</b></span>
              <span>Масса СВ: <b className="text-white">{m.batchKg!==undefined ? `${m.batchKg} кг` : '—'}</b></span>
            </div>
            {hasSlurryHandover(m)?<p className="text-xs text-slate-400 break-all">Партия {m.sourceBatch?.batchCode} · автор передачи {m.preparedBy} · СВ рассчитаны по навескам и заявленному составу · плотность {m.densityBasis==='measured'?'измерена':'неизвестна'}. Физическое получение и QA не подтверждены.</p>:<p className="text-xs text-amber-200">Исторический источник: происхождение свойств не подтверждено новым измеренным потоком; значения могли быть модельными.</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Вкладка: подстройка линии (расчёты + новая запись журнала) ─────
function SetupTab({ mixes, onSaved }: { mixes: CoatingMixSnapshot[]; onSaved: () => void }) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [mixId, setMixId] = useState<string>(mixes[0]?.mixBatchId ?? '');
  const [foilType, setFoilType] = useState('');
  const [targetDry, setTargetDry] = useState<number | ''>('');
  const [widthCm, setWidthCm] = useState<number | ''>('');
  const [webSpeed, setWebSpeed] = useState<number | ''>('');
  const [supplyCm3Rev, setSupplyCm3Rev] = useState<number | ''>(''); // verified pump calibration only
  const [gapSetpoint, setGapSetpoint] = useState<number | ''>('');
  const [measuredDry,setMeasuredDry]=useState<number|''>('');
  const [mode, setMode] = useState<'continuous' | 'intermittent'>('continuous');
  const [gapWidth, setGapWidth] = useState<number | ''>('');
  const [gapPitch, setGapPitch] = useState<number | ''>('');
  const [segs, setSegs] = useState<number[]>([0]);
  const [sideB, setSideB] = useState<number | ''>('');
  const [ovens, setOvens] = useState<(number|'')[]>(new Array(6).fill(''));
  const [defects, setDefects] = useState('');
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving,setSaving]=useState(false);
  const savingRef=useRef(false);
  const [runId]=useState(uuidv4);
  const [error,setError]=useState('');

  const mix = mixes.find((m) => m.mixBatchId === mixId);

  // ── Расчёты из данных замеса ──
  const calc = useMemo(() => {
    const wet = mix?.pasteDensity && mix?.solidsPctMass && targetDry
      ? wetThicknessUm(Number(targetDry), Number(mix.pasteDensity), Number(mix.solidsPctMass))
      : null;
    const flow = widthCm && wet && webSpeed
      ? requiredScrewFlowLpm(Number(widthCm), wet, Number(webSpeed))
      : null;
    const rpm = flow ? screwRpmFromFlow(flow, supplyCm3Rev===''?undefined:Number(supplyCm3Rev)) : null;
    // A physical machine gap cannot be inferred from wet film thickness.
    const gap = gapSetpoint!=='' && Number.isFinite(gapSetpoint) && gapSetpoint>0 ? gapSetpoint : null;
    const cov = mode==='intermittent'&&(gapWidth===''||gapPitch==='') ? null : intermittentCoverage(segs,
      mode==='intermittent'?numOrUndef(gapWidth):undefined,mode==='intermittent'?numOrUndef(gapPitch):undefined);
    return { wet, flow, rpm, gap, cov };
  }, [mix, targetDry, widthCm, webSpeed, supplyCm3Rev, segs, mode, gapWidth, gapPitch, gapSetpoint]);

  const save = async () => {
    if (!currentUser || savingRef.current || saved) return;
    savingRef.current=true;setSaving(true);setError('');
    try {
      await saveCoatingRun({
        foilType,mixSnapshot:mix,targetDryMgm2:numOrUndef(targetDry),
        coatingWidthCm:numOrUndef(widthCm),webSpeedMpm:numOrUndef(webSpeed),
        pumpDeliveryCm3Rev:numOrUndef(supplyCm3Rev),headGapUm:numOrUndef(gapSetpoint),measuredDryThicknessUm:numOrUndef(measuredDry),mode,
        gapWidthMm:numOrUndef(gapWidth),gapPitchMm:numOrUndef(gapPitch),segLengthsM:segs,
        sideBLengthM:numOrUndef(sideB),ovenTempsC:ovens.every(t=>t==='')?[]:ovens.map(t=>t===''?NaN:t),
        defects,notes,
      },currentUser.id,runId);
      setSaved(true);onSaved();
    }catch(cause){setError(cause instanceof Error?cause.message:'Не удалось сохранить запись. Данные формы сохранены для повторной попытки.');}
    finally{savingRef.current=false;setSaving(false);}
  };

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {/* Левая колонка: параметры */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        <h3 className="text-white font-semibold text-sm">Исходные данные</h3>

        <div>
          <label className={labelCls}>Замес (данные с участка замесов)</label>
          <select aria-label="Замес для нанесения" className={inputCls} value={mixId} onChange={(e) => setMixId(e.target.value)}>
            <option value="">— без замеса —</option>
            {mixes.map((m) => (
              <option key={m.mixBatchId} value={m.mixBatchId}>
                {m.recipeName} · η={m.viscosity ?? '—'} сП · φ={m.solidsPctVol ?? '—'}%
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Фольга</label>
            <input aria-label="Фольга" className={inputCls} value={foilType} onChange={(e) => setFoilType(e.target.value)} placeholder="Al 12 мкм" />
          </div>
          <div>
            <label className={labelCls}>Целевая сухая пов. плотность, мг/см²</label>
            <input type="number" aria-label="Сухая поверхностная плотность, мг/см²" className={inputCls} value={targetDry} onChange={(e) => setTargetDry(numOrNull(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Ширина полосы, см</label>
            <input type="number" aria-label="Ширина полосы, см" className={inputCls} value={widthCm} onChange={(e) => setWidthCm(numOrNull(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Скорость фольги, м/мин</label>
            <input type="number" step="0.1" aria-label="Скорость фольги, м/мин" className={inputCls} value={webSpeed} onChange={(e) => setWebSpeed(numOrNull(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Калиброванная подача насоса, см³/об</label>
            <input type="number" min="0" step="any" aria-label="Калиброванная подача, см³/об" className={inputCls} value={supplyCm3Rev} onChange={(e) => setSupplyCm3Rev(numOrNull(e.target.value))} />
          </div>
          <div>
            <label className={labelCls}>Заданный зазор головки, мкм (по техкарте/настройке)</label>
            <input type="number" min="0" step="any" aria-label="Заданный зазор, мкм" className={inputCls} value={gapSetpoint}
              onChange={event=>setGapSetpoint(numOrNull(event.target.value))} />
          </div>
        </div>

        <div>
          <label className={labelCls}>Измеренная полная толщина сухого электрода, мкм (необязательно)</label>
          <input aria-label="Измеренная толщина сухого электрода, мкм" type="number" min="0" step="any"
            className={inputCls} value={measuredDry} onChange={event=>setMeasuredDry(numOrNull(event.target.value))}/>
          <p className="text-xs text-slate-400 mt-1">Замер после сушки: вся толщина электрода вместе с фольгой и покрытиями обеих сторон. Расчётная мокрая толщина не заменяет замер. При передаче сохраняются исполнитель и время записи; это не приёмка ОТК.</p>
        </div>

        <div>
          <label className={labelCls}>Режим нанесения</label>
          <div className="flex gap-2">
            <button onClick={() => setMode('continuous')} className={`px-3 py-1.5 rounded text-sm ${mode === 'continuous' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>Сплошное</button>
            <button onClick={() => setMode('intermittent')} className={`px-3 py-1.5 rounded text-sm ${mode === 'intermittent' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>С промежутками</button>
          </div>
          {mode === 'intermittent' && (
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div>
                <label className={labelCls}>Размер промежутка, мм</label>
                <input type="number" className={inputCls} value={gapWidth} onChange={(e) => setGapWidth(numOrNull(e.target.value))} />
              </div>
              <div>
                <label className={labelCls}>Расстояние между промежутками (шаг), мм</label>
                <input type="number" className={inputCls} value={gapPitch} onChange={(e) => setGapPitch(numOrNull(e.target.value))} />
              </div>
            </div>
          )}
        </div>

        <div>
          <label className={labelCls}>Участки нанесения, м</label>
          <div className="space-y-2">
            {segs.map((s, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-xs text-slate-500 w-6 pt-2">#{i + 1}</span>
                <input type="number" aria-label={`Длина участка ${i+1}, м`} className={inputCls} value={s || ''} onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setSegs(segs.map((x, j) => (j === i ? v : x)));
                }} />
                {segs.length > 1 && (
                  <button onClick={() => setSegs(segs.filter((_, j) => j !== i))} className="px-2 text-red-400 hover:text-red-300">✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setSegs([...segs, 0])} className="text-xs text-blue-400 hover:text-blue-300">+ добавить участок</button>
          </div>
        </div>

        <div>
          <label className={labelCls}>Температуры печей (6 зон), °C</label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {ovens.map((t, i) => (
              <div key={i}>
                <span className="text-[10px] text-slate-500">Печь {i + 1}</span>
                <input type="number" aria-label={`Температура печи ${i+1}, °C`} className={inputCls} value={t === '' ? '' : t} placeholder="не указана"
                  onChange={(e) => setOvens(ovens.map((x, j) => (j === i ? numOrNull(e.target.value) : x)))} />
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Длина стороны B, м (2-я намазка)</label>
            <input type="number" aria-label="Длина стороны B, м" className={inputCls} value={sideB} onChange={(e) => setSideB(numOrNull(e.target.value))} />
          </div>
        </div>

        <div>
          <label className={labelCls}>Дефекты / замечания</label>
          <input className={inputCls} value={defects} onChange={(e) => setDefects(e.target.value)} placeholder="Проколы, смещение полос…" />
        </div>
        <div>
          <label className={labelCls}>Примечания</label>
          <textarea rows={2} className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
        <p className="text-xs text-slate-400">Пустые температуры означают «не указаны». Если заполняете печи, укажите все 6 зон. Параметры не отправляются на оборудование.</p>
        <button onClick={()=>void save()} disabled={saving||saved} className="w-full min-h-11 px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm text-white font-medium">
          {saving ? 'Сохранение…' : saved ? 'Сохранено ✓' : '💾 Записать в журнал нанесения'}
        </button>
      </div>

      {/* Правая колонка: расчёты */}
      <div className="space-y-3">
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-2">
          <h3 className="text-white font-semibold text-sm">🧮 Расчёт подстройки из данных замеса</h3>
          {!mix && <p className="text-xs text-amber-400">Выберите замес с известными массовой долей СВ и плотностью пасты.</p>}
          <ResultRow label="Оценка мокрой толщины" value={calc.wet} unit="мкм" hint="h = 10·σ_сух / (ρ_пасты · массовая доля СВ)" />
          <ResultRow label="Заданный зазор головки (не расчёт)" value={calc.gap} unit="мкм" hint="Ввод из настроек оборудования" />
          <ResultRow label="Расчётный объёмный расход" value={calc.flow} unit="л/мин" hint="Q = w · h · v" />
          <ResultRow label="Обороты (при известной калибровке)" value={calc.rpm} unit="об/мин" hint="rpm = Q / подача_за_об" />
          <p className="text-[11px] text-slate-500">
            Мокрая толщина и расход — оценки по материальному балансу, а не измеренные настройки.
            Реальный зазор головки требует калибровки оборудования. Обороты насоса не рассчитываются,
            пока не введена измеренная подача за один оборот.
          </p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-2">
          <h3 className="text-white font-semibold text-sm">📏 Итоговые длины</h3>
          {mode==='intermittent' && <p className="text-xs text-slate-400">Оценка предполагает промежуток в начале каждого участка, затем повтор через указанный шаг. Для другой схемы эта оценка неприменима.</p>}
          <ResultRow label="Суммарная длина участков (сторона A)" value={calc.cov?.totalM} unit="м" />
          {mode === 'intermittent' && (
            <>
              <ResultRow label="Полезная длина покрытия (без промежутков)" value={calc.cov?.coatedM} unit="м" />
              <ResultRow label="Длина промежутков" value={calc.cov?.skipM} unit="м" />
            </>
          )}
          <ResultRow label="Сторона B" value={numOrUndef(sideB) ?? null} unit="м" />
          <ResultRow label="Сумма покрытия двух сторон (не длина рулона)" value={calc.cov ? round2(calc.cov.coatedM + (numOrUndef(sideB) ?? 0)) : null} unit="м" />
        </div>
      </div>
    </div>
  );
}

function ResultRow({ label, value, unit, hint }: { label: string; value: number | null | undefined; unit: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-slate-700/50 pb-1">
      <div>
        <p className="text-xs text-slate-400">{label}</p>
        {hint && <p className="text-[10px] text-slate-600">{hint}</p>}
      </div>
      <p className="text-sm font-semibold text-white">
        {value === null || value === undefined || Number.isNaN(value) ? '—' : value} <span className="text-xs text-slate-400">{unit}</span>
      </p>
    </div>
  );
}

// ── Вкладка: журнал нанесения ───────────────────────────────────────
function JournalTab({
  runs, userName, canForce, onSend, onSendRoll, handoverBusy,
}: {
  runs: CoatRun[];
  userName: (id: string) => string;
  canForce: boolean;
  onSend: (r: CoatRun, forced: boolean) => void;
  onSendRoll: (r: CoatRun) => void;
  handoverBusy?:boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Журнал нанесения: подстроечные параметры (шнек, лента, печи), режим, длины сторон. Отправка master&apos;у —
        офлайн (QR/текст, позже Bluetooth). ⚡ — принудительная допись мастером/начальником.
      </p>
      {runs.length === 0 && <p className="text-sm text-slate-400">Записей пока нет — создайте на вкладке «Подстройка линии».</p>}
      {runs.map((r) => {
        const open = openId === r.id;
        const totalA = (r.segLengthsM ?? []).reduce((s, x) => s + (Number(x) || 0), 0);
        return (
          <div key={r.id} className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
            <button onClick={() => setOpenId(open ? null : r.id)} className="w-full px-3 py-2 flex items-center justify-between text-left">
              <div>
                <p className="text-sm text-white font-medium">
                  {r.mixSnapshot?.recipeName ?? 'Без замеса'} · {r.foilType}
                </p>
                <p className="text-[11px] text-slate-400">
                  {new Date(r.createdAt).toLocaleString('ru-RU')} · {userName(r.workerId)} ·{' '}
                  {r.mode === 'continuous' ? 'сплошное' : 'с промежутками'} · A {r.sideALengthM ?? totalA} м{r.sideBLengthM ? ` · B ${r.sideBLengthM} м` : ''}
                </p>
              </div>
              <span className="text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-1 border-t border-slate-700/60 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <Info k="Шнек (оценка)" v={`${r.screwRpm ?? '—'} об/мин`} />
                  <Info k="Лента" v={`${r.webSpeedMpm ?? '—'} м/мин`} />
                  <Info k="Ширина полосы" v={`${r.coatingWidthCm ?? '—'} см`} />
                  <Info k="Калиброванная подача" v={`${r.pumpDeliveryCm3Rev ?? '—'} см³/об`} />
                  <Info k="Расход (оценка)" v={`${r.estimatedFlowLpm ?? '—'} л/мин`} />
                  <Info k="Сухая поверхностная плотность" v={`${r.targetDryMgm2 ?? '—'} мг/см²`} />
                  <Info k="Заданный зазор" v={`${r.headGapUm ?? '—'} мкм`} />
                  <Info k="Измеренная толщина сухого электрода с фольгой" v={`${r.measuredDryThicknessUm ?? '—'} мкм`} />
                  <Info k="Мокрая толщина (оценка)" v={`${r.wetThicknessUm ?? '—'} мкм`} />
                  {r.mode === 'intermittent' && (
                    <>
                      <Info k="Промежуток" v={`${r.gapWidthMm ?? '—'} мм`} />
                      <Info k="Шаг" v={`${r.gapPitchMm ?? '—'} мм`} />
                    </>
                  )}
                </div>
                <div>
                  <p className="text-[11px] text-slate-400 mb-1">Печи, °C: {!r.ovenTempsC?.length && 'не указаны'}</p>
                  <div className="flex gap-1 flex-wrap">
                    {(r.ovenTempsC ?? []).slice(0, 6).map((t, i) => (
                      <span key={i} className="px-2 py-0.5 bg-orange-500/15 border border-orange-500/30 rounded text-[11px] text-orange-300">
                        №{i + 1}: {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400 mb-1">Участки, м: {(r.segLengthsM ?? []).join(' + ')} (Σ {totalA} м)</p>
                </div>
                {r.defects && <p className="text-xs text-red-400">⚠ {r.defects}</p>}
                {r.notes && <p className="text-xs text-slate-400">{r.notes}</p>}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => onSend(r, false)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">
                    📤 Отправить master&apos;у (QR/текст)
                  </button>
                  {!r.measuredDryThicknessUm && <p className="text-xs text-amber-200 w-full">Замер сухого электрода не указан. Передача не содержит измеренной толщины; оценка мокрого слоя не используется.</p>}
                  <button disabled={handoverBusy} onClick={() => onSendRoll(r)} className="min-h-11 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white" title="Рулон технологу (master): название замеса, толщина до прокатки, длины участков → каландрирование">
                    🔄 Рулон технологу (намазка → каландр)
                  </button>
                  {canForce && (
                    <button onClick={() => onSend(r, true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-xs text-white">
                      ⚡ Принудительно (forced)
                    </button>
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

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-slate-900/60 rounded px-2 py-1">
      <p className="text-[10px] text-slate-500">{k}</p>
      <p className="text-xs text-white">{v}</p>
    </div>
  );
}

// helpers
function numOrNull(s: string): number | '' {
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? n : '';
}
function numOrUndef(n: number | ''): number | undefined {
  return n === '' || Number.isNaN(n) ? undefined : n;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
