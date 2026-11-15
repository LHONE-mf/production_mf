// KPI-дашборд производства.
// Источник данных — ТОЛЬКО локальная база Dexie (журналы комнат). Полный офлайн.
// Independent declared stage totals; no inferred chain yield, QA or stock.
// Таблицы и поля соответствуют реальной схеме src/core/db/index.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { db } from '../core/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { recordedTotal, displayRecordedTotal as show, recordedTotalNote } from '../core/manufacturing/recordedTotals';
import { listVisibleTasks } from '../core/sync/visibleTasks';
import { useAuthStore } from '../core/store/authStore';
import { TaskStatus } from '../core/types';
// ─── Утилиты ──────────────────────────────────────────────────────────────

/** createdAt в этих таблицах бывает number (мс) или string (ISO) — приводим к мс */
const toMs = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') { const p = Date.parse(v); return p; }
  if (v instanceof Date) return v.getTime();
  return NaN;
};

const avg = (xs: number[]): number | null => {
  const total = recordedTotal(xs);
  return total.value === null ? null : total.value / total.observed;
};

const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';

// ─── Карточки метрик ──────────────────────────────────────────────────────

interface CardProps { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' | 'info' }

const KpiCard: React.FC<CardProps> = ({ label, value, sub, tone = 'info' }) => {
  const tones: Record<string, string> = {
    good: 'border-emerald-700 bg-emerald-900/30',
    bad: 'border-rose-700 bg-rose-900/30',
    warn: 'border-amber-700 bg-amber-900/30',
    info: 'border-slate-700 bg-slate-800/60',
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
};

// ─── Основной компонент ───────────────────────────────────────────────────

export const KpiDashboard: React.FC = () => {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [days, setDays] = useState<number>(7); // окно: 7 / 30 / всё
  const [now, setNow] = useState(Date.now);
  const data = useLiveQuery(async () => {
    const [mixes, coats, calenders, cuts, sorts, assemblies, fills, walz, formations, tasks, users, lease] = await Promise.all([
      db.mixBatches.toArray(), db.coatRuns.toArray(), db.calenderRuns.toArray(),
      db.cuttingRuns.toArray(), db.sortRuns.toArray(), db.assemblyRuns.toArray(),
      db.fillRuns.toArray(), db.walzRuns.toArray(), db.formationRuns.toArray(),
      listVisibleTasks(), db.users.toArray(), db.hybridTaskEditLeases.get('active'),
    ]);
    return { mixes, coats, calenders, cuts, sorts, assemblies, fills, walz, formations, tasks,
      usersMap: Object.fromEntries(users.map(u => [u.id, u.fullName || u.login])), lease, readAt: Date.now() };
  }, [currentUser?.id, currentUser?.role, now]);
  // Re-evaluate rolling dates and task visibility on focus and at lease expiry.
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const expiresAt = data?.lease?.expiresAt;
    const delay = expiresAt && expiresAt > now ? Math.min(60_000, expiresAt - now) : 60_000;
    const timer = window.setTimeout(refresh, delay);
    window.addEventListener('focus', refresh);
    return () => { clearTimeout(timer); window.removeEventListener('focus', refresh); };
  }, [now, data?.lease?.expiresAt]);
  const { mixes = [], coats = [], calenders = [], cuts = [], sorts = [], assemblies = [],
    fills = [], walz = [], formations = [], tasks = [], usersMap = {} } = data ?? {};

  const asOf = Math.max(now, data?.readAt ?? 0);
  const sinceMs = useMemo(
    () => (days > 0 ? asOf - days * 24 * 3600 * 1000 : 0),
    [days, asOf],
  );
  const inWindow = <T extends object>(arr: T[], pick: (x: T) => unknown) =>
    arr.filter((x) => { const date = toMs(pick(x)); return Number.isFinite(date) && date > 0 && date >= sinceMs && date <= asOf; });

