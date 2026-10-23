// Расчёт граммовок замеса. Источник задания: стандартный замес из базы,
// задание начальника/мастера/технолога (пакет task с приложенным рецептом) или ручной ввод.
// Результат можно записать в журнал замеса (MixBatchJournal) и отправить slave→master пакетом.

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { MixRecipe, MixComponent, MixModeStage, StageId, SyncPacket, UserRole, Task } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { calcGrammages, calcPasteProperties, fmtG } from './mixMath';
import { PacketOutModal } from './_ui/PacketOutModal';
import { PastePropertiesPanel } from './PastePropertiesPanel';

interface Props {
  /** рецепт, переданный из базы («Взять в расчёт») */
  presetRecipe?: MixRecipe | null;
  onPresetConsumed?: () => void;
}

interface DraftLine { componentId: string; pct: number }
interface DraftState {
  name: string;
  batchKg: number;
  lines: DraftLine[];
  mode: MixModeStage[];
  taskId?: string;
}

const emptyDraft = (): DraftState => ({ name: 'Замес (ручной расчёт)', batchKg: 100, lines: [], mode: [] });

export function GrammageCalculator({ presetRecipe, onPresetConsumed }: Props) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isWorker = currentUser?.role === UserRole.WORKER;

  const components = useLiveQuery(() => db.mixComponents.toArray(), []);
  const compMap = useMemo(() => new Map((components ?? []).map((c) => [c.id, c])), [components]);
  const tasks = useLiveQuery(
    () => db.tasks.where('stage').equals(StageId.SLURRY).toArray(),
    [],
  );

  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [actual, setActual] = useState<Record<string, string>>({}); // фактические навески, г
  const [viscosity, setViscosity] = useState('');
  const [fineness, setFineness] = useState('');
  const [notes, setNotes] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [phiMax, setPhiMax] = useState(0.62);   // φm — макс. упаковка для моделей вязкости
  const [shearRate, setShearRate] = useState(50); // γ̇, 1/с — для модели Кросса

  // рецепт из базы → в черновик
  useEffect(() => {
    if (!presetRecipe) return;
    setDraft({
      name: presetRecipe.name,
      batchKg: presetRecipe.dryMassKg,
      lines: presetRecipe.lines.map((l) => ({ ...l })),
      mode: presetRecipe.mode.map((m) => ({ ...m })),
    });
    setActual({});
    onPresetConsumed?.();
  }, [presetRecipe]); // eslint-disable-line react-hooks/exhaustive-deps

  const calc = useMemo(() => {
    if (draft.lines.length === 0) return null;
    return calcGrammages({ lines: draft.lines }, compMap, draft.batchKg);
  }, [draft, compMap]);

  // Свойства пасты: расчётное содержание СВ + вязкость по реологическим моделям
  const paste = useMemo(() => {
    if (!calc) return null;
    try {
      return calcPasteProperties(calc.rows, compMap, { phiMax, shearRate });
    } catch {
      return null;
    }
  }, [calc, compMap, phiMax, shearRate]);

  const addLine = () =>
    setDraft((d) => ({ ...d, lines: [...d.lines, { componentId: components?.[0]?.id ?? '', pct: 1 }] }));
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const delLine = (i: number) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));

  const importFromTask = async (taskId: string) => {
    // подхват рецепта из описания задания, если там есть пакет mix-recipe
    const t = await db.tasks.get(taskId);
    if (!t) return;
    setDraft((d) => ({ ...d, taskId, name: d.taskId === taskId ? d.name : t.title || d.name }));
  };

  const saveToJournal = async () => {
    if (!calc || !currentUser) return;
    const now = Date.now();
    const batch = {
      id: uuidv4(),
      recipeName: draft.name || 'Замес без названия',
      batchKg: draft.batchKg,
      taskId: draft.taskId,
      weighings: calc.rows.map((r) => ({
        componentId: r.componentId,
        plannedG: Math.round(r.grams * 10) / 10,
        actualG: Number((actual[r.componentId] ?? '').replace(',', '.')) || 0,
      })),
      modeActual: draft.mode.length ? draft.mode : undefined,
      viscosity: viscosity.trim() ? Number(viscosity.replace(',', '.')) : undefined,
      fineness: fineness.trim() ? Number(fineness.replace(',', '.')) : undefined,
      pasteCalc: paste ? {
        solidsPctMass: Math.round(paste.solidsPctMass * 10) / 10,
        solidsPctVol: Math.round(paste.solidsPctVol * 10) / 10,
        pasteDensity: Math.round(paste.pasteDensity * 100) / 100,
        etaModel: 'maronpearson',
        etaPredictedCp: Math.round(paste.etaAbs.maronpearson),
      } : undefined,
      notes: notes.trim() || undefined,
      workerId: currentUser.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.mixBatches.add(batch);
    // запись и в общий журнал комнаты — для KPI-цепочки
    await db.journal.add({
      id: uuidv4(), stage: StageId.SLURRY, workerId: currentUser.id, createdAt: new Date(),
      taskId: draft.taskId,
      summary: `Замес «${batch.recipeName}», СВ ${draft.batchKg} кг`,
      params: {
        'СВ, кг': draft.batchKg,
        'Масса замеса, кг': Math.round((calc.allTotalG / 1000) * 10) / 10,
        ...(viscosity.trim() ? { 'Вязкость': Number(viscosity.replace(',', '.')) } : {}),
        ...(fineness.trim() ? { 'Перетир, мкм': Number(fineness.replace(',', '.')) } : {}),
      },
      defects: notes.trim(),
    });
    setSavedMsg('Записано в журнал замеса ✓');
    setTimeout(() => setSavedMsg(''), 2500);
    // тут же подготовить пакет для отправки master'у (slave → master)
    setOutPacket({ v: 1, type: 'mix-batch', stage: StageId.SLURRY, payload: batch, from: currentUser.id, ts: now });
  };

  const inputCls = 'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-white font-semibold">⚖️ Расчёт граммовок замеса</h3>
        {(tasks?.length ?? 0) > 0 && (
          <select
            className={`text-sm ${inputCls}`}
            value={draft.taskId ?? ''}
            onChange={(e) => e.target.value && importFromTask(e.target.value)}
          >
            <option value="">— взять из задания комнаты —</option>
            {tasks!.map((t: Task) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Источник: стандартный замес из базы (кнопка «Взять в расчёт»), задание мастера/технолога/начальника
        или ручная настройка. Растворитель указывается % от массы сухих веществ (СВ).
      </p>

      {/* Параметры замеса */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs text-slate-400 space-y-1 sm:col-span-2">
          <span>Название / номер партии</span>
          <input className={`w-full ${inputCls}`} value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          <span>Масса замеса (СВ), кг</span>
          <input type="number" min={0.1} step={anyStep} className={`w-full ${inputCls}`} value={draft.batchKg}
            onChange={(e) => setDraft({ ...draft, batchKg: Number(e.target.value) || 0.1 })} />
        </label>
      </div>

      {/* Компоненты + граммовки + факт. навески */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-200">Компоненты и граммовки</p>
          <button onClick={addLine} disabled={!components?.length}
            className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white">+ компонент</button>
        </div>

        {draft.lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700 text-xs">
                  <th className="py-1 pr-2">Компонент</th>
                  <th className="py-1 pr-2">%</th>
                  <th className="py-1 pr-2">Расчёт</th>
                  <th className="py-1 pr-2">Факт, г</th>
                  <th className="py-1 pr-2">Δ</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l, i) => {
                  const row = calc?.rows[i];
                  const c = compMap.get(l.componentId);
                  const fact = Number((actual[l.componentId] ?? '').replace(',', '.'));
                  const delta = row && Number.isFinite(fact) && fact !== 0 ? fact - row.grams : undefined;
                  return (
                    <tr key={i} className="border-b border-slate-800 text-slate-200">
                      <td className="py-1 pr-2">
                        <select className={`min-w-[9rem] max-w-[14rem] ${inputCls}`} value={l.componentId}
                          onChange={(e) => setLine(i, { componentId: e.target.value })}>
                          {(components ?? []).map((cc) => (
                            <option key={cc.id} value={cc.id}>{cc.name}{cc.kind === 'solvent' ? ' (р-тель)' : ''}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-1">
                          <input type="number" step="any" min={0} className={`w-16 ${inputCls}`} value={l.pct}
                            onChange={(e) => setLine(i, { pct: Number(e.target.value) || 0 })} />
                          <span className="text-[10px] text-slate-500">{c?.kind === 'solvent' ? 'от СВ' : 'сух.'}</span>
                        </div>
                      </td>
                      <td className="py-1 pr-2 font-mono text-blue-300 whitespace-nowrap">{row ? fmtG(row.grams) : '—'}</td>
                      <td className="py-1 pr-2">
                        <input type="number" step="any" className={`w-24 ${inputCls}`} placeholder="навеска"
                          value={actual[l.componentId] ?? ''}
                          onChange={(e) => setActual({ ...actual, [l.componentId]: e.target.value })} />
                      </td>
                      <td className={`py-1 pr-2 text-xs font-mono ${delta !== undefined && Math.abs(delta) > row!.grams * 0.01 ? 'text-red-400' : 'text-slate-400'}`}>
                        {delta !== undefined ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} г` : '—'}
                      </td>
                      <td className="py-1">
                        <button onClick={() => delLine(i)} className="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/60 rounded">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {calc && (
          <div className="text-xs text-slate-300 flex flex-wrap gap-x-6 gap-y-1 bg-slate-900/50 rounded p-2">
            <span>СВ: <b className="font-mono text-white">{fmtG(calc.dryTotalG)}</b></span>
            <span>Растворитель: <b className="font-mono text-white">{fmtG(calc.wetTotalG)}</b></span>
            <span>Всего замес: <b className="font-mono text-white">{fmtG(calc.allTotalG)}</b></span>
            <span>Доля СВ: <b className="font-mono text-white">{calc.solidsPct.toFixed(1)}%</b></span>
          </div>
        )}

        {/* Расчётные свойства пасты: СВ + модели вязкости */}
        <PastePropertiesPanel
          paste={paste}
          phiMax={phiMax}
          shearRate={shearRate}
          onPhiMaxChange={setPhiMax}
          onShearRateChange={setShearRate}
        />
      </div>

      {/* Режим замеса (из рецепта / вручную) */}
      {draft.mode.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-semibold text-slate-200">Режим замеса</p>
          {draft.mode.map((s, i) => (
            <div key={s.id} className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded px-2 py-1">
              {i + 1}. <b>{s.name}</b>: {s.disperserRpm ? `дисп. ${s.disperserRpm}` : 'дисп. —'} / {s.paddleRpm ? `лоп. ${s.paddleRpm}` : 'лоп. —'} об/мин
              {s.vacuumOn ? ` · вакуум ${s.vacuumKpa ?? '?'} кПа` : ' · без вакуума'} · {s.tempC ?? '—'}°C · {s.minutes} мин
            </div>
          ))}
        </div>
      )}

      {/* Результаты контроля */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <label className="text-xs text-slate-400 space-y-1">
          <span>Вязкость (сП / мПа·с)</span>
          <input type="number" step="any" className={`w-full ${inputCls}`} value={viscosity}
            onChange={(e) => setViscosity(e.target.value)} placeholder="напр. 3100" />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          <span>Степень перетира, мкм</span>
          <input type="number" step="any" className={`w-full ${inputCls}`} value={fineness}
            onChange={(e) => setFineness(e.target.value)} placeholder="напр. 15" />
        </label>
        <label className="text-xs text-slate-400 space-y-1 col-span-2 sm:col-span-1">
          <span>Примечания / дефекты</span>
          <input className={`w-full ${inputCls}`} value={notes}
            onChange={(e) => setNotes(e.target.value)} placeholder="если есть замечания" />
        </label>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={saveToJournal}
          disabled={!calc || draft.lines.length === 0}
          className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm text-white font-medium"
        >
          💾 Записать в журнал замеса
        </button>
        {savedMsg && <span className="text-sm text-green-400">{savedMsg}</span>}
        {isWorker && <span className="text-xs text-slate-500">После записи появится QR для отправки мастеру.</span>}
      </div>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

const anyStep = 'any';
