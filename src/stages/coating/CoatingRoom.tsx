import {hasSlurryHandover} from '../../core/manufacturing/slurryBatch';
// Комната «Нанесение покрытия» (coating). Полностью офлайн.
// Вкладки: 📥 Данные замесов · ⚙️ Намазка (расчёты) · 📒 Журнал нанесения · 💬 Комментарии
// Данные замесов приходят пакетами LIP: (QR/текст, позже Bluetooth) — type 'coating-mix'.

import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { CoatingMixSnapshot, CoatRun, RollToTechPacket, StageId, SyncPacket } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { coatingSourceFromBatch, hasRecordedCoatingRun, saveCoatingRollHandover } from './coatingJournal';
import {CoatingSetup} from './CoatingSetup';

type Tab = 'mixes' | 'setup' | 'journal' | 'comments';

const inputCls =
  'w-full min-h-11 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

export function CoatingModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
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
    const fromLocal = (localBatches??[]).flatMap(batch=>{const source=coatingSourceFromBatch(batch);return source?[source]:[];});
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
            className={`min-h-11 px-3 py-1.5 rounded-md text-sm transition ${
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
      {currentUser&&<div hidden={tab!=='setup'}><CoatingSetup mixes={availableMixes} onSaved={()=>setTab('journal')}/></div>}
      {tab === 'journal' && (
        <JournalTab
          runs={runs ?? []}
          userName={userName}
          onSend={async (r) => {
            if(!currentUser||handoverRef.current)return;handoverRef.current=true;setHandoverBusy(true);setHandoverError('');
            try{const [saved,actor]=await Promise.all([db.coatRuns.get(r.id),db.users.get(currentUser.id)]);if(!actor?.isActive||actor.role!==currentUser.role)throw Error('Нужен активный локальный профиль отправителя');if(!saved||JSON.stringify(saved)!==JSON.stringify(r))throw Error('Запись изменилась; обновите выбор перед передачей');
              setOutPacket({v:1,type:'coat-run',stage:StageId.COATING,payload:saved,from:currentUser.id,role:currentUser.role,ts:Date.now()});
            }catch(e){setHandoverError(e instanceof Error?e.message:String(e));}finally{handoverRef.current=false;setHandoverBusy(false);}
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

// ── Вкладка: журнал нанесения ───────────────────────────────────────
function JournalTab({
  runs, userName, onSend, onSendRoll, handoverBusy,
}: {
  runs: CoatRun[];
  userName: (id: string) => string;
  onSend: (r: CoatRun) => void;
  onSendRoll: (r: CoatRun) => void;
  handoverBusy?:boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Журнал нанесения: подстроечные параметры (шнек, лента, печи), режим, длины сторон. Отправка master&apos;у —
        офлайн (QR/текст, позже Bluetooth). Принудительная запись через общий ключ запрещена.
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
                  {r.mode === 'continuous' ? 'сплошное' : r.mode === 'intermittent' ? 'с промежутками' : 'режим не подтверждён'} · A {r.sideALengthM ?? totalA} м{r.sideBLengthM !== undefined ? ` · B ${r.sideBLengthM} м` : ''}
                </p>
              </div>
              <span className="text-slate-400 text-xs">{open ? '▲' : '▼'}</span>
            </button>
            {!hasRecordedCoatingRun(r)&&<p className="px-3 pb-2 text-xs text-amber-200">Историческая запись. Происхождение измерений требует проверки; исходные данные сохранены.</p>}
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
                  <button onClick={() => onSend(r)} disabled={handoverBusy} className="min-h-11 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">
                    📤 Отправить master&apos;у (QR/текст)
                  </button>
                  {!r.measuredDryThicknessUm && <p className="text-xs text-amber-200 w-full">Замер сухого электрода не указан. Передача не содержит измеренной толщины; оценка мокрого слоя не используется.</p>}
                  <button disabled={handoverBusy} onClick={() => onSendRoll(r)} className="min-h-11 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs text-white" title="Рулон технологу (master): название замеса, толщина до прокатки, длины участков → каландрирование">
                    🔄 Рулон технологу (намазка → каландр)
                  </button>

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