  // ── Расчётные KPI ──
  const kpi = useMemo(() => {
    const wMix = inWindow(mixes, (x) => x.createdAt);
    const wCoat = inWindow(coats, (x) => x.createdAt);
    const wCal = inWindow(calenders, (x) => x.createdAt);
    const wCut = inWindow(cuts, (x) => x.createdAt);
    const wSort = inWindow(sorts, (x) => x.createdAt);
    const recordedAssembly = inWindow(assemblies, x => x.cellOutput?.recordedAt ?? x.createdAt);
    const unknownAssembly = recordedAssembly.filter(x => !x.cellOutput && (x.intake || x.operationLedger)).length;
    const wAsm = recordedAssembly;
    const assemblyCount = (x: typeof assemblies[number]) => x.cellOutput?.count ?? (x.intake || x.operationLedger ? undefined : x.cellsOut);
    const wFill = inWindow(fills, (x) => x.createdAt);
    const wWalz = inWindow(walz, (x) => x.createdAt);
    const wForm = inWindow(formations, (x) => x.createdAt);

    const sum = <T,>(arr: T[], f: (x: T) => unknown, whole = true) => recordedTotal(arr.map(f), whole);
    const coatMeters = recordedTotal(wCoat.flatMap(x => [x.sideALengthM, x.sideBLengthM]));
    const cutGood = sum(wCut, x => x.goodCount);
    const cutDefect = sum(wCut, x => x.defectCount);
    const sortGood = sum(wSort, x => x.goodCount);
    const sortRejected = sum(wSort, x => x.rejected);
    const asmOut = sum(wAsm, assemblyCount);
    // Station scrap units cannot be converted to cell scrap by this dashboard.
    const asmScrap = sum(wAsm, x => x.cellOutput || x.intake || x.operationLedger ? undefined : x.cellsScrap);
    const fillOut = sum(wFill, x => x.cellsFilled);
    const fillScrap = sum(wFill, x => x.cellsScrap);
    const fillUnknown = sum(wFill, x => x.cellsUnknown);
    const walzOut = sum(wWalz, x => x.cellsOut);
    const walzScrap = sum(wWalz, x => x.cellsScrap);
    const walzUnknown = sum(wWalz, x => x.cellsUnknown);
    const formOut = sum(wForm, x => x.cellsOut);
    const formScrap = sum(wForm, x => x.cellsScrap);
    const formUnknown = sum(wForm, x => x.cellsUnknown);
    const undated = [mixes, coats, calenders, cuts, sorts, assemblies, fills, walz, formations].flat()
      .filter(x => { const date = toMs('cellOutput' in x && x.cellOutput ? x.cellOutput.recordedAt : x.createdAt); return !Number.isFinite(date) || date <= 0 || date > asOf; }).length;

    const coulombVals = wForm.map((x) => x.coulombEfficiencyPct).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER);
    const cap5Vals = wForm.map((x) => x.capacityCycle5Ah).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER);

    // Открытые задания (не завершены и не отклонены)
    const closedStatuses: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.REJECTED];
    const openTasks = tasks.filter((t) => !closedStatuses.includes(t.status));
    const overdueTasks = openTasks.filter(
      (t) => t.dueDate != null && Number.isFinite(toMs(t.dueDate)) && toMs(t.dueDate) < asOf,
    );

    // Конвейер: сколько записей на каждой станции за период
    const pipeline = [
      { stage: '🧪 Замесы', count: wMix.length },
      { stage: '🖌️ Намазка', count: wCoat.length },
      { stage: '🔄 Каландр', count: wCal.length },
      { stage: '✂️ Нарезка', count: wCut.length },
      { stage: '🗂️ Сортировка', count: wSort.length },
      { stage: '🔋 Сборка', count: wAsm.length },
      { stage: '💧 Заливка', count: wFill.length },
      { stage: '🎡 Вальцовка', count: wWalz.length },
      { stage: '⚡ Формировка', count: wForm.length },
    ];
    const maxPipeline = Math.max(1, ...pipeline.map((p) => p.count));

    // Работники: электроды (нарезка), ячейки (сборка), замесы
    const byWorker: Record<string, { electrodes: unknown[]; cells: unknown[]; batches: number }> = {};
    const ensure = (id: string) => byWorker[id] ??= { electrodes: [], cells: [], batches: 0 };
    wCut.forEach(x => ensure(x.workerId).electrodes.push(x.goodCount));
    wAsm.forEach(x => ensure(x.cellOutput?.recordedBy ?? x.workerId).cells.push(assemblyCount(x)));
    wMix.forEach(x => ensure(x.workerId).batches++);
    const workerRows = Object.entries(byWorker)
      .map(([id, v]) => ({ id, name: usersMap[id] ?? id.slice(0, 8),
        electrodes: show(recordedTotal(v.electrodes, true)), cells: show(recordedTotal(v.cells, true)), batches: v.batches }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);

    return {
      wMix, wForm,
      mixKg: sum(wMix, (x) => x.batchKg, false),
      coatMeters,
      cutGood, cutDefect,
      sortGood, sortRejected,
      asmOut, asmScrap, unknownAssembly, fillOut, fillScrap, fillUnknown, undated,
      walzOut, walzScrap, walzUnknown, formOut, formScrap, formUnknown,
      avgCoulomb: avg(coulombVals), coulombCount: coulombVals.length,
      avgCap5: avg(cap5Vals), cap5Count: cap5Vals.length,
      openTasks: openTasks.length,
      overdueTasks: overdueTasks.length,
      pipeline, maxPipeline, workerRows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, asOf, mixes, coats, calenders, cuts, sorts, assemblies, fills, walz, formations, tasks, usersMap]);

  if (!data) {
    return <div className="p-6 text-slate-300">Загрузка KPI из локальной базы…</div>;
  }

  const roleTitle: Record<string, string> = {
    worker: 'Работник', master: 'Мастер цеха', technologist: 'Технолог', chief: 'Начальник производства',
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <p className="text-xs text-slate-400">—: нет записанного значения; + ?: частичный итог с неизвестными значениями. Исторические поля остаются заявленными, без подтверждения QA, склада или совпадения партий.</p>
      {kpi.undated > 0 && <p className="text-sm text-amber-200">Записей с неверной датой или датой в будущем: {kpi.undated}; они исключены из итогов.</p>}
      {kpi.unknownAssembly>0&&<p className="text-sm text-amber-200">Приёмки и станционные наблюдения ({kpi.unknownAssembly}) не включены в выход ячеек: выпуск не определён.</p>}
      {/* Шапка дашборда */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">📊 KPI производства</h2>
          <p className="text-sm text-slate-400">
            Заявленные локальные итоги по дате записи (сборка — по дате объявления выпуска), не QA-допуск или склад · роль: {roleTitle[currentUser?.role ?? ''] ?? '—'}
          </p>
        </div>
        <div className="flex gap-2">
          {[
            { d: 7, l: '7 дней' },
            { d: 30, l: '30 дней' },
            { d: 0, l: 'Всё время' },
          ].map((o) => (
            <button
              key={o.d}
              onClick={() => setDays(o.d)}
              className={`rounded-lg px-3 py-1.5 text-sm border ${
                days === o.d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

      {/* Ключевые карточки */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Собрано ячеек" value={show(kpi.asmOut)} sub={`${recordedTotalNote(kpi.asmOut)} · отклонено (заявлено): ${show(kpi.asmScrap)}`} tone="info" />
        <KpiCard label="После формировки" value={show(kpi.formOut)} sub={`${recordedTotalNote(kpi.formOut)} · отклонено: ${show(kpi.formScrap)} · не определено: ${show(kpi.formUnknown)}`} tone="info" />
        <KpiCard label="Годность цепочки" value="—" sub="Не подтверждена связь партий сборки и формировки" tone="warn" />
        <KpiCard label="Средняя КУЭ" value={kpi.avgCoulomb != null ? kpi.avgCoulomb.toFixed(1) + '%' : '—'} sub={`${kpi.coulombCount}/${kpi.wForm.length} записей со значением; заявленные измерения`} tone="info" />
        <KpiCard label="Ёмкость 5-го цикла" value={kpi.avgCap5 != null ? kpi.avgCap5.toFixed(2) + ' А·ч' : '—'} sub={`${kpi.cap5Count}/${kpi.wForm.length} записей со значением; среднее заявленное`} tone="info" />
        <KpiCard label="Цель сухой массы" value={kpi.mixKg.value === null ? '—' : show(kpi.mixKg) + ' кг'} sub={`план СВ, не фактическая масса пасты · ${recordedTotalNote(kpi.mixKg)}`} tone="info" />
        <KpiCard label="Покрытие A+B" value={kpi.coatMeters.value === null ? '—' : show(kpi.coatMeters) + ' м'} sub={`покрытие A+B, не длина рулона · ${recordedTotalNote(kpi.coatMeters)}`} tone="info" />
        <KpiCard label="Открытые задания" value={String(kpi.openTasks)} sub={`текущие доступные; просрочено: ${kpi.overdueTasks}`} tone={kpi.overdueTasks > 0 ? 'bad' : 'good'} />
      </div>

      {/* Конвейер движения партии */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Записи на этапах за период (не поток одной партии)
        </h3>
        <div className="space-y-2">
          {kpi.pipeline.map((p) => (
            <div key={p.stage} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-sm text-slate-300">{p.stage}</span>
              <div className="h-4 flex-1 rounded bg-slate-900 overflow-hidden">
                <div
                  className="h-full rounded bg-gradient-to-r from-blue-600 to-cyan-500"
                  style={{ width: `${Math.round((p.count / kpi.maxPipeline) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-sm font-mono text-white">{p.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Электроды: выход и дефекты */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Электродный участок</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-700/60">
              <tr><td className="py-1.5 text-slate-400">Заявленный выход нарезки</td><td className="py-1.5 text-right font-mono text-white">{show(kpi.cutGood)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Дефект на нарезке</td><td className="py-1.5 text-right font-mono text-rose-400">{show(kpi.cutDefect)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Заявленный вход сортировки</td><td className="py-1.5 text-right font-mono text-white">{show(kpi.sortGood)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Отбраковано при сортировке</td><td className="py-1.5 text-right font-mono text-rose-400">{show(kpi.sortRejected)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Ячейки: заливка → вальцовка → формировка</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-700/60">
              <tr><td className="py-1.5 text-slate-400">Залито ячеек</td><td className="py-1.5 text-right font-mono text-white">{show(kpi.fillOut)}</td><td className="py-1.5 text-right text-xs text-rose-400">отклонено: {show(kpi.fillScrap)}; не определено: {show(kpi.fillUnknown)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">После вальцовки</td><td className="py-1.5 text-right font-mono text-white">{show(kpi.walzOut)}</td><td className="py-1.5 text-right text-xs text-rose-400">отклонено: {show(kpi.walzScrap)}; не определено: {show(kpi.walzUnknown)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">После формировки</td><td className="py-1.5 text-right font-mono text-white">{show(kpi.formOut)}</td><td className="py-1.5 text-right text-xs text-rose-400">отклонено: {show(kpi.formScrap)}; не определено: {show(kpi.formUnknown)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Работники */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Работники за период (первые 8 по имени; единицы раздельно)
        </h3>
        {kpi.workerRows.length === 0 ? (
          <p className="text-sm text-slate-500">Нет записей в журналах за выбранный период.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="pr-4 pb-2">Работник</th>
                  <th className="pr-4 pb-2 text-right">Электроды</th>
                  <th className="pr-4 pb-2 text-right">Ячейки</th>
                  <th className="pb-2 text-right">Замесы</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {kpi.workerRows.map((w) => (
                  <tr key={w.id}>
                    <td className="py-1.5 pr-4 text-slate-200">{w.name}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-white">{w.electrodes}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-white">{w.cells}</td>
                    <td className="py-1.5 text-right font-mono text-white">{w.batches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Последние партии формировки */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Последние партии формировки (КУЭ / ёмкость 5-го цикла)
        </h3>
        {kpi.wForm.length === 0 ? (
          <p className="text-sm text-slate-500">Нет записей за выбранный период.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="pr-4 pb-2">Дата</th>
                  <th className="pr-4 pb-2">Партия</th>
                  <th className="pr-4 pb-2">Номера АК</th>
                  <th className="pr-4 pb-2 text-right">Обработано (заявлено)</th>
                  <th className="pr-4 pb-2 text-right">КУЭ, %</th>
                  <th className="pb-2 text-right">C₅, А·ч</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {[...kpi.wForm]
                  .sort((a, b) => toMs(b.startDate || b.createdAt) - toMs(a.startDate || a.createdAt))
                  .slice(0, 10)
                  .map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-4 text-slate-400">{fmtDate(toMs(r.startDate) || toMs(r.createdAt))}</td>
                      <td className="py-1.5 pr-4 text-slate-200">{r.batchName}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs text-slate-400">
                        {r.serialRange ? `${r.serialRange.start}–${r.serialRange.end}` : '—'}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-white">{show(recordedTotal([r.cellsOut], true))}</td>
                      <td className="py-1.5 pr-4 text-right font-mono text-emerald-400">
                        {show(recordedTotal([r.coulombEfficiencyPct]), 1)}
                      </td>
                      <td className="py-1.5 text-right font-mono text-emerald-400">
                        {show(recordedTotal([r.capacityCycle5Ah]), 2)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default KpiDashboard;
